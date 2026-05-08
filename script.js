/**
 * AuditIQ — script.js
 * Análise inteligente de planilhas de estoque / inventário
 *
 * REGRAS DE NEGÓCIO:
 * - DUPLICADO: mesma Microsiga + mesmo Endereço + mesma Quantidade (todos os 3 juntos)
 * - CAMPO VAZIO: exibe a linha COMPLETA da planilha com o campo ausente destacado em vermelho
 * - ENDEREÇO INVÁLIDO: tudo que NÃO começa com uma letra (A-Z / a-z)
 * - ITENS SEM CAMPO: mostra a linha inteira faltando a coluna específica
 */

/* ══════════════════════════════════════════════════
   CONFIG
══════════════════════════════════════════════════ */
const CSV_URL = 'https://docs.google.com/spreadsheets/d/e/2PACX-1vRyUZ_F6JuvQcVaIAPQCtQH-4CTi6zn-MIXVktxX6fxdh_eUr5aAZOftF--294824T6MrBIs-1ZCxdv/pub?gid=0&single=true&output=csv';

const SUSPICIOUS_QTY_THRESHOLD = 9999;
const AUTO_REFRESH_INTERVAL_MS = 5 * 60 * 1000; // 5 min

/* ══════════════════════════════════════════════════
   STATE
══════════════════════════════════════════════════ */
const state = {
  rawData:      [],
  headers:      [],
  cols:         {},
  issues:       [],
  filtered:     [],
  activeFilter: 'all',
  searchTerm:   '',
  currentPage:  1,
  pageSize:     20,
  sortCol:      null,
  sortDir:      'asc',
  charts:       {},
  theme:        'light',
};

