const fs = require('fs');
const path = require('path');
const { loadCatalog } = require('../lib/catalog');

const catalog = loadCatalog();
const reportPath = path.join(__dirname, '..', 'data', 'link-report.json');
const concurrency = 12;

async function check(company) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12000);
  try {
    const response = await fetch(company.url, {
      method: 'GET',
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
      }
    });
    await response.body?.cancel();
    return { ...company, status: response.status, finalUrl: response.url };
  } catch (error) {
    const reason = error.name === 'AbortError' ? 'timeout' : (error.cause?.code || error.message);
    return { ...company, status: 0, error: reason };
  } finally {
    clearTimeout(timer);
  }
}

async function main() {
  const results = [];
  let index = 0;
  async function worker() {
    while (index < catalog.companies.length) {
      const current = catalog.companies[index];
      index += 1;
      const result = await check(current);
      results.push(result);
      const label = result.status || result.error;
      if (!(result.status >= 200 && result.status < 400) && result.status !== 401 && result.status !== 403 && result.status !== 429) {
        console.log(`FAIL ${label} ${current.name} ${current.url}`);
      }
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));
  results.sort((a, b) => a.name.localeCompare(b.name));
  fs.writeFileSync(reportPath, JSON.stringify(results, null, 2));
  const bad = results.filter((item) => !item.status || item.status >= 400 && ![401, 403, 429].includes(item.status));
  console.log(`Checked ${results.length}. Problem links: ${bad.length}. Report: data/link-report.json`);
}

main();
