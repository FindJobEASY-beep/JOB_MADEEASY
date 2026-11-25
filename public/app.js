const state = {
  priceRupees: 20,
  paymentsReady: false,
  provider: 'razorpay',
  token: '',
  paymentId: ''
};

const statusEl = document.querySelector('[data-status]');
const payDialog = document.querySelector('#pay-dialog');
const recoverDialog = document.querySelector('#recover-dialog');
const readyDialog = document.querySelector('#ready-dialog');

function rupees(amount) {
  return `₹${Number(amount).toLocaleString('en-IN')}`;
}

function setStatus(message, ok = false) {
  statusEl.textContent = message || '';
  statusEl.classList.toggle('ok', Boolean(ok && message));
}

function fillSlots(catalog) {
  document.querySelectorAll('[data-slot="count"]').forEach((node) => {
    node.textContent = String(catalog.total);
  });
  document.querySelectorAll('[data-slot="price"]').forEach((node) => {
    node.textContent = rupees(catalog.priceRupees);
  });
  const updated = document.querySelector('[data-slot="updated"]');
  if (updated && catalog.updated) updated.textContent = `Updated ${catalog.updated}`;
  const industryCount = document.querySelector('[data-slot="industries"]');
  if (industryCount) industryCount.textContent = String(catalog.industries.length);
  document.title = `The Hiring File — ${catalog.total} companies currently hiring`;
}

function renderPreview(catalog) {
  const mount = document.querySelector('[data-preview]');
  const rows = catalog.preview.map((company) => `
    <div class="row">
      <strong>${escapeHtml(company.name)}</strong>
      <span>${escapeHtml(company.industry)}</span>
      <span>${escapeHtml(company.location)}</span>
      <a href="${escapeHtml(company.url)}" target="_blank" rel="noopener noreferrer">Apply</a>
    </div>
  `).join('');
  const locked = Array.from({ length: 3 }, () => `
    <div class="locked" aria-hidden="true">
      <strong>Locked company name</strong>
      <span>Industry</span>
      <span>City</span>
      <span>Link locked</span>
    </div>
  `).join('');
  mount.innerHTML = rows + locked;
  document.querySelector('[data-more]').textContent = 'The rest of the direct job links open on this page after purchase.';
}

function renderIndustries(industries) {
  document.querySelector('[data-industries]').innerHTML = industries
    .map((item) => `<span>${escapeHtml(item.name)} <b>${item.count}</b></span>`)
    .join('');
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  })[char]);
}

function showReady(paymentId) {
  document.querySelector('[data-ready]').hidden = false;
  if (paymentId) document.querySelector('[data-payment-id]').textContent = paymentId;
}

function remember(access) {
  state.token = access.token;
  state.paymentId = access.paymentId;
  sessionStorage.setItem('hiring-file-access', JSON.stringify({
    token: access.token,
    paymentId: access.paymentId,
    expiresAt: access.expiresAt
  }));
  showReady(access.paymentId);
  if (!readyDialog.open) readyDialog.showModal();
  setStatus('Payment confirmed. The list is open on this page.', true);
  loadList().catch((error) => setStatus(error.message));
}

async function readError(response) {
  try {
    const data = await response.json();
    return data.error || 'Something went wrong.';
  } catch {
    return 'Something went wrong.';
  }
}

let pollTimer = 0;

function showQrStep(request) {
  const details = document.querySelector('[data-pay-step="details"]');
  const qrStep = document.querySelector('[data-pay-step="qr"]');
  details.hidden = true;
  qrStep.hidden = false;
  document.querySelector('[data-reference]').textContent = request.id;
  document.querySelector('[data-upi]').textContent = request.upi;
  const canvas = document.querySelector('[data-qr]');
  if (typeof QRCode !== 'undefined') {
    QRCode.toCanvas(canvas, request.link, { width: 220, margin: 1 });
  }
  sessionStorage.setItem('hiring-file-pending', JSON.stringify({ id: request.id, email: request.email }));
  pollStatus(request.id, request.email);
}

async function pollStatus(id, email) {
  clearInterval(pollTimer);
  const check = async () => {
    const response = await fetch('/api/pay-status', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, email })
    });
    if (response.status === 402) {
      clearInterval(pollTimer);
      sessionStorage.removeItem('hiring-file-pending');
      const wait = document.querySelector('[data-wait]');
      if (wait) wait.textContent = await readError(response);
      return;
    }
    if (!response.ok) return;
    const data = await response.json();
    if (data.status !== 'approved') return;
    clearInterval(pollTimer);
    sessionStorage.removeItem('hiring-file-pending');
    if (payDialog.open) payDialog.close();
    remember(data);
  };
  await check();
  pollTimer = setInterval(() => {
    check().catch(() => {});
  }, 4000);
}

const listState = { sheets: [], active: 0 };

function cellText(value) {
  if (value && typeof value === 'object') return value.text || '';
  return value == null ? '' : String(value);
}

function renderCell(value) {
  const text = cellText(value);
  if (!text) return '';
  if (value && typeof value === 'object' && /^https?:\/\//i.test(value.href || '')) {
    return `<a href="${escapeHtml(value.href)}" target="_blank" rel="noopener noreferrer">${escapeHtml(text)}</a>`;
  }
  return escapeHtml(text);
}

