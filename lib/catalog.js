const fs = require('fs');
const path = require('path');

function dataFile(name) {
  const seeds = [__dirname, process.cwd(), process.env.LAMBDA_TASK_ROOT, '/var/task'].filter(Boolean);
  const seen = new Set();
  for (const seed of seeds) {
    let current = seed;
    for (let depth = 0; depth < 8; depth += 1) {
      const candidate = path.join(current, 'data', name);
      if (!seen.has(candidate)) {
        seen.add(candidate);
        if (fs.existsSync(candidate)) return candidate;
      }
      const parent = path.dirname(current);
      if (parent === current) break;
      current = parent;
    }
  }
  return path.join(__dirname, '..', 'data', name);
}

function esc(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  })[char]);
}

function loadCatalog() {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(dataFile('companies.json'), 'utf8'));
  } catch {
    raw = require('../data/companies.json');
  }
  const updated = String(raw.updated || '').trim();
  const source = Array.isArray(raw) ? raw : raw.companies;
  if (!Array.isArray(source)) {
    throw new Error('data/companies.json must contain a companies array');
  }

  const seen = new Set();
  const companies = [];

  for (const item of source) {
    const name = String(item.name || '').trim();
    const industry = String(item.industry || 'General').trim();
    const location = String(item.location || 'India').trim();
    const url = String(item.url || '').trim();
    if (!name || !url) continue;

    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      continue;
    }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') continue;

    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    companies.push({ name, industry, location, url: parsed.href });
  }

  companies.sort((a, b) => a.industry.localeCompare(b.industry) || a.name.localeCompare(b.name));
  return { updated, companies };
}

