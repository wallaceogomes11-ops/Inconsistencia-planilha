/**
 * AuditIQ — script.js
 * Análise inteligente de planilhas de estoque / inventário
 */

/* ══════════════════════════════════════════════════
   CONFIG
══════════════════════════════════════════════════ */
const CSV_URL = 'https://docs.google.com/spreadsheets/d/e/2PACX-1vRyUZ_F6JuvQcVaIAPQCtQH-4CTi6zn-MIXVktxX6fxdh_eUr5aAZOftF--294824T6MrBIs-1ZCxdv/pub?gid=0&single=true&output=csv';

// Thresholds
const SUSPICIOUS_QTY_THRESHOLD = 9999;
const AUTO_REFRESH_INTERVAL_MS = 5 * 60 * 1000; // 5 min

/* ══════════════════════════════════════════════════
   STATE
══════════════════════════════════════════════════ */
const state = {
  rawData: [],         // all rows from CSV (objects)
  headers: [],         // column names
  issues: [],          // detected inconsistency objects
  filtered: [],        // currently shown rows (issues)
  activeFilter: 'all', // current pill filter
  searchTerm: '',
  currentPage: 1,
  pageSize: 20,
  sortCol: null,
  sortDir: 'asc',
  charts: {},          // Chart.js instances
  theme: 'light',
};

/* ══════════════════════════════════════════════════
   UTILITY HELPERS
══════════════════════════════════════════════════ */
const normalize = (s) => String(s ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
const isEmpty = (v) => v === null || v === undefined || String(v).trim() === '';
const isNumeric = (v) => !isEmpty(v) && !isNaN(parseFloat(String(v).replace(',', '.')));
const toNum = (v) => parseFloat(String(v).replace(',', '.'));

function formatDateTime(date) {
  return date.toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

/** Levenshtein distance (for fuzzy matching) */
function editDistance(a, b) {
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]);
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i-1] === b[j-1] ? dp[i-1][j-1] : 1 + Math.min(dp[i-1][j], dp[i][j-1], dp[i-1][j-1]);
    }
  }
  return dp[m][n];
}

function isSimilar(a, b, threshold = 2) {
  const na = normalize(a), nb = normalize(b);
  if (na === nb) return true;
  if (Math.abs(na.length - nb.length) > 5) return false;
  return editDistance(na, nb) <= threshold;
}

/* ══════════════════════════════════════════════════
   COLUMN DETECTION
══════════════════════════════════════════════════ */
function detectColumns(headers) {
  const h = headers.map(x => normalize(x));
  const find = (...keywords) => headers.find((_, i) => keywords.some(k => h[i].includes(k))) || null;

  return {
    code:     find('microsiga', 'codigo', 'cod', 'code', 'id', 'item'),
    desc:     find('descricao', 'desc', 'nome', 'produto', 'material', 'name'),
    qty:      find('quantidade', 'qtd', 'qty', 'saldo', 'estoque', 'quant'),
    address:  find('endereco', 'endereço', 'localizacao', 'local', 'address', 'posicao', 'posição', 'rua', 'box'),
    date:     find('data', 'date', 'vencimento', 'fabricacao'),
    order:    find('pedido', 'order', 'requisicao', 'solicitacao'),
    unit:     find('unidade', 'un ', 'um ', 'unit'),
    cost:     find('custo', 'preco', 'valor', 'cost', 'price'),
  };
}

