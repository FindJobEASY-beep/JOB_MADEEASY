const fs = require('fs');
const path = require('path');

const SOURCE = path.join(__dirname, '..', 'data', 'India_250_Company_Job_Application_Tracker-v9.xlsx');
const OUT = path.join(__dirname, '..', 'data', 'sheets.json');

const SHEETS = [
  ['xl/worksheets/sheet1.xml', 'Direct job links', '65 live openings with a link to apply', true],
  ['xl/worksheets/sheet3.xml', '250 companies', 'Companies, roles to search, and their job boards', true],
  ['xl/worksheets/sheet4.xml', 'Openings checked', 'Roles checked on the company page', false],
  ['xl/worksheets/sheet5.xml', 'Apply portals', 'Extra places to search for India jobs', false]
];

function decode(value) {
  return String(value)
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .trim();
}

function columnIndex(letters) {
  return letters.split('').reduce((total, char) => total * 26 + char.charCodeAt(0) - 64, 0) - 1;
}

function cellValue(xml) {
  const formula = xml.match(/<f[^>]*>([\s\S]*?)<\/f>/);
  if (formula) {
    const body = decode(formula[1]);
    const link = body.match(/^HYPERLINK\("([^"]+)"\s*,\s*"([\s\S]*)"\)$/);
    if (link) return { text: decode(link[2]), href: link[1] };
    return { text: '' };
  }
  const inline = xml.match(/<t[^>]*>([\s\S]*?)<\/t>/);
  if (inline) return { text: decode(inline[1]) };
  const value = xml.match(/<v>([\s\S]*?)<\/v>/);
  if (value && value[1]) return { text: decode(value[1]) };
  return { text: '' };
}

function parseSheet(xml, personalNotes) {
  const skip = new Set(['Application status', 'Date applied']);
  if (personalNotes) skip.add('Notes');
  const table = [];
  const rowRe = /<row\b[^>]*\br="(\d+)"[^>]*>([\s\S]*?)<\/row>/g;
  let row;
  while ((row = rowRe.exec(xml))) {
    const cells = [];
    const cellRe = /<c\b[^>]*\br="([A-Z]+)\d+"[^>]*(?:\/>|>([\s\S]*?)<\/c>)/g;
    let cell;
    while ((cell = cellRe.exec(row[2] || ''))) {
      cells[columnIndex(cell[1])] = cellValue(cell[2] || '');
    }
    table.push(cells);
  }
  const headerRow = table.find((cells) => cells.some((cell) => cell && cell.text));
  if (!headerRow) return null;
  const headers = headerRow.map((cell) => (cell && cell.text) || '');
  const keep = headers.map((header) => header && !skip.has(header));
  const columns = headers.filter((_, index) => keep[index]);
  const rows = [];
  let started = false;
  for (const cells of table) {
    if (!started) {
      if (cells === headerRow) started = true;
      continue;
    }
    const values = [];
    let filled = false;
    headers.forEach((_, index) => {
      if (!keep[index]) return;
      const cell = cells[index] && cells[index].text ? cells[index] : null;
      if (cell && cell.text) filled = true;
      values.push(cell && cell.href ? { text: cell.text, href: cell.href } : (cell ? cell.text : ''));
    });
    if (filled) rows.push(values);
  }
  return { columns, rows };
}

function main() {
  const { execFileSync } = require('child_process');
  const dest = path.join(__dirname, '..', 'tmp-xlsx');
  fs.rmSync(dest, { recursive: true, force: true });
  fs.mkdirSync(dest, { recursive: true });
  execFileSync('tar', ['-xf', SOURCE, '-C', dest], { stdio: 'ignore' });
  const sheets = [];
  for (const [file, name, detail, personalNotes] of SHEETS) {
    const parsed = parseSheet(fs.readFileSync(path.join(dest, file), 'utf8'), personalNotes);
    if (!parsed) continue;
    sheets.push({ name, detail, columns: parsed.columns, rows: parsed.rows });
    console.log(`${name}: ${parsed.rows.length} rows, ${parsed.columns.length} columns`);
  }
  fs.writeFileSync(OUT, JSON.stringify({ sheets }));
  fs.rmSync(dest, { recursive: true, force: true });
}

main();