function industryCounts(companies) {
  const counts = new Map();
  for (const company of companies) {
    counts.set(company.industry, (counts.get(company.industry) || 0) + 1);
  }
  return [...counts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

function previewCompanies(companies, limit = 8) {
  const picked = [];
  const seen = new Set();
  for (const company of companies) {
    if (seen.has(company.industry)) continue;
    seen.add(company.industry);
    picked.push(company);
    if (picked.length === limit) return picked;
  }
  for (const company of companies) {
    if (picked.length === limit) break;
    if (!picked.includes(company)) picked.push(company);
  }
  return picked;
}

function csvCell(value) {
  let text = String(value ?? '');
  if (/^[=+\-@]/.test(text)) text = `'${text}`;
  if (/[",\n\r]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

function renderCsv(companies) {
  const lines = ['Company,Industry,Location,Careers URL'];
  for (const company of companies) {
    lines.push([company.name, company.industry, company.location, company.url].map(csvCell).join(','));
  }
  return `\uFEFF${lines.join('\r\n')}\r\n`;
}

function renderHtml(catalog) {
  const { companies, updated } = catalog;
  const industries = industryCounts(companies);
  const groups = new Map();
  for (const company of companies) {
    if (!groups.has(company.industry)) groups.set(company.industry, []);
    groups.get(company.industry).push(company);
  }

  const options = industries
    .map((item) => `<option value="${esc(item.name)}">${esc(item.name)} (${item.count})</option>`)
    .join('');

  const sections = [...groups.entries()].map(([industry, items]) => {
    const rows = items.map((company) => {
      const search = `${company.name} ${company.industry} ${company.location}`.toLowerCase();
      return `<li data-industry="${esc(industry)}" data-search="${esc(search)}">
        <div>
          <strong>${esc(company.name)}</strong>
          <span>${esc(company.location)}</span>
        </div>
        <a href="${esc(company.url)}" target="_blank" rel="noopener noreferrer">Open careers page</a>
      </li>`;
    }).join('');

    return `<section data-industry="${esc(industry)}">
      <h2>${esc(industry)} <span class="count">${items.length}</span></h2>
      <ul>${rows}</ul>
    </section>`;
  }).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>The Hiring File — ${companies.length} companies</title>
  <style>
    :root { color-scheme: light; --ink: #1c1915; --muted: #5e574c; --line: #e4dacb; --paper: #f7f3eb; --green: #1f5c40; }
    * { box-sizing: border-box; }
    body { margin: 0; font-family: "Segoe UI", sans-serif; color: var(--ink); background: var(--paper); }
    header, main { width: min(920px, calc(100% - 32px)); margin: 0 auto; }
    header { padding: 28px 0 8px; }
    h1 { font-family: Georgia, serif; font-size: clamp(32px, 5vw, 48px); line-height: 1.05; margin: 0 0 8px; }
    .meta { color: var(--muted); margin: 0; }
    .tools { display: flex; gap: 10px; flex-wrap: wrap; margin: 22px 0; }
    input, select { font: inherit; padding: 12px 14px; border: 1px solid #cbbfaa; border-radius: 10px; background: white; }
    input { flex: 1; min-width: 220px; }
    .summary { color: var(--muted); margin-top: -8px; }
    section { margin: 22px 0 28px; }
    h2 { display: flex; justify-content: space-between; gap: 12px; font-size: 18px; border-bottom: 1px solid var(--line); padding-bottom: 8px; }
    .count { color: var(--muted); font-weight: 600; }
    ul { list-style: none; margin: 0; padding: 0; }
    li { display: flex; justify-content: space-between; gap: 16px; align-items: center; padding: 12px 0; border-bottom: 1px solid var(--line); }
    li strong { display: block; }
    li span { color: var(--muted); font-size: 14px; }
    a { color: var(--green); font-weight: 650; text-decoration: none; white-space: nowrap; }
    a:hover { text-decoration: underline; }
    footer { width: min(920px, calc(100% - 32px)); margin: 10px auto 40px; color: var(--muted); font-size: 14px; }
    @media (max-width: 640px) {
      li { align-items: flex-start; flex-direction: column; gap: 6px; }
    }
  </style>
</head>
<body>
  <header>
    <p class="meta">The Hiring File${updated ? ` · Updated ${esc(updated)}` : ''}</p>
    <h1>${companies.length} companies currently hiring</h1>
    <p class="meta">Open a company’s own careers page, confirm the role, and apply there. A real employer will not ask you to pay for a job.</p>
    <div class="tools">
      <input id="q" type="search" placeholder="Search company, city, or industry" aria-label="Search companies">
      <select id="industry" aria-label="Filter by industry">
        <option value="">All industries</option>
        ${options}
      </select>
    </div>
    <p class="summary" id="summary">Showing ${companies.length} of ${companies.length}</p>
  </header>
  <main>${sections}</main>
  <footer>
    Links go to official public careers pages. Openings change every day. This file is not affiliated with the companies listed.
  </footer>
  <script>
    const total = ${companies.length};
    const q = document.getElementById('q');
    const industry = document.getElementById('industry');
    const summary = document.getElementById('summary');
    function applyFilter() {
      const query = q.value.trim().toLowerCase();
      const selected = industry.value;
      let visible = 0;
      document.querySelectorAll('li[data-search]').forEach((row) => {
        const matchQuery = !query || row.dataset.search.includes(query);
        const matchIndustry = !selected || row.dataset.industry === selected;
        row.hidden = !(matchQuery && matchIndustry);
        if (!row.hidden) visible += 1;
      });
      document.querySelectorAll('main section').forEach((section) => {
        const rows = [...section.querySelectorAll('li')].filter((row) => !row.hidden);
        section.hidden = rows.length === 0;
        const count = section.querySelector('.count');
        if (count) count.textContent = String(rows.length);
      });
      summary.textContent = 'Showing ' + visible + ' of ' + total;
    }
    q.addEventListener('input', applyFilter);
    industry.addEventListener('change', applyFilter);
  </script>
</body>
</html>`;
}

module.exports = {
  dataFile,
  loadCatalog,
  industryCounts,
  previewCompanies,
  renderCsv,
  renderHtml
};