/* ══════════════════════════════════════════════════
   ANALYSIS ENGINE
══════════════════════════════════════════════════ */
function analyzeData(rows, headers) {
  const cols = detectColumns(headers);
  const issues = [];
  let id = 1;

  const addIssue = (rowIdx, row, type, severity, description, recommendation) => {
    issues.push({ id: id++, rowIdx: rowIdx + 2, row, type, severity, description, recommendation });
  };

  // ── Maps for cross-row checks ──
  const codeToRows = {};      // code → [{idx, row}]
  const addressToRows = {};   // address → [{idx, row, code}]
  const codeToDescs = {};     // code → Set of descriptions
  const orderItems = {};      // orderId → [codes]

  rows.forEach((row, idx) => {
    const code    = cols.code    ? String(row[cols.code] ?? '').trim()    : '';
    const desc    = cols.desc    ? String(row[cols.desc] ?? '').trim()    : '';
    const qty     = cols.qty     ? row[cols.qty]                          : null;
    const address = cols.address ? String(row[cols.address] ?? '').trim() : '';
    const order   = cols.order   ? String(row[cols.order] ?? '').trim()   : '';
    const date    = cols.date    ? String(row[cols.date] ?? '').trim()    : '';

    // ── 1. Completely empty row ──
    const vals = headers.map(h => String(row[h] ?? '').trim());
    if (vals.every(v => v === '')) {
      addIssue(idx, row, 'empty', 'info', 'Linha completamente vazia', 'Verificar e remover linha vazia.');
      return; // skip further checks
    }

    // ── 2. Required fields empty ──
    if (cols.code && isEmpty(code)) {
      addIssue(idx, row, 'empty', 'critical', `Campo obrigatório "${cols.code}" está vazio`, 'Preencher o código do item.');
    }
    if (cols.desc && isEmpty(desc)) {
      addIssue(idx, row, 'empty', 'warning', `Campo obrigatório "${cols.desc}" está vazio`, 'Preencher a descrição do item.');
    }
    if (cols.qty && isEmpty(qty)) {
      addIssue(idx, row, 'empty', 'warning', `Campo de quantidade "${cols.qty}" está vazio`, 'Verificar e preencher a quantidade.');
    }

    // ── 3. Quantity checks ──
    if (cols.qty && !isEmpty(qty)) {
      if (!isNumeric(qty)) {
        addIssue(idx, row, 'chars', 'critical', `Quantidade não numérica: "${qty}"`, 'Corrigir o valor para um número válido.');
      } else {
        const n = toNum(qty);
        if (n === 0) {
          addIssue(idx, row, 'zero', 'warning', `Quantidade zero para o item "${code || desc}"`, 'Verificar se este item deve permanecer no estoque.');
        } else if (n < 0) {
          addIssue(idx, row, 'negative', 'critical', `Quantidade negativa (${n}) para "${code || desc}"`, 'Auditar movimentação. Quantidade negativa indica erro de lançamento.');
        } else if (n > SUSPICIOUS_QTY_THRESHOLD) {
          addIssue(idx, row, 'suspicious', 'warning', `Quantidade suspeita/extremamente alta: ${n}`, 'Confirmar se a quantidade está correta.');
        }
      }
    }

    // ── 4. Invalid address ──
    if (cols.address && !isEmpty(address)) {
      const invalidChars = /[<>{}|\\^`]/.test(address);
      const tooShort = address.length < 2;
      const onlySpecial = /^[^a-zA-Z0-9]+$/.test(address);
      if (invalidChars || tooShort || onlySpecial) {
        addIssue(idx, row, 'address', 'critical', `Endereço inválido: "${address}"`, 'Verificar e corrigir o endereço de armazenagem.');
      }
      // Track address
      const normAddr = normalize(address);
      if (!addressToRows[normAddr]) addressToRows[normAddr] = [];
      addressToRows[normAddr].push({ idx, row, code: normalize(code) });
    }

    // ── 5. Invalid characters in code or description ──
    const invalidPattern = /[^\w\s\-\/\.,()\u00C0-\u024F]/;
    if (cols.code && !isEmpty(code) && invalidPattern.test(code)) {
      addIssue(idx, row, 'chars', 'warning', `Caracteres suspeitos no código: "${code}"`, 'Verificar e corrigir o código do item.');
    }
    if (cols.desc && !isEmpty(desc) && /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/.test(desc)) {
      addIssue(idx, row, 'chars', 'warning', `Caracteres de controle na descrição: "${desc}"`, 'Limpar caracteres inválidos na descrição.');
    }

    // ── 6. Invalid date ──
    if (cols.date && !isEmpty(date)) {
      const parsed = Date.parse(date.replace(/(\d{2})\/(\d{2})\/(\d{4})/, '$3-$2-$1'));
      if (isNaN(parsed)) {
        addIssue(idx, row, 'chars', 'warning', `Data inválida: "${date}"`, 'Verificar e corrigir o formato da data.');
      } else if (new Date(parsed) > new Date(Date.now() + 30 * 365 * 24 * 3600 * 1000)) {
        addIssue(idx, row, 'suspicious', 'warning', `Data muito distante no futuro: "${date}"`, 'Confirmar se a data está correta.');
      }
    }

    // ── Build maps for cross-row analysis ──
    if (cols.code && !isEmpty(code)) {
      const nc = normalize(code);
      if (!codeToRows[nc]) codeToRows[nc] = [];
      codeToRows[nc].push({ idx, row });

      if (cols.desc && !isEmpty(desc)) {
        if (!codeToDescs[nc]) codeToDescs[nc] = new Set();
        codeToDescs[nc].add(normalize(desc));
      }
    }

    if (cols.order && !isEmpty(order)) {
      const no = normalize(order);
      if (!orderItems[no]) orderItems[no] = [];
      orderItems[no].push({ idx, code: normalize(code) });
    }
  });

  // ── 7. Duplicate codes ──
  const dupeReported = new Set();
  Object.entries(codeToRows).forEach(([nc, list]) => {
    if (list.length > 1) {
      list.forEach(({ idx, row }) => {
        if (!dupeReported.has(idx)) {
          dupeReported.add(idx);
          addIssue(idx, row, 'duplicate', 'critical',
            `Código duplicado: "${row[cols.code]}" aparece ${list.length}x`,
            'Verificar e consolidar registros duplicados.');
        }
      });
    }
  });

  // ── 8. Same address, different items ──
  const addrDupeReported = new Set();
  Object.entries(addressToRows).forEach(([addr, list]) => {
    const codes = [...new Set(list.map(x => x.code))];
    if (codes.length > 1) {
      list.forEach(({ idx, row }) => {
        if (!addrDupeReported.has(idx)) {
          addrDupeReported.add(idx);
          addIssue(idx, row, 'address', 'warning',
            `Endereço "${addr}" compartilhado por ${codes.length} itens diferentes`,
            'Verificar se o endereço foi atribuído corretamente a cada item.');
        }
      });
    }
  });

  // ── 9. Same code, different descriptions ──
  const descReported = new Set();
  Object.entries(codeToDescs).forEach(([nc, descSet]) => {
    if (descSet.size > 1) {
      const list = codeToRows[nc] || [];
      list.forEach(({ idx, row }) => {
        if (!descReported.has(idx)) {
          descReported.add(idx);
          addIssue(idx, row, 'desc', 'warning',
            `Código "${row[cols.code]}" possui ${descSet.size} descrições diferentes`,
            'Padronizar a descrição do produto no cadastro master.');
        }
      });
    }
  });

  // ── 10. Repeated items in same order ──
  Object.entries(orderItems).forEach(([orderId, items]) => {
    const codeCount = {};
    items.forEach(({ code }) => { codeCount[code] = (codeCount[code] || 0) + 1; });
    items.forEach(({ idx, code }) => {
      if (codeCount[code] > 1 && !dupeReported.has(idx + '_order')) {
        dupeReported.add(idx + '_order');
        const row = rows[idx];
        addIssue(idx, row, 'duplicate', 'warning',
          `Item "${code}" repetido ${codeCount[code]}x no pedido "${orderId}"`,
          'Verificar se a repetição é intencional ou erro de lançamento.');
      }
    });
  });

  // ── 11. Fuzzy duplicates (similar codes) ──
  const codesList = Object.keys(codeToRows);
  const fuzzyReported = new Set();
  for (let i = 0; i < Math.min(codesList.length, 500); i++) {
    for (let j = i + 1; j < Math.min(codesList.length, 500); j++) {
      if (isSimilar(codesList[i], codesList[j], 1) && codesList[i] !== codesList[j]) {
        [codeToRows[codesList[i]], codeToRows[codesList[j]]].flat().forEach(({ idx, row }) => {
          if (!fuzzyReported.has(idx)) {
            fuzzyReported.add(idx);
            addIssue(idx, row, 'duplicate', 'warning',
              `Código similar detectado: "${codesList[i]}" ≈ "${codesList[j]}"`,
              'Verificar se são o mesmo item cadastrado de formas diferentes.');
          }
        });
      }
    }
  }

  return issues;
}

/* ══════════════════════════════════════════════════
   COMPUTE KPIs + SCORE
══════════════════════════════════════════════════ */
function computeKPIs(issues, rawTotal) {
  const counts = {
    duplicate: 0, empty: 0, address: 0,
    zero: 0, negative: 0, desc: 0,
    suspicious: 0, chars: 0,
  };
  let critical = 0;

  issues.forEach(issue => {
    counts[issue.type] = (counts[issue.type] || 0) + 1;
    if (issue.severity === 'critical') critical++;
  });

  // Score: 0–100 (higher = more risk)
  const total = issues.length;
  const rawScore = rawTotal > 0
    ? Math.min(100, Math.round((critical * 2 + (total - critical)) / rawTotal * 100))
    : 0;

  return { counts, critical, total, score: rawScore };
}

/* ══════════════════════════════════════════════════
   RENDER KPI CARDS
══════════════════════════════════════════════════ */
function renderKPIs(kpis, rawTotal) {
  document.getElementById('kpi-total').textContent = rawTotal.toLocaleString('pt-BR');
  document.getElementById('kpi-issues').textContent = kpis.total.toLocaleString('pt-BR');
  document.getElementById('kpi-duplicates').textContent = kpis.counts.duplicate.toLocaleString('pt-BR');
  document.getElementById('kpi-empty').textContent = kpis.counts.empty.toLocaleString('pt-BR');
  document.getElementById('kpi-address').textContent = kpis.counts.address.toLocaleString('pt-BR');
  document.getElementById('kpi-critical').textContent = kpis.critical.toLocaleString('pt-BR');
  document.getElementById('kpi-score').textContent = kpis.score + '%';

  // Score bar color
  const bar = document.getElementById('score-bar');
  const pct = kpis.score;
  bar.style.width = pct + '%';
  bar.style.background = pct < 20 ? 'var(--green)' : pct < 50 ? 'var(--yellow)' : 'var(--red)';

  // Pill counts
  const pillMap = { duplicate: 'pc-duplicate', empty: 'pc-empty', address: 'pc-address', zero: 'pc-zero', negative: 'pc-negative', desc: 'pc-desc', suspicious: 'pc-suspicious', chars: 'pc-chars' };
  Object.entries(pillMap).forEach(([type, id]) => {
    document.getElementById(id).textContent = (kpis.counts[type] || 0).toLocaleString('pt-BR');
  });
}

/* ══════════════════════════════════════════════════
   RENDER TABLE
══════════════════════════════════════════════════ */
function renderTable() {
  const tbody = document.getElementById('table-body');
  const thead = document.getElementById('table-head');

  // Get current page slice
  const start = (state.currentPage - 1) * state.pageSize;
  const end = start + state.pageSize;
  const pageData = state.filtered.slice(start, end);

  // Header (static for issues view)
  thead.innerHTML = `<tr>
    <th data-col="rowIdx" class="${state.sortCol === 'rowIdx' ? 'sort-' + state.sortDir : ''}">Linha</th>
    <th data-col="type">Tipo</th>
    <th data-col="severity" class="${state.sortCol === 'severity' ? 'sort-' + state.sortDir : ''}">Severidade</th>
    <th data-col="description">Descrição do Problema</th>
    <th data-col="recommendation">Recomendação</th>
    ${state.headers.slice(0, 4).map(h => `<th>${escHtml(h)}</th>`).join('')}
  </tr>`;

  // Body
  if (pageData.length === 0) {
    tbody.innerHTML = `<tr><td colspan="20"><div class="empty-state"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><path d="M8 15h8M9 9h.01M15 9h.01"/></svg><p>Nenhuma inconsistência encontrada para este filtro.</p></div></td></tr>`;
  } else {
    tbody.innerHTML = pageData.map(issue => {
      const sevClass = issue.severity === 'critical' ? 'row-critical' : issue.severity === 'warning' ? 'row-warning' : 'row-info';
      const badge = `<span class="badge badge-${issue.severity === 'critical' ? 'critical' : issue.severity === 'warning' ? 'warning' : 'info'}">${issue.severity.toUpperCase()}</span>`;
      const typeLabel = typeLabels[issue.type] || issue.type;
      const rawCols = state.headers.slice(0, 4).map(h => `<td title="${escHtml(String(issue.row[h] ?? ''))}">${escHtml(truncate(String(issue.row[h] ?? '')))}</td>`).join('');
      return `<tr class="${sevClass}">
        <td><code style="font-family:var(--font-mono);font-size:0.75rem;background:var(--surface-2);padding:2px 6px;border-radius:4px;">#${issue.rowIdx}</code></td>
        <td><span style="font-size:0.78rem;font-weight:600">${typeLabel}</span></td>
        <td>${badge}</td>
        <td title="${escHtml(issue.description)}">${escHtml(truncate(issue.description, 80))}</td>
        <td title="${escHtml(issue.recommendation)}">${escHtml(truncate(issue.recommendation, 70))}</td>
        ${rawCols}
      </tr>`;
    }).join('');
  }

  // Counts & pagination
  const total = state.filtered.length;
  const pages = Math.max(1, Math.ceil(total / state.pageSize));
  document.getElementById('table-count').textContent = `${total.toLocaleString('pt-BR')} inconsistências`;
  document.getElementById('page-info').textContent = `${state.currentPage} / ${pages}`;
  document.getElementById('btn-prev').disabled = state.currentPage <= 1;
  document.getElementById('btn-next').disabled = state.currentPage >= pages;

  // Sort header listeners
  thead.querySelectorAll('th[data-col]').forEach(th => {
    th.addEventListener('click', () => {
      const col = th.dataset.col;
      if (state.sortCol === col) {
        state.sortDir = state.sortDir === 'asc' ? 'desc' : 'asc';
      } else {
        state.sortCol = col;
        state.sortDir = 'asc';
      }
      sortFiltered();
      renderTable();
    });
  });
}

/* ══════════════════════════════════════════════════
   RENDER RAW TABLE
══════════════════════════════════════════════════ */
function renderRawTable() {
  const thead = document.getElementById('raw-head');
  const tbody = document.getElementById('raw-body');
  const cols = state.headers;

  thead.innerHTML = `<tr>${cols.map(h => `<th>${escHtml(h)}</th>`).join('')}</tr>`;

  const slice = state.rawData.slice(0, 200); // show first 200 for perf
  tbody.innerHTML = slice.map(row =>
    `<tr>${cols.map(h => `<td title="${escHtml(String(row[h] ?? ''))}">${escHtml(truncate(String(row[h] ?? '')))}</td>`).join('')}</tr>`
  ).join('');

  document.getElementById('raw-count').textContent = `${state.rawData.length.toLocaleString('pt-BR')} registros totais`;
}

/* ══════════════════════════════════════════════════
   FILTER + SORT LOGIC
══════════════════════════════════════════════════ */
function applyFilter() {
  let data = state.issues;

  // Type filter
  if (state.activeFilter !== 'all') {
    data = data.filter(i => i.type === state.activeFilter);
  }

  // Search
  if (state.searchTerm) {
    const s = state.searchTerm.toLowerCase();
    data = data.filter(issue => {
      const inIssue = [issue.description, issue.recommendation, issue.type, String(issue.rowIdx)]
        .some(v => v.toLowerCase().includes(s));
      const inRow = state.headers.some(h => String(issue.row[h] ?? '').toLowerCase().includes(s));
      return inIssue || inRow;
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
    if (va > vb) return state.sortDir === 'asc' ? 1 : -1;
    return 0;
  });
}

/* ══════════════════════════════════════════════════
   CHARTS
══════════════════════════════════════════════════ */
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

function buildCharts(kpis) {
  const isDark = state.theme === 'dark';
  const gridColor = isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.06)';
  const textColor = isDark ? '#7a86a0' : '#6b7280';

  Chart.defaults.font.family = 'DM Sans, Segoe UI, sans-serif';
  Chart.defaults.font.size = 12;

  // Destroy existing
  Object.values(state.charts).forEach(c => c.destroy());
  state.charts = {};

  const types = Object.keys(kpis.counts);
  const values = types.map(t => kpis.counts[t] || 0);
  const colors = types.map(t => TYPE_COLORS[t] || '#94a3b8');
  const labels = types.map(t => typeLabels[t] || t);

  // ── Pie ──
  const ctxPie = document.getElementById('chart-pie').getContext('2d');
  state.charts.pie = new Chart(ctxPie, {
    type: 'doughnut',
    data: {
      labels,
      datasets: [{ data: values, backgroundColor: colors, borderColor: isDark ? '#161b27' : '#fff', borderWidth: 3, hoverOffset: 6 }],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      cutout: '60%',
      plugins: {
        legend: { position: 'right', labels: { color: textColor, padding: 14, boxWidth: 12, borderRadius: 4 } },
        tooltip: { callbacks: { label: ctx => ` ${ctx.label}: ${ctx.parsed}` } }
      }
    }
  });

  // ── Severity ──
  const critCount = state.issues.filter(i => i.severity === 'critical').length;
  const warnCount = state.issues.filter(i => i.severity === 'warning').length;
  const infoCount = state.issues.filter(i => i.severity === 'info').length;

  const ctxSev = document.getElementById('chart-severity').getContext('2d');
  state.charts.severity = new Chart(ctxSev, {
    type: 'doughnut',
    data: {
      labels: ['Crítico', 'Alerta', 'Informativo'],
      datasets: [{ data: [critCount, warnCount, infoCount], backgroundColor: ['#ef4444', '#f59e0b', '#3b82f6'], borderColor: isDark ? '#161b27' : '#fff', borderWidth: 3, hoverOffset: 6 }]
    },
    options: {
      responsive: true, maintainAspectRatio: false, cutout: '60%',
      plugins: {
        legend: { position: 'right', labels: { color: textColor, padding: 14, boxWidth: 12, borderRadius: 4 } }
      }
    }
  });

  // ── Bar ──
  const ctxBar = document.getElementById('chart-bar').getContext('2d');
  state.charts.bar = new Chart(ctxBar, {
    type: 'bar',
    data: {
      labels,
      datasets: [{
        label: 'Ocorrências',
        data: values,
        backgroundColor: colors.map(c => c + 'cc'),
        borderColor: colors,
        borderWidth: 2, borderRadius: 6, borderSkipped: false,
      }]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: {
        x: { grid: { color: gridColor }, ticks: { color: textColor } },
        y: { grid: { color: gridColor }, ticks: { color: textColor, stepSize: 1 } }
      }
    }
  });
}

/* ══════════════════════════════════════════════════
   REPORT
══════════════════════════════════════════════════ */
function buildReport(kpis, rawTotal) {
  document.getElementById('report-date').textContent = `Gerado em ${formatDateTime(new Date())}`;
  const body = document.getElementById('report-body');

  const typeSummary = Object.entries(kpis.counts)
    .filter(([, v]) => v > 0)
    .sort((a, b) => b[1] - a[1])
    .map(([t, v]) => `<tr><td>${typeLabels[t]}</td><td><strong>${v}</strong></td><td>${((v / kpis.total) * 100).toFixed(1)}%</td></tr>`)
    .join('');

  const examplesHtml = state.issues.filter(i => i.severity === 'critical').slice(0, 10)
    .map(i => `<tr><td>#${i.rowIdx}</td><td>${typeLabels[i.type]}</td><td>${escHtml(truncate(i.description, 70))}</td><td>${escHtml(truncate(i.recommendation, 60))}</td></tr>`)
    .join('') || '<tr><td colspan="4" style="color:var(--text-secondary);text-align:center;padding:20px">Nenhum item crítico encontrado.</td></tr>';

  body.innerHTML = `
    <h3>Resumo Executivo</h3>
    <div class="metric-row">
      <div class="report-metric"><div class="label">Total de Registros</div><div class="value">${rawTotal.toLocaleString('pt-BR')}</div></div>
      <div class="report-metric"><div class="label">Total de Inconsistências</div><div class="value" style="color:var(--red)">${kpis.total.toLocaleString('pt-BR')}</div></div>
      <div class="report-metric"><div class="label">Itens Críticos</div><div class="value" style="color:var(--red)">${kpis.critical.toLocaleString('pt-BR')}</div></div>
      <div class="report-metric"><div class="label">Alertas</div><div class="value" style="color:var(--yellow)">${state.issues.filter(i=>i.severity==='warning').length}</div></div>
      <div class="report-metric"><div class="label">Score de Risco</div><div class="value" style="color:var(--teal)">${kpis.score}%</div></div>
      <div class="report-metric"><div class="label">Data da Análise</div><div class="value" style="font-size:1rem">${formatDateTime(new Date())}</div></div>
    </div>

    <h3>Distribuição por Tipo</h3>
    <table class="report-table">
      <thead><tr><th>Tipo</th><th>Ocorrências</th><th>% do Total</th></tr></thead>
      <tbody>${typeSummary || '<tr><td colspan="3" style="color:var(--text-secondary)">Sem inconsistências.</td></tr>'}</tbody>
    </table>

    <h3>Itens Críticos (Top 10)</h3>
    <table class="report-table">
      <thead><tr><th>Linha</th><th>Tipo</th><th>Descrição</th><th>Recomendação</th></tr></thead>
      <tbody>${examplesHtml}</tbody>
    </table>
  `;
}

/* ══════════════════════════════════════════════════
   EXPORT
══════════════════════════════════════════════════ */
function downloadCSV(data, filename) {
  if (!data.length) return alert('Nenhum dado para exportar.');
  const keys = Object.keys(data[0]);
  const csv = [keys.join(','), ...data.map(row => keys.map(k => `"${String(row[k] ?? '').replace(/"/g, '""')}"`).join(','))].join('\n');
  const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
}

function exportFilteredIssues() {
  const data = state.filtered.map(i => ({
    'Linha': i.rowIdx,
    'Tipo': typeLabels[i.type] || i.type,
    'Severidade': i.severity,
    'Descrição': i.description,
    'Recomendação': i.recommendation,
    ...Object.fromEntries(state.headers.map(h => [h, i.row[h] ?? '']))
  }));
  downloadCSV(data, `auditiq_filtrado_${Date.now()}.csv`);
}

function exportFullReport() {
  const data = state.issues.map(i => ({
    'Linha': i.rowIdx,
    'Tipo': typeLabels[i.type] || i.type,
    'Severidade': i.severity,
    'Descrição': i.description,
    'Recomendação': i.recommendation,
    ...Object.fromEntries(state.headers.map(h => [h, i.row[h] ?? '']))
  }));
  downloadCSV(data, `auditiq_relatorio_completo_${Date.now()}.csv`);
}

/* ══════════════════════════════════════════════════
   LOADER ANIMATION
══════════════════════════════════════════════════ */
function setLoader(pct, msg) {
  document.getElementById('loader-fill').style.width = pct + '%';
  document.getElementById('loader-status').textContent = msg;
}

/* ══════════════════════════════════════════════════
   MAIN: LOAD DATA
══════════════════════════════════════════════════ */
async function loadAndAnalyze() {
  setLoader(5, 'Conectando ao Google Sheets...');

  return new Promise((resolve, reject) => {
    Papa.parse(CSV_URL, {
      download: true,
      header: true,
      skipEmptyLines: true,
      complete(results) {
        setLoader(50, 'Processando dados...');
        state.rawData = results.data;
        state.headers = results.meta.fields || [];

        setLoader(70, 'Analisando inconsistências...');

        setTimeout(() => {
          state.issues = analyzeData(state.rawData, state.headers);
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
   STRING HELPERS
══════════════════════════════════════════════════ */
function escHtml(str) {
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function truncate(str, max = 60) {
  return str.length > max ? str.slice(0, max) + '…' : str;
}

/* ══════════════════════════════════════════════════
   NAVIGATION
══════════════════════════════════════════════════ */
function switchSection(sectionId) {
  document.querySelectorAll('.section').forEach(s => s.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  document.getElementById('section-' + sectionId).classList.add('active');
  document.querySelector(`.nav-item[data-section="${sectionId}"]`).classList.add('active');

  const titles = { dashboard: 'Dashboard Executivo', tabela: 'Tabela de Dados', graficos: 'Gráficos e Análises', relatorio: 'Relatório Executivo' };
  const subs = { dashboard: 'Análise inteligente de inconsistências em estoque e inventário', tabela: 'Visualização dos dados originais da planilha', graficos: 'Distribuição visual das inconsistências detectadas', relatorio: 'Documento executivo com resumo completo' };
  document.getElementById('section-title').textContent = titles[sectionId] || sectionId;
  document.getElementById('section-sub').textContent = subs[sectionId] || '';

  // Close sidebar on mobile
  if (window.innerWidth <= 768) {
    document.getElementById('sidebar').classList.remove('open');
    document.getElementById('sidebar-overlay').classList.remove('active');
  }
}

/* ══════════════════════════════════════════════════
   THEME TOGGLE
══════════════════════════════════════════════════ */
function toggleTheme() {
  const html = document.documentElement;
  state.theme = state.theme === 'light' ? 'dark' : 'light';
  html.setAttribute('data-theme', state.theme);
  document.getElementById('icon-moon').style.display = state.theme === 'dark' ? 'none' : '';
  document.getElementById('icon-sun').style.display = state.theme === 'dark' ? '' : 'none';
  document.getElementById('theme-label').textContent = state.theme === 'dark' ? 'Modo Claro' : 'Modo Escuro';
  localStorage.setItem('auditiq-theme', state.theme);

  // Rebuild charts with new colors
  if (state.issues.length) {
    const kpis = computeKPIs(state.issues, state.rawData.length);
    setTimeout(() => buildCharts(kpis), 50);
  }
}

/* ══════════════════════════════════════════════════
   INIT
══════════════════════════════════════════════════ */
async function init() {
  // Restore theme
  const savedTheme = localStorage.getItem('auditiq-theme') || 'light';
  if (savedTheme === 'dark') {
    state.theme = 'dark';
    document.documentElement.setAttribute('data-theme', 'dark');
    document.getElementById('icon-moon').style.display = 'none';
    document.getElementById('icon-sun').style.display = '';
    document.getElementById('theme-label').textContent = 'Modo Claro';
  }

  // Create sidebar overlay for mobile
  const overlay = document.createElement('div');
  overlay.id = 'sidebar-overlay';
  overlay.className = 'sidebar-overlay';
  document.body.appendChild(overlay);
  overlay.addEventListener('click', () => {
    document.getElementById('sidebar').classList.remove('open');
    overlay.classList.remove('active');
  });

  // Load data
  try {
    await loadAndAnalyze();
  } catch (e) {
    document.getElementById('loader-status').textContent = '⚠ Falha ao carregar dados. Verifique a conexão.';
    await new Promise(r => setTimeout(r, 2000));
  }

  // Show app
  const loadingScreen = document.getElementById('loading-screen');
  const app = document.getElementById('app');
  loadingScreen.classList.add('fade-out');
  app.style.display = 'flex';
  setTimeout(() => loadingScreen.style.display = 'none', 500);

  // ── Event listeners ──

  // Navigation
  document.querySelectorAll('.nav-item').forEach(item => {
    item.addEventListener('click', (e) => {
      e.preventDefault();
      switchSection(item.dataset.section);
    });
  });

  // Mobile menu toggle
  document.getElementById('menu-toggle').addEventListener('click', () => {
    document.getElementById('sidebar').classList.toggle('open');
    document.getElementById('sidebar-overlay').classList.toggle('active');
  });

  // Theme toggle
  document.getElementById('theme-toggle').addEventListener('click', toggleTheme);

  // Refresh
  document.getElementById('btn-refresh').addEventListener('click', async () => {
    const btn = document.getElementById('btn-refresh');
    btn.disabled = true;
    btn.innerHTML = `<svg viewBox="0 0 24 24" style="animation:spin 1s linear infinite"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 11-2.12-9.36L23 10"/></svg> Atualizando...`;
    try {
      await loadAndAnalyze();
    } finally {
      btn.disabled = false;
      btn.innerHTML = `<svg viewBox="0 0 24 24"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 11-2.12-9.36L23 10"/></svg> Atualizar`;
    }
  });

  // Filter pills
  document.querySelectorAll('.pill').forEach(pill => {
    pill.addEventListener('click', () => {
      document.querySelectorAll('.pill').forEach(p => p.classList.remove('active'));
      pill.classList.add('active');
      state.activeFilter = pill.dataset.filter;
      applyFilter();
      renderTable();
    });
  });

  // Clear filters
  document.getElementById('btn-clear').addEventListener('click', () => {
    state.activeFilter = 'all';
    state.searchTerm = '';
    state.currentPage = 1;
    document.getElementById('search-input').value = '';
    document.querySelectorAll('.pill').forEach(p => p.classList.remove('active'));
    document.querySelector('.pill-all').classList.add('active');
    applyFilter();
    renderTable();
  });

  // Search
  let searchDebounce;
  document.getElementById('search-input').addEventListener('input', (e) => {
    clearTimeout(searchDebounce);
    searchDebounce = setTimeout(() => {
      state.searchTerm = e.target.value;
      applyFilter();
      renderTable();
    }, 250);
  });

  // Pagination
  document.getElementById('btn-prev').addEventListener('click', () => {
    if (state.currentPage > 1) { state.currentPage--; renderTable(); }
  });
  document.getElementById('btn-next').addEventListener('click', () => {
    const pages = Math.ceil(state.filtered.length / state.pageSize);
    if (state.currentPage < pages) { state.currentPage++; renderTable(); }
  });
  document.getElementById('page-size').addEventListener('change', (e) => {
    state.pageSize = parseInt(e.target.value);
    state.currentPage = 1;
    renderTable();
  });

  // Export buttons
  document.getElementById('btn-export-filtered').addEventListener('click', exportFilteredIssues);
  document.getElementById('btn-export-full').addEventListener('click', exportFullReport);
  document.getElementById('btn-export-csv-report').addEventListener('click', exportFullReport);
  document.getElementById('btn-print-report').addEventListener('click', () => {
    switchSection('relatorio');
    setTimeout(() => window.print(), 300);
  });

  // Auto-refresh
  setInterval(() => loadAndAnalyze(), AUTO_REFRESH_INTERVAL_MS);

  // Spin animation
  const style = document.createElement('style');
  style.textContent = '@keyframes spin { to { transform: rotate(360deg); } }';
  document.head.appendChild(style);
}

// Start
document.addEventListener('DOMContentLoaded', init);
