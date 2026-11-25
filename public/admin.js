const loginPanel = document.querySelector('#login');
const desk = document.querySelector('#desk');
const queue = document.querySelector('#queue');
const rows = document.querySelector('[data-rows]');

function token() {
  const saved = sessionStorage.getItem('hiring-file-admin');
  if (!saved) return '';
  try {
    const session = JSON.parse(saved);
    if (session.expiresAt > Date.now() && session.token) return session.token;
  } catch {
    sessionStorage.removeItem('hiring-file-admin');
  }
  return '';
}

function showError(form, message) {
  const error = form.querySelector('[data-error]');
  error.hidden = !message;
  error.textContent = message || '';
}

async function readError(response) {
  try {
    const data = await response.json();
    return data.error || 'Something went wrong.';
  } catch {
    return 'Something went wrong.';
  }
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

async function loadDesk() {
  const response = await fetch('/api/admin/requests', {
    headers: { Authorization: `Bearer ${token()}` }
  });
  if (response.status === 401) {
    sessionStorage.removeItem('hiring-file-admin');
    loginPanel.hidden = false;
    desk.hidden = true;
    queue.hidden = true;
    return;
  }
  if (!response.ok) throw new Error(await readError(response));
  const data = await response.json();
  loginPanel.hidden = true;
  desk.hidden = false;
  queue.hidden = false;
  const form = document.querySelector('#upi-form');
  form.upi.value = data.payee?.upi || '';
  form.name.value = data.payee?.name || 'The Hiring File';
  const list = data.requests || [];
  rows.innerHTML = list.length ? `
    <table class="admin-table">
      <thead>
        <tr><th>When</th><th>Name</th><th>Email</th><th>Reference</th><th>Status</th><th></th></tr>
      </thead>
      <tbody>
        ${list.map((item) => `
          <tr>
            <td>${escapeHtml(new Date(item.createdAt).toLocaleString('en-IN'))}</td>
            <td>${escapeHtml(item.name)}</td>
            <td>${escapeHtml(item.email)}</td>
            <td><code>${escapeHtml(item.id)}</code></td>
            <td>${escapeHtml(item.status)}</td>
            <td>
              ${item.status === 'pending' ? `
                <div class="admin-actions">
                  <button class="pay" type="button" data-decide="approved" data-id="${escapeHtml(item.id)}">Confirm</button>
                  <button class="secondary" type="button" data-decide="rejected" data-id="${escapeHtml(item.id)}">Reject</button>
                </div>` : ''}
            </td>
          </tr>
        `).join('')}
      </tbody>
    </table>
  ` : '<p>No payments yet. They appear here after someone scans the QR and enters an email.</p>';
}

document.querySelector('#login-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const submit = form.querySelector('button[type="submit"]');
  submit.disabled = true;
  showError(form, '');
  try {
    const response = await fetch('/api/admin/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: form.password.value })
    });
    if (!response.ok) throw new Error(await readError(response));
    const session = await response.json();
    sessionStorage.setItem('hiring-file-admin', JSON.stringify(session));
    form.reset();
    await loadDesk();
  } catch (error) {
    showError(form, error.message);
  } finally {
    submit.disabled = false;
  }
});

document.querySelector('#upi-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const submit = form.querySelector('button[type="submit"]');
  submit.disabled = true;
  showError(form, '');
  try {
    const response = await fetch('/api/admin/payee', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token()}`
      },
      body: JSON.stringify({ upi: form.upi.value, name: form.name.value })
    });
    if (!response.ok) throw new Error(await readError(response));
    showError(form, '');
    form.querySelector('button[type="submit"]').textContent = 'Saved';
  } catch (error) {
    showError(form, error.message);
  } finally {
    submit.disabled = false;
  }
});

rows.addEventListener('click', async (event) => {
  const button = event.target.closest('[data-decide]');
  if (!button) return;
  button.disabled = true;
  try {
    const response = await fetch(`/api/admin/requests/${button.dataset.id}/decide`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token()}`
      },
      body: JSON.stringify({ decision: button.dataset.decide })
    });
    if (!response.ok) throw new Error(await readError(response));
    await loadDesk();
  } catch (error) {
    button.disabled = false;
    alert(error.message);
  }
});

if (token()) {
  loadDesk().catch((error) => {
    const form = document.querySelector('#login-form');
    showError(form, error.message);
  });
}