/* ══════════════════════════════════════════════════
   UTILITIES
══════════════════════════════════════════════════ */
const normalize = (s) => String(s ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
const isEmpty   = (v) => v === null || v === undefined || String(v).trim() === '';
const isNumeric = (v) => !isEmpty(v) && !isNaN(parseFloat(String(v).replace(',', '.')));
const toNum     = (v) => parseFloat(String(v).replace(',', '.'));
const escHtml   = (s) => String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
const truncate  = (s, n=60) => s.length > n ? s.slice(0, n) + '…' : s;

function formatDateTime(d) {
  return d.toLocaleString('pt-BR', {
    day:'2-digit', month:'2-digit', year:'numeric',
    hour:'2-digit', minute:'2-digit'
  });
}

/* ══════════════════════════════════════════════════
   COLUMN DETECTION
   Detecta o nome real de cada coluna no CSV,
   independente de maiúsculas / minúsculas.
══════════════════════════════════════════════════ */
function detectColumns(headers) {
  const h = headers.map(x => normalize(x));
  const find = (...keywords) =>
    headers.find((_, i) => keywords.some(k => h[i].includes(normalize(k)))) || null;

  return {
    code:    find('microsiga', 'codigo', 'cód', 'cod.', 'code', 'item', 'referencia', 'ref'),
    desc:    find('descricao', 'descrição', 'desc', 'nome', 'produto', 'material', 'name'),
    qty:     find('quantidade', 'qtd', 'qty', 'saldo', 'estoque', 'quant', 'qtde'),
    address: find('endereco', 'endereço', 'localizacao', 'localização', 'local', 'address',
                  'posicao', 'posição', 'rua', 'box', 'predio', 'prédio', 'corredor', 'nivel'),
    date:    find('data', 'date', 'vencimento', 'fabricacao', 'fabricação'),
    order:   find('pedido', 'order', 'requisicao', 'requisição', 'solicitacao', 'op ', 'ordem'),
    unit:    find('unidade', 'un ', 'um ', 'unit', 'und'),
    cost:    find('custo', 'preco', 'preço', 'valor', 'cost', 'price'),
  };
}

/* ══════════════════════════════════════════════════
   ANALYSIS ENGINE
══════════════════════════════════════════════════ */
function analyzeData(rows, headers) {
  const cols   = detectColumns(headers);
  const issues = [];
  let   id     = 1;

  /**
   * Registra uma inconsistência.
   * @param {number}      rowIdx  - índice no array rows (0-based)
   * @param {object}      row     - objeto completo da linha
   * @param {string}      type    - categoria da inconsistência
   * @param {string}      severity - 'critical' | 'warning' | 'info'
   * @param {string}      description
   * @param {string}      recommendation
   * @param {string|null} missingCol - nome da coluna com problema (para highlight)
   */
  const addIssue = (rowIdx, row, type, severity, description, recommendation, missingCol = null) => {
    issues.push({ id: id++, rowIdx: rowIdx + 2, row, missingCol, type, severity, description, recommendation });
  };

  /* ──────────────────────────────────────────────
     PRÉ-BUILD: índice para detecção de duplicatas
     Duplicata = mesma Microsiga + mesmo Endereço + mesma Quantidade (os 3 juntos)
  ────────────────────────────────────────────── */
  const tripleKey = (row) => {
    const c = cols.code    ? normalize(row[cols.code]    ?? '') : '';
    const a = cols.address ? normalize(row[cols.address] ?? '') : '';
    const q = cols.qty     ? normalize(row[cols.qty]     ?? '') : '';
    return `${c}||${a}||${q}`;
  };

  const tripleMap = {};
  rows.forEach((row, idx) => {
    const k = tripleKey(row);
    if (!tripleMap[k]) tripleMap[k] = [];
    tripleMap[k].push(idx);
  });

  /* ──────────────────────────────────────────────
     ANÁLISE LINHA A LINHA
  ────────────────────────────────────────────── */
  const dupReported = new Set();

  rows.forEach((row, idx) => {

    /* 1. LINHA COMPLETAMENTE VAZIA */
    const allVals = headers.map(h => String(row[h] ?? '').trim());
    if (allVals.every(v => v === '')) {
      addIssue(idx, row, 'empty', 'info',
        'Linha completamente vazia',
        'Remover a linha vazia do arquivo.');
      return;
    }

    /* 2. CAMPOS OBRIGATÓRIOS VAZIOS
       Cada campo faltando gera uma entrada separada,
       exibindo a linha inteira com aquela coluna destacada. */
    const requiredCols = [
      { key: cols.code,    label: 'Microsiga/Código', sev: 'critical' },
      { key: cols.desc,    label: 'Descrição',         sev: 'warning'  },
      { key: cols.qty,     label: 'Quantidade',        sev: 'warning'  },
      { key: cols.address, label: 'Endereço',          sev: 'warning'  },
    ];

    requiredCols.forEach(({ key, label, sev }) => {
      if (key && isEmpty(row[key])) {
        addIssue(idx, row, 'empty', sev,
          `Campo "${label}" está vazio`,
          `Preencher o campo "${label}" para este item.`,
          key   // ← coluna que será destacada na tabela
        );
      }
    });

    /* 3. DUPLICATAS: Microsiga + Endereço + Quantidade (TODOS os 3 devem coincidir) */
    if (!dupReported.has(idx)) {
      const codeVal    = cols.code    ? String(row[cols.code]    ?? '').trim() : '';
      const addressVal = cols.address ? String(row[cols.address] ?? '').trim() : '';
      const qtyVal     = cols.qty     ? String(row[cols.qty]     ?? '').trim() : '';
      const allFilled  = codeVal !== '' && addressVal !== '' && qtyVal !== '';

      if (allFilled) {
        const k     = tripleKey(row);
        const group = tripleMap[k];

        if (group && group.length > 1) {
          group.forEach(i => {
            if (!dupReported.has(i)) {
              dupReported.add(i);
              addIssue(i, rows[i], 'duplicate', 'critical',
                `Duplicata: Cód "${codeVal}" · End "${addressVal}" · Qtd "${qtyVal}" (${group.length}x)`,
                'Verificar e consolidar os registros duplicados.'
              );
            }
          });
        }
      }
    }

    /* 4. QUANTIDADE — verificações numéricas */
    if (cols.qty && !isEmpty(row[cols.qty])) {
      const raw = String(row[cols.qty]).trim();
      if (!isNumeric(raw)) {
        addIssue(idx, row, 'chars', 'critical',
          `Quantidade não numérica: "${raw}"`,
          'Corrigir para um valor numérico válido.',
          cols.qty);
      } else {
        const n = toNum(raw);
        if (n === 0) {
          addIssue(idx, row, 'zero', 'warning',
            `Quantidade zero`,
            'Verificar se o item deve permanecer no estoque.',
            cols.qty);
        } else if (n < 0) {
          addIssue(idx, row, 'negative', 'critical',
            `Quantidade negativa: ${n}`,
            'Auditar movimentação — indica erro de lançamento.',
            cols.qty);
        } else if (n > SUSPICIOUS_QTY_THRESHOLD) {
          addIssue(idx, row, 'suspicious', 'warning',
            `Quantidade extremamente alta: ${n}`,
            'Confirmar se a quantidade está correta.',
            cols.qty);
        }
      }
    }

    /* 5. ENDEREÇO INVÁLIDO
       Regra: deve começar com uma letra (A-Z, incluindo acentuadas).
       Qualquer endereço que comece com número, símbolo ou espaço é inválido. */
    if (cols.address && !isEmpty(row[cols.address])) {
      const addr = String(row[cols.address]).trim();
      const startsWithLetter = /^[a-zA-ZÀ-ÿ]/.test(addr);
      if (!startsWithLetter) {
        addIssue(idx, row, 'address', 'critical',
          `Endereço inválido: "${addr}" — não começa com letra`,
          'Corrigir o endereço para iniciar com uma letra (ex: A01-01).',
          cols.address);
      }
    }

    /* 6. CARACTERES DE CONTROLE no código */
    if (cols.code && !isEmpty(row[cols.code])) {
      const code = String(row[cols.code]).trim();
      if (/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/.test(code)) {
        addIssue(idx, row, 'chars', 'warning',
          `Caracteres de controle no código: "${code}"`,
          'Limpar caracteres inválidos no campo de código.',
          cols.code);
      }
    }

    /* 7. DATA INVÁLIDA */
    if (cols.date && !isEmpty(row[cols.date])) {
      const dateStr = String(row[cols.date]).trim();
      const isoLike = dateStr.replace(/(\d{2})\/(\d{2})\/(\d{4})/, '$3-$2-$1');
      if (isNaN(Date.parse(isoLike))) {
        addIssue(idx, row, 'chars', 'warning',
          `Data inválida: "${dateStr}"`,
          'Verificar e corrigir o formato da data.',
          cols.date);
      }
    }

  }); // fim forEach

  /* ──────────────────────────────────────────────
     PÓS-PROCESSO: Divergência de Descrição
     Mesmo código Microsiga com descrições diferentes
  ────────────────────────────────────────────── */
  if (cols.code && cols.desc) {
    const codeToDescs = {};
    const codeToIdxs  = {};

    rows.forEach((row, idx) => {
      const code = normalize(row[cols.code] ?? '');
      const desc = normalize(row[cols.desc] ?? '');
      if (!code) return;
      if (!codeToDescs[code]) { codeToDescs[code] = new Set(); codeToIdxs[code] = []; }
      if (desc) codeToDescs[code].add(desc);
      codeToIdxs[code].push(idx);
    });

    const descReported = new Set();
    Object.entries(codeToDescs).forEach(([nc, descSet]) => {
      if (descSet.size > 1) {
        codeToIdxs[nc].forEach(idx => {
          if (!descReported.has(idx)) {
            descReported.add(idx);
            addIssue(idx, rows[idx], 'desc', 'warning',
              `Código "${rows[idx][cols.code]}" com ${descSet.size} descrições diferentes`,
              'Padronizar a descrição do produto no cadastro master.',
              cols.desc);
          }
        });
      }
    });
  }

  return issues;
}

/* ══════════════════════════════════════════════════
   KPIs + SCORE
══════════════════════════════════════════════════ */
function computeKPIs(issues, rawTotal) {
  const counts = { duplicate:0, empty:0, address:0, zero:0, negative:0, desc:0, suspicious:0, chars:0 };
  let critical = 0;

  issues.forEach(i => {
    counts[i.type] = (counts[i.type] || 0) + 1;
    if (i.severity === 'critical') critical++;
  });

  const score = rawTotal > 0
    ? Math.min(100, Math.round((critical * 2 + (issues.length - critical)) / rawTotal * 100))
    : 0;

  return { counts, critical, total: issues.length, score };
}

/* ══════════════════════════════════════════════════
   TYPE LABELS + COLORS
══════════════════════════════════════════════════ */
const typeLabels = {
  duplicate:  'Duplicados',
  empty:      'Campos Vazios',
  address:    'End. Inválido',
  zero:       'Qtd. Zero',
  negative:   'Qtd. Negativa',
  desc:       'Descrição Div.',
  suspicious: 'Suspeitos',
  chars:      'Caracteres Inv.',
};

const TYPE_COLORS = {
  duplicate:  '#f59e0b',
  empty:      '#f97316',
  address:    '#8b5cf6',
  zero:       '#14b8a6',
  negative:   '#ef4444',
  desc:       '#ec4899',
  suspicious: '#e11d48',
  chars:      '#6366f1',
};

/* ══════════════════════════════════════════════════
   RENDER KPI CARDS
══════════════════════════════════════════════════ */
function renderKPIs(kpis, rawTotal) {
  document.getElementById('kpi-total').textContent      = rawTotal.toLocaleString('pt-BR');
  document.getElementById('kpi-issues').textContent     = kpis.total.toLocaleString('pt-BR');
  document.getElementById('kpi-duplicates').textContent = kpis.counts.duplicate.toLocaleString('pt-BR');
  document.getElementById('kpi-empty').textContent      = kpis.counts.empty.toLocaleString('pt-BR');
  document.getElementById('kpi-address').textContent    = kpis.counts.address.toLocaleString('pt-BR');
  document.getElementById('kpi-critical').textContent   = kpis.critical.toLocaleString('pt-BR');
  document.getElementById('kpi-score').textContent      = kpis.score + '%';

  const bar = document.getElementById('score-bar');
  bar.style.width      = kpis.score + '%';
  bar.style.background = kpis.score < 20 ? 'var(--green)' : kpis.score < 50 ? 'var(--yellow)' : 'var(--red)';

  const pillMap = {
    duplicate:'pc-duplicate', empty:'pc-empty', address:'pc-address',
    zero:'pc-zero', negative:'pc-negative', desc:'pc-desc',
    suspicious:'pc-suspicious', chars:'pc-chars',
  };
  Object.entries(pillMap).forEach(([t, elId]) => {
    document.getElementById(elId).textContent = (kpis.counts[t] || 0).toLocaleString('pt-BR');
  });
}

/* ══════════════════════════════════════════════════
   RENDER TABLE  (exibe TODAS as colunas da planilha)
══════════════════════════════════════════════════ */
function renderTable() {
  const tbody = document.getElementById('table-body');
  const thead = document.getElementById('table-head');
  const hdrs  = state.headers;

  const start    = (state.currentPage - 1) * state.pageSize;
  const pageData = state.filtered.slice(start, start + state.pageSize);

  /* Cabeçalho: colunas fixas de auditoria + todas as colunas originais */
  thead.innerHTML = `<tr>
    <th data-col="rowIdx" style="min-width:60px">Linha</th>
    <th data-col="severity" style="min-width:80px">Sev.</th>
    <th data-col="type" style="min-width:120px">Tipo</th>
    <th data-col="description" style="min-width:220px">Problema detectado</th>
    ${hdrs.map(h => `<th style="min-width:120px">${escHtml(h)}</th>`).join('')}
  </tr>`;

  if (pageData.length === 0) {
    tbody.innerHTML = `<tr><td colspan="${4 + hdrs.length}">
      <div class="empty-state">
        <svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><path d="M8 15h8M9 9h.01M15 9h.01"/></svg>
        <p>Nenhuma inconsistência encontrada para este filtro.</p>
      </div></td></tr>`;
  } else {
    tbody.innerHTML = pageData.map(issue => {
      const sevClass = issue.severity === 'critical' ? 'row-critical'
                     : issue.severity === 'warning'  ? 'row-warning' : 'row-info';

      const badgeText = issue.severity === 'critical' ? 'CRÍTICO'
                      : issue.severity === 'warning'  ? 'ALERTA' : 'INFO';
      const badgeCls  = issue.severity === 'critical' ? 'badge-critical'
                      : issue.severity === 'warning'  ? 'badge-warning' : 'badge-info';

      const typeLabel = typeLabels[issue.type] || issue.type;

      /* Células das colunas originais.
         A coluna com problema (missingCol) é destacada:
         - Vermelho intenso se o valor estiver vazio
         - Amarelo se tiver valor mas for inválido */
      const dataCells = hdrs.map(h => {
        const raw     = issue.row[h] ?? '';
        const val     = String(raw).trim();
        const isProb  = issue.missingCol === h;

        let style   = '';
        let display = escHtml(truncate(val, 55));

        if (isProb) {
          if (val === '') {
            style   = 'background:var(--red-light);color:var(--red);font-weight:700;font-style:italic;';
            display = '⚠ VAZIO';
          } else {
            style   = 'background:var(--yellow-light);color:#92400e;font-weight:700;';
          }
        } else if (val === '') {
          style   = 'color:var(--border);';
          display = '—';
        }

        return `<td style="${style}" title="${escHtml(val)}">${display}</td>`;
      }).join('');

      return `<tr class="${sevClass}">
        <td><code style="font-family:var(--font-mono);font-size:0.74rem;background:var(--surface-2);padding:2px 7px;border-radius:4px;">#${issue.rowIdx}</code></td>
        <td><span class="badge ${badgeCls}">${badgeText}</span></td>
        <td style="font-size:0.78rem;font-weight:600;white-space:nowrap">${typeLabel}</td>
        <td style="max-width:280px;white-space:normal;line-height:1.4" title="${escHtml(issue.description)}">${escHtml(issue.description)}</td>
        ${dataCells}
      </tr>`;
    }).join('');
  }

  /* Paginação */
  const total = state.filtered.length;
  const pages = Math.max(1, Math.ceil(total / state.pageSize));
  document.getElementById('table-count').textContent = `${total.toLocaleString('pt-BR')} inconsistências`;
  document.getElementById('page-info').textContent   = `${state.currentPage} / ${pages}`;
  document.getElementById('btn-prev').disabled       = state.currentPage <= 1;
  document.getElementById('btn-next').disabled       = state.currentPage >= pages;

  /* Sort ao clicar no cabeçalho */
  thead.querySelectorAll('th[data-col]').forEach(th => {
    th.style.cursor = 'pointer';
    th.addEventListener('click', () => {
      const col = th.dataset.col;
      if (state.sortCol === col) {
        state.sortDir = state.sortDir === 'asc' ? 'desc' : 'asc';
      } else {
        state.sortCol = col; state.sortDir = 'asc';
      }
      sortFiltered();
      renderTable();
    });
  });
}

/* ══════════════════════════════════════════════════
   RENDER RAW TABLE (aba "Tabela de Dados")
══════════════════════════════════════════════════ */
function renderRawTable() {
  const thead = document.getElementById('raw-head');
  const tbody = document.getElementById('raw-body');
  const cols  = state.headers;

  thead.innerHTML = `<tr>${cols.map(h => `<th>${escHtml(h)}</th>`).join('')}</tr>`;

  const slice = state.rawData.slice(0, 500);
  tbody.innerHTML = slice.map(row =>
    `<tr>${cols.map(h => {
      const v = String(row[h] ?? '').trim();
      return v === ''
        ? `<td style="color:var(--border);font-style:italic">—</td>`
        : `<td title="${escHtml(v)}">${escHtml(truncate(v, 50))}</td>`;
    }).join('')}</tr>`
  ).join('');

  document.getElementById('raw-count').textContent =
    `${state.rawData.length.toLocaleString('pt-BR')} registros totais (exibindo primeiros 500)`;
}

/* ══════════════════════════════════════════════════
   FILTER + SORT
══════════════════════════════════════════════════ */
function applyFilter() {
  let data = state.issues;

  if (state.activeFilter !== 'all') {
    data = data.filter(i => i.type === state.activeFilter);
  }

  if (state.searchTerm) {
    const s = state.searchTerm.toLowerCase();
    data = data.filter(issue => {
      const inMeta = [issue.description, issue.type, String(issue.rowIdx)]
        .some(v => v.toLowerCase().includes(s));
      const inRow  = state.headers.some(h =>
        String(issue.row[h] ?? '').toLowerCase().includes(s));
      return inMeta || inRow;
    });
  }

  state.filtered = data;
  sortFiltered();
  state.currentPage = 1;
}

function sortFiltered() {
  if (!state.sortCol) return;
  state.filtered.sort((a, b) => {
    let va = a[state.sortCol] ?? '', vb = b[state.sortCol] ?? '';
    if (typeof va === 'string') va = va.toLowerCase();
    if (typeof vb === 'string') vb = vb.toLowerCase();
    if (va < vb) return state.sortDir === 'asc' ? -1 : 1;
    if (va > vb) return state.sortDir === 'asc' ?  1 : -1;
    return 0;
  });
}

/* ══════════════════════════════════════════════════
   CHARTS
══════════════════════════════════════════════════ */
function buildCharts(kpis) {
  const isDark    = state.theme === 'dark';
  const gridColor = isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.06)';
  const textColor = isDark ? '#7a86a0' : '#6b7280';
  const bg        = isDark ? '#161b27' : '#fff';

  Chart.defaults.font.family = 'DM Sans, Segoe UI, sans-serif';
  Chart.defaults.font.size   = 12;

  Object.values(state.charts).forEach(c => c.destroy());
  state.charts = {};

  const types  = Object.keys(kpis.counts);
  const values = types.map(t => kpis.counts[t] || 0);
  const colors = types.map(t => TYPE_COLORS[t] || '#94a3b8');
  const labels = types.map(t => typeLabels[t] || t);

  state.charts.pie = new Chart(
    document.getElementById('chart-pie').getContext('2d'), {
      type: 'doughnut',
      data: { labels, datasets: [{ data: values, backgroundColor: colors, borderColor: bg, borderWidth: 3, hoverOffset: 6 }] },
      options: { responsive: true, maintainAspectRatio: false, cutout: '60%',
        plugins: { legend: { position: 'right', labels: { color: textColor, padding: 14, boxWidth: 12, borderRadius: 4 } } } }
    }
  );

  const crit = state.issues.filter(i => i.severity === 'critical').length;
  const warn = state.issues.filter(i => i.severity === 'warning').length;
  const info = state.issues.filter(i => i.severity === 'info').length;
  state.charts.severity = new Chart(
    document.getElementById('chart-severity').getContext('2d'), {
      type: 'doughnut',
      data: { labels: ['Crítico','Alerta','Informativo'], datasets: [{ data: [crit, warn, info], backgroundColor: ['#ef4444','#f59e0b','#3b82f6'], borderColor: bg, borderWidth: 3, hoverOffset: 6 }] },
      options: { responsive: true, maintainAspectRatio: false, cutout: '60%',
        plugins: { legend: { position: 'right', labels: { color: textColor, padding: 14, boxWidth: 12, borderRadius: 4 } } } }
    }
  );

  state.charts.bar = new Chart(
    document.getElementById('chart-bar').getContext('2d'), {
      type: 'bar',
      data: { labels, datasets: [{ label: 'Ocorrências', data: values,
        backgroundColor: colors.map(c => c + 'cc'), borderColor: colors,
        borderWidth: 2, borderRadius: 6, borderSkipped: false }] },
      options: { responsive: true, maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: {
          x: { grid: { color: gridColor }, ticks: { color: textColor } },
          y: { grid: { color: gridColor }, ticks: { color: textColor, stepSize: 1 } }
        } }
    }
  );
}

