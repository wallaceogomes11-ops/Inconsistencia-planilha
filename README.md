# AuditIQ — Análise Inteligente de Estoque

Sistema profissional de auditoria e análise de planilhas com visual corporativo premium.

---

## 📁 Estrutura do Projeto

```
audit-app/
├── index.html   → Estrutura principal da aplicação
├── style.css    → Design system completo
├── script.js    → Lógica de análise e interação
└── README.md    → Este arquivo
```

---

## 🚀 Publicar no GitHub Pages

### 1. Criar repositório
- Acesse [github.com](https://github.com) → **New repository**
- Nome sugerido: `auditiq`
- Visibilidade: **Public**
- Clique em **Create repository**

### 2. Fazer upload dos arquivos
```bash
git clone https://github.com/SEU_USUARIO/auditiq.git
cd auditiq
# copie os 3 arquivos para esta pasta
git add .
git commit -m "feat: AuditIQ initial release"
git push origin main
```

### 3. Ativar GitHub Pages
- Acesse o repositório → **Settings** → **Pages**
- Source: **Deploy from a branch**
- Branch: **main** / **(root)**
- Clique em **Save**

### 4. Acessar o sistema
```
https://SEU_USUARIO.github.io/auditiq/
```

---

## 🌐 Incorporar no Google Sites

### Método 1 — Via iframe (recomendado)
1. Abra o Google Sites
2. Clique em **Inserir** → **Incorporar**
3. Cole o código abaixo:
```html
<iframe
  src="https://SEU_USUARIO.github.io/auditiq/"
  width="100%"
  height="900"
  frameborder="0"
  style="border:none;border-radius:12px">
</iframe>
```
4. Redimensione conforme necessário

### Método 2 — URL direta
- Em "Incorporar" → **Por URL** → cole a URL do GitHub Pages

---

## ⚙️ Personalização

### Trocar a planilha
No arquivo `script.js`, linha 7:
```javascript
const CSV_URL = 'SUA_URL_CSV_AQUI';
```

Para usar sua planilha do Google Sheets:
1. Abra a planilha
2. **Arquivo** → **Publicar na web**
3. Escolha a aba → **Valores separados por vírgula (.csv)**
4. Copie a URL gerada e substitua no `script.js`

### Ajustar limites de análise
```javascript
const SUSPICIOUS_QTY_THRESHOLD = 9999; // quantidade máxima considerada normal
const AUTO_REFRESH_INTERVAL_MS = 5 * 60 * 1000; // atualização automática (5 min)
```

---

## 🔍 Verificações Realizadas

| Tipo | Descrição | Severidade |
|------|-----------|------------|
| Duplicados | Códigos repetidos, fuzzy matching | Crítico |
| Campos Vazios | Campos obrigatórios em branco | Crítico/Alerta |
| End. Inválido | Endereços com formato inválido | Crítico |
| Qtd. Zero | Quantidade igual a zero | Alerta |
| Qtd. Negativa | Quantidade abaixo de zero | Crítico |
| Descrição Div. | Mesmo código com descrições diferentes | Alerta |
| Suspeitos | Quantidades extremamente altas, datas futuras | Alerta |
| Caracteres Inv. | Caracteres especiais, dados não numéricos | Alerta |

---

## 🛠 Tecnologias

- **HTML5** + **CSS3** puro
- **JavaScript** (ES2020+, sem framework)
- **PapaParse** 5.4 — parsing de CSV
- **Chart.js** 4.4 — gráficos
- **Google Fonts** — tipografia (DM Sans + DM Mono)

---

## 📄 Licença

MIT — livre para uso corporativo e pessoal.
