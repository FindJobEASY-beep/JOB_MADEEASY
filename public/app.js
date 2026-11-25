const state = {
  priceRupees: 20,
  paymentsReady: false,
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
      <a href="${escapeHtml(company.url)}" target="_blank" rel="noopener noreferrer">Careers page</a>
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
  const hidden = catalog.total - catalog.preview.length;
  document.querySelector('[data-more]').textContent = `${hidden} more companies are in the file after payment.`;
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

async function startCheckout(name, email) {
  if (typeof Razorpay !== 'function') {
    throw new Error('Payment checkout could not load. Check your connection and refresh the page.');
  }
  const response = await fetch('/api/create-order', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, email })
  });
  if (!response.ok) throw new Error(await readError(response));
  const order = await response.json();

  await new Promise((resolve, reject) => {
    let finished = false;
    const checkout = new Razorpay({
      key: order.keyId,
      amount: order.amount,
      currency: order.currency,
      name: 'The Hiring File',
      description: 'Companies currently hiring — careers links',
      order_id: order.orderId,
      prefill: { name, email },
      theme: { color: '#9f2d20' },
      handler: async (payment) => {
        finished = true;
        try {
          const verified = await fetch('/api/verify', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payment)
          });
          if (!verified.ok) throw new Error(await readError(verified));
          remember(await verified.json());
          resolve();
        } catch (error) {
          reject(error);
        }
      },
      modal: {
        ondismiss() {
          setTimeout(() => {
            if (!finished) {
              reject(new Error('Payment window closed. If money was deducted, choose Already paid and use the Payment ID from your SMS or email.'));
            }
          }, 700);
        }
      }
    });
    checkout.on('payment.failed', (failed) => {
      reject(new Error(failed.error?.description || 'Payment failed. You can try again.'));
    });
    checkout.open();
  });
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
      setStatus('Payments are not set up yet. Add Razorpay keys in the .env file and restart the server.');
      document.querySelector('[data-setup]')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      return;
    }
    setStatus('');
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
    payDialog.close();
    setStatus('Opening the secure payment window…');
    await startCheckout(form.name.value, form.email.value);
  } catch (error) {
    setStatus(error.message);
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
  if (!/^pay_[A-Za-z0-9]{10,}$/.test(paymentId)) {
    showFormError(form, 'That Payment ID is incomplete. Copy the full ID from the Razorpay email or SMS. It starts with pay_ and then has a long mix of letters and numbers.');
    setStatus('That Payment ID is incomplete.');
    return;
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    showFormError(form, 'Enter the same email you used at checkout.');
    return;
  }
  submit.disabled = true;
  showFormError(form, '');
  try {
    const response = await fetch('/api/recover', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ paymentId, email })
    });
    if (!response.ok) throw new Error(await readError(response));
    recoverDialog.close();
    remember(await response.json());
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

  const response = await fetch('/api/catalog');
  const catalog = await response.json();
  state.priceRupees = catalog.priceRupees;
  state.paymentsReady = catalog.paymentsReady;
  fillSlots(catalog);
  renderPreview(catalog);
  renderIndustries(catalog.industries);
  document.querySelector('[data-setup]').hidden = catalog.paymentsReady;
  document.querySelector('[data-test]').hidden = !catalog.testMode;
  document.querySelectorAll('[data-open-pay]').forEach((button) => {
    button.textContent = `Pay ${rupees(catalog.priceRupees)} and unlock the list`;
  });
}

init().catch(() => {
  setStatus('The list could not be loaded. Refresh the page.');
});