/* ══════════════════════════════════════════════════
   REPORT
══════════════════════════════════════════════════ */
function buildReport(kpis, rawTotal) {
  document.getElementById('report-date').textContent = `Gerado em ${formatDateTime(new Date())}`;

  const body = document.getElementById('report-body');

  const typeSummary = Object.entries(kpis.counts)
    .filter(([,v]) => v > 0).sort((a,b) => b[1]-a[1])
    .map(([t,v]) => `<tr><td>${typeLabels[t]}</td><td><strong>${v}</strong></td><td>${kpis.total ? ((v/kpis.total)*100).toFixed(1) : 0}%</td></tr>`)
    .join('') || '<tr><td colspan="3" style="color:var(--text-secondary);text-align:center;padding:16px">Sem inconsistências.</td></tr>';

  const critList = state.issues.filter(i => i.severity === 'critical').slice(0, 10)
    .map(i => `<tr><td>#${i.rowIdx}</td><td>${typeLabels[i.type]}</td><td>${escHtml(truncate(i.description, 70))}</td></tr>`)
    .join('') || '<tr><td colspan="3" style="color:var(--text-secondary);text-align:center;padding:16px">Nenhum item crítico.</td></tr>';

  body.innerHTML = `
    <h3>Resumo Executivo</h3>
    <div class="metric-row">
      <div class="report-metric"><div class="label">Total de Registros</div><div class="value">${rawTotal.toLocaleString('pt-BR')}</div></div>
      <div class="report-metric"><div class="label">Total Inconsistências</div><div class="value" style="color:var(--red)">${kpis.total.toLocaleString('pt-BR')}</div></div>
      <div class="report-metric"><div class="label">Itens Críticos</div><div class="value" style="color:var(--red)">${kpis.critical.toLocaleString('pt-BR')}</div></div>
      <div class="report-metric"><div class="label">Alertas</div><div class="value" style="color:var(--yellow)">${state.issues.filter(i=>i.severity==='warning').length}</div></div>
      <div class="report-metric"><div class="label">Score de Risco</div><div class="value" style="color:var(--teal)">${kpis.score}%</div></div>
      <div class="report-metric"><div class="label">Data da Análise</div><div class="value" style="font-size:1rem">${formatDateTime(new Date())}</div></div>
    </div>
    <h3>Distribuição por Tipo</h3>
    <table class="report-table">
      <thead><tr><th>Tipo</th><th>Ocorrências</th><th>% do Total</th></tr></thead>
      <tbody>${typeSummary}</tbody>
    </table>
    <h3>Itens Críticos — Top 10</h3>
    <table class="report-table">
      <thead><tr><th>Linha</th><th>Tipo</th><th>Descrição do Problema</th></tr></thead>
      <tbody>${critList}</tbody>
    </table>`;
}