function renderList() {
  const sheet = listState.sheets[listState.active];
  const tabs = document.querySelector('[data-tabs]');
  const table = document.querySelector('[data-table]');
  const detail = document.querySelector('[data-sheet-detail]');
  if (!sheet || !tabs || !table) return;
  const query = (document.querySelector('[data-search]')?.value || '').trim().toLowerCase();
  tabs.innerHTML = listState.sheets.map((item, index) => `
    <button type="button" class="${index === listState.active ? 'on' : ''}" data-tab="${index}">${escapeHtml(item.name)} <b>${item.rows.length}</b></button>
  `).join('');
  if (detail) detail.textContent = sheet.detail || '';
  const rows = sheet.rows.filter((row) => !query || row.some((cell) => cellText(cell).toLowerCase().includes(query)));
  const head = sheet.columns.map((column) => `<th>${escapeHtml(column)}</th>`).join('');
  const body = rows.map((row) => `<tr>${row.map((cell) => `<td>${renderCell(cell)}</td>`).join('')}</tr>`).join('');
  table.innerHTML = `
    <table>
      <thead><tr>${head}</tr></thead>
      <tbody>${body || `<tr><td colspan="${sheet.columns.length}">No matching rows.</td></tr>`}</tbody>
    </table>
  `;
}

async function loadList() {
  let response;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    response = await fetch('/api/list', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: state.token })
    });
    if (response.ok || response.status !== 401 || attempt === 3) break;
    await new Promise((resolve) => setTimeout(resolve, 800));
  }
  if (!response.ok) {
    sessionStorage.removeItem('hiring-file-access');
    state.token = '';
    document.querySelector('[data-ready]').hidden = true;
    document.querySelector('[data-list]').hidden = true;
    throw new Error(await readError(response));
  }
  const data = await response.json();
  listState.sheets = data.sheets || [];
  listState.active = 0;
  document.querySelector('[data-list]').hidden = false;
  renderList();
}

document.querySelectorAll('[data-open-pay]').forEach((button) => {
  button.addEventListener('click', () => {
    if (!state.paymentsReady) {
      setStatus('The QR code is not ready yet. Add the UPI ID on the admin page, then refresh.');
      document.querySelector('[data-setup]')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      return;
    }
    setStatus('');
    document.querySelector('[data-pay-step="details"]').hidden = false;
    document.querySelector('[data-pay-step="qr"]').hidden = true;
    payDialog.showModal();
  });
});

document.querySelectorAll('[data-open-recover]').forEach((button) => {
  button.addEventListener('click', () => {
    setStatus('');
    recoverDialog.showModal();
  });
});

document.querySelector('[data-tabs]')?.addEventListener('click', (event) => {
  const button = event.target.closest('[data-tab]');
  if (!button) return;
  listState.active = Number(button.dataset.tab);
  renderList();
});

document.querySelector('[data-search]')?.addEventListener('input', () => renderList());

document.querySelectorAll('[data-close]').forEach((button) => {
  button.addEventListener('click', () => button.closest('dialog').close());
});

function showFormError(form, message) {
  const error = form.querySelector('[data-error]');
  error.hidden = !message;
  error.textContent = message || '';
}

document.querySelector('#pay-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const submit = form.querySelector('button[type="submit"]');
  submit.disabled = true;
  showFormError(form, '');
  try {
    const response = await fetch('/api/pay-request', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: form.name.value, email: form.email.value })
    });
    if (!response.ok) throw new Error(await readError(response));
    const request = await response.json();
    showQrStep({ ...request, email: form.email.value.trim().toLowerCase() });
  } catch (error) {
    showFormError(form, error.message);
  } finally {
    submit.disabled = false;
  }
});

document.querySelector('#recover-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const submit = form.querySelector('button[type="submit"]');
  const paymentId = form.paymentId.value.trim();
  const email = form.email.value.trim();
  if (!/^hf[a-f0-9]{10}$/i.test(paymentId)) {
    showFormError(form, 'That reference is incomplete. Copy it from the QR window. It starts with hf.');
    setStatus('That reference is incomplete.');
    return;
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    showFormError(form, 'Enter the same email you used at checkout.');
    return;
  }
  submit.disabled = true;
  showFormError(form, '');
  try {
    const response = await fetch('/api/pay-status', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: paymentId, email })
    });
    if (!response.ok) throw new Error(await readError(response));
    const data = await response.json();
    if (data.status !== 'approved') {
      showFormError(form, 'This payment is still waiting to be confirmed.');
      return;
    }
    recoverDialog.close();
    remember(data);
  } catch (error) {
    showFormError(form, error.message);
    setStatus(error.message);
  } finally {
    submit.disabled = false;
  }
});

async function init() {
  const saved = sessionStorage.getItem('hiring-file-access');
  if (saved) {
    try {
      const access = JSON.parse(saved);
      if (access.expiresAt > Date.now() && access.token) {
        state.token = access.token;
        state.paymentId = access.paymentId;
        showReady(access.paymentId);
        setStatus('Your list is still open on this browser.', true);
        loadList().catch(() => {
          sessionStorage.removeItem('hiring-file-access');
          state.token = '';
          document.querySelector('[data-ready]').hidden = true;
        });
      }
    } catch {
      sessionStorage.removeItem('hiring-file-access');
    }
  }

  const pending = sessionStorage.getItem('hiring-file-pending');
  if (pending && !state.token) {
    try {
      const savedRequest = JSON.parse(pending);
      if (savedRequest.id && savedRequest.email) pollStatus(savedRequest.id, savedRequest.email);
    } catch {
      sessionStorage.removeItem('hiring-file-pending');
    }
  }

  const response = await fetch('/api/catalog');
  const catalog = await response.json();
  state.priceRupees = catalog.priceRupees;
  state.paymentsReady = catalog.paymentsReady;
  state.provider = catalog.provider || '';
  fillSlots(catalog);
  renderPreview(catalog);
  renderIndustries(catalog.industries);
  document.querySelector('[data-setup]').hidden = catalog.paymentsReady;
  document.querySelectorAll('[data-open-pay]').forEach((button) => {
    button.textContent = 'Unlock the list';
  });
}

init().catch(() => {
  setStatus('The list could not be loaded. Refresh the page.');
});