/* ══════════════════════════════════════════════════
   EXPORT
══════════════════════════════════════════════════ */
function downloadCSV(data, filename) {
  if (!data.length) { alert('Nenhum dado para exportar.'); return; }
  const keys = Object.keys(data[0]);
  const csv  = [
    keys.join(','),
    ...data.map(row => keys.map(k => `"${String(row[k] ?? '').replace(/"/g,'""')}"`).join(','))
  ].join('\n');
  const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' });
  const url  = URL.createObjectURL(blob);
  const a    = Object.assign(document.createElement('a'), { href: url, download: filename });
  a.click();
  URL.revokeObjectURL(url);
}

function exportFilteredIssues() {
  const data = state.filtered.map(i => ({
    'Linha':           i.rowIdx,
    'Tipo':            typeLabels[i.type] || i.type,
    'Severidade':      i.severity,
    'Problema':        i.description,
    'Recomendação':    i.recommendation,
    'Campo com Falha': i.missingCol || '',
    ...Object.fromEntries(state.headers.map(h => [h, i.row[h] ?? ''])),
  }));
  downloadCSV(data, `auditiq_filtrado_${Date.now()}.csv`);
}

function exportFullReport() {
  const data = state.issues.map(i => ({
    'Linha':           i.rowIdx,
    'Tipo':            typeLabels[i.type] || i.type,
    'Severidade':      i.severity,
    'Problema':        i.description,
    'Recomendação':    i.recommendation,
    'Campo com Falha': i.missingCol || '',
    ...Object.fromEntries(state.headers.map(h => [h, i.row[h] ?? ''])),
  }));
  downloadCSV(data, `auditiq_relatorio_completo_${Date.now()}.csv`);
}

/* ══════════════════════════════════════════════════
   LOADER
══════════════════════════════════════════════════ */
function setLoader(pct, msg) {
  document.getElementById('loader-fill').style.width = pct + '%';
  document.getElementById('loader-status').textContent = msg;
}

/* ══════════════════════════════════════════════════
   LOAD + ANALYZE
══════════════════════════════════════════════════ */
async function loadAndAnalyze() {
  setLoader(5, 'Conectando ao Google Sheets...');

  return new Promise((resolve, reject) => {
    Papa.parse(CSV_URL, {
      download:       true,
      header:         true,
      skipEmptyLines: true,
      complete(results) {
        setLoader(50, 'Processando dados...');
        state.rawData = results.data;
        state.headers = results.meta.fields || [];
        state.cols    = detectColumns(state.headers);

        setLoader(70, 'Analisando inconsistências...');
        setTimeout(() => {
          state.issues   = analyzeData(state.rawData, state.headers);
          state.filtered = [...state.issues];
          setLoader(90, 'Montando dashboard...');

          setTimeout(() => {
            const kpis = computeKPIs(state.issues, state.rawData.length);
            renderKPIs(kpis, state.rawData.length);
            applyFilter();
            renderTable();
            renderRawTable();
            buildCharts(kpis);
            buildReport(kpis, state.rawData.length);
            document.getElementById('last-update-time').textContent = formatDateTime(new Date());
            setLoader(100, 'Concluído!');
            resolve();
          }, 100);
        }, 100);
      },
      error(err) {
        setLoader(100, 'Erro ao carregar dados.');
        console.error('PapaParse error:', err);
        reject(err);
      }
    });
  });
}

/* ══════════════════════════════════════════════════
   NAVIGATION
══════════════════════════════════════════════════ */
function switchSection(sectionId) {
  document.querySelectorAll('.section').forEach(s => s.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  document.getElementById('section-' + sectionId)?.classList.add('active');
  document.querySelector(`.nav-item[data-section="${sectionId}"]`)?.classList.add('active');

  const titles = { dashboard:'Dashboard Executivo', tabela:'Tabela de Dados', graficos:'Gráficos e Análises', relatorio:'Relatório Executivo' };
  const subs   = { dashboard:'Análise inteligente de inconsistências em estoque e inventário', tabela:'Dados originais da planilha', graficos:'Distribuição visual das inconsistências', relatorio:'Documento executivo com resumo completo' };
  document.getElementById('section-title').textContent = titles[sectionId] || sectionId;
  document.getElementById('section-sub').textContent   = subs[sectionId]   || '';

  if (window.innerWidth <= 768) {
    document.getElementById('sidebar').classList.remove('open');
    document.getElementById('sidebar-overlay')?.classList.remove('active');
  }
}

/* ══════════════════════════════════════════════════
   THEME
══════════════════════════════════════════════════ */
function toggleTheme() {
  state.theme = state.theme === 'light' ? 'dark' : 'light';
  document.documentElement.setAttribute('data-theme', state.theme);
  document.getElementById('icon-moon').style.display = state.theme === 'dark' ? 'none' : '';
  document.getElementById('icon-sun').style.display  = state.theme === 'dark' ? ''     : 'none';
  document.getElementById('theme-label').textContent = state.theme === 'dark' ? 'Modo Claro' : 'Modo Escuro';
  localStorage.setItem('auditiq-theme', state.theme);
  if (state.issues.length) {
    const kpis = computeKPIs(state.issues, state.rawData.length);
    setTimeout(() => buildCharts(kpis), 50);
  }
}

/* ══════════════════════════════════════════════════
   INIT
══════════════════════════════════════════════════ */
async function init() {
  // Restaurar tema
  const saved = localStorage.getItem('auditiq-theme') || 'light';
  if (saved === 'dark') {
    state.theme = 'dark';
    document.documentElement.setAttribute('data-theme', 'dark');
    document.getElementById('icon-moon').style.display = 'none';
    document.getElementById('icon-sun').style.display  = '';
    document.getElementById('theme-label').textContent = 'Modo Claro';
  }

  // Overlay mobile
  const overlay     = document.createElement('div');
  overlay.id        = 'sidebar-overlay';
  overlay.className = 'sidebar-overlay';
  document.body.appendChild(overlay);
  overlay.addEventListener('click', () => {
    document.getElementById('sidebar').classList.remove('open');
    overlay.classList.remove('active');
  });

  // Carrega dados
  try {
    await loadAndAnalyze();
  } catch {
    document.getElementById('loader-status').textContent = '⚠ Falha ao carregar. Verifique a conexão.';
    await new Promise(r => setTimeout(r, 2500));
  }

  // Exibe app
  const loadingScreen = document.getElementById('loading-screen');
  document.getElementById('app').style.display = 'flex';
  loadingScreen.classList.add('fade-out');
  setTimeout(() => loadingScreen.style.display = 'none', 500);

  /* ── Eventos ── */

  document.querySelectorAll('.nav-item').forEach(item =>
    item.addEventListener('click', e => { e.preventDefault(); switchSection(item.dataset.section); })
  );

  document.getElementById('menu-toggle').addEventListener('click', () => {
    document.getElementById('sidebar').classList.toggle('open');
    overlay.classList.toggle('active');
  });

  document.getElementById('theme-toggle').addEventListener('click', toggleTheme);

  document.getElementById('btn-refresh').addEventListener('click', async () => {
    const btn = document.getElementById('btn-refresh');
    btn.disabled = true;
    btn.innerHTML = `<svg viewBox="0 0 24 24" style="animation:spin 1s linear infinite;stroke:currentColor;stroke-width:2;fill:none;width:15px;height:15px;stroke-linecap:round;stroke-linejoin:round"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 11-2.12-9.36L23 10"/></svg> Atualizando...`;
    try { await loadAndAnalyze(); } finally {
      btn.disabled = false;
      btn.innerHTML = `<svg viewBox="0 0 24 24" style="stroke:currentColor;stroke-width:2;fill:none;width:15px;height:15px;stroke-linecap:round;stroke-linejoin:round"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 11-2.12-9.36L23 10"/></svg> Atualizar`;
    }
  });

  document.querySelectorAll('.pill').forEach(pill =>
    pill.addEventListener('click', () => {
      document.querySelectorAll('.pill').forEach(p => p.classList.remove('active'));
      pill.classList.add('active');
      state.activeFilter = pill.dataset.filter;
      applyFilter();
      renderTable();
    })
  );

  document.getElementById('btn-clear').addEventListener('click', () => {
    state.activeFilter = 'all';
    state.searchTerm   = '';
    state.currentPage  = 1;
    document.getElementById('search-input').value = '';
    document.querySelectorAll('.pill').forEach(p => p.classList.remove('active'));
    document.querySelector('.pill-all').classList.add('active');
    applyFilter();
    renderTable();
  });

  let debounce;
  document.getElementById('search-input').addEventListener('input', e => {
    clearTimeout(debounce);
    debounce = setTimeout(() => {
      state.searchTerm  = e.target.value;
      applyFilter();
      renderTable();
    }, 250);
  });

  document.getElementById('btn-prev').addEventListener('click', () => {
    if (state.currentPage > 1) { state.currentPage--; renderTable(); }
  });
  document.getElementById('btn-next').addEventListener('click', () => {
    if (state.currentPage < Math.ceil(state.filtered.length / state.pageSize)) {
      state.currentPage++; renderTable();
    }
  });
  document.getElementById('page-size').addEventListener('change', e => {
    state.pageSize    = parseInt(e.target.value);
    state.currentPage = 1;
    renderTable();
  });

  document.getElementById('btn-export-filtered').addEventListener('click',  exportFilteredIssues);
  document.getElementById('btn-export-full').addEventListener('click',       exportFullReport);
  document.getElementById('btn-export-csv-report').addEventListener('click', exportFullReport);
  document.getElementById('btn-print-report').addEventListener('click', () => {
    switchSection('relatorio');
    setTimeout(() => window.print(), 300);
  });

  // Auto-refresh
  setInterval(loadAndAnalyze, AUTO_REFRESH_INTERVAL_MS);

  // CSS de animação do botão refresh
  document.head.appendChild(
    Object.assign(document.createElement('style'), {
      textContent: '@keyframes spin { to { transform: rotate(360deg); } }'
    })
  );
}

document.addEventListener('DOMContentLoaded', init);
