require('dotenv').config();

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const express = require('express');
const Razorpay = require('razorpay');
const { loadCatalog, industryCounts } = require('./lib/catalog');
const sheets = require('./data/sheets.json');

const PRODUCT = 'hiring-file';
const PORT = Number(process.env.PORT) || 3000;
const TOKEN_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_DOWNLOADS = 8;
const GRANTS_FILE = path.join(__dirname, 'data', 'grants.json');
const PAYMENTS_FILE = path.join(__dirname, 'data', 'payments.json');
const REQUESTS_FILE = path.join(__dirname, 'data', 'requests.json');
const PAYEE_FILE = path.join(__dirname, 'data', 'payee.json');

const catalog = loadCatalog();
const buckets = new Map();

function priceRupees() {
  const value = Number(process.env.PRICE_RUPEES || 20);
  if (!Number.isInteger(value) || value < 1 || value > 100000) return 20;
  return value;
}

function pricePaise() {
  return priceRupees() * 100;
}

function razorpayConfigured() {
  const keyId = process.env.RAZORPAY_KEY_ID || '';
  const keySecret = process.env.RAZORPAY_KEY_SECRET || '';
  return keyId.startsWith('rzp_') && keySecret.length > 8 && !keyId.includes('your_key');
}

function paymentProvider() {
  return razorpayConfigured() ? 'razorpay' : '';
}

function paymentsConfigured() {
  return razorpayConfigured();
}

function razorpayClient() {
  if (!razorpayConfigured()) return null;
  return new Razorpay({
    key_id: process.env.RAZORPAY_KEY_ID,
    key_secret: process.env.RAZORPAY_KEY_SECRET
  });
}

function clientIp(req) {
  return req.ip || req.socket.remoteAddress || 'unknown';
}

function allow(key, limit, windowMs) {
  const now = Date.now();
  const recent = (buckets.get(key) || []).filter((time) => now - time < windowMs);
  if (recent.length >= limit) {
    buckets.set(key, recent);
    return false;
  }
  recent.push(now);
  buckets.set(key, recent);
  return true;
}

function safeEqual(left, right) {
  const a = Buffer.from(String(left));
  const b = Buffer.from(String(right));
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function cleanName(value) {
  const name = String(value || '').replace(/[\u0000-\u001F]/g, '').trim();
  if (name.length < 2 || name.length > 80) return '';
  return name;
}

function cleanEmail(value) {
  const email = String(value || '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 120) return '';
  return email;
}

function cleanUpi(value) {
  const upi = String(value || '').trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]{1,255}@[a-z]{2,64}$/.test(upi)) return '';
  return upi;
}

function cleanReference(value) {
  const reference = String(value || '').trim().toLowerCase();
  return /^hf[a-f0-9]{10}$/.test(reference) ? reference : '';
}

function isRazorpayId(value, prefix) {
  return typeof value === 'string' && value.startsWith(prefix) && /^[A-Za-z0-9_]+$/.test(value) && value.length < 80;
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(file, value) {
  fs.writeFileSync(file, JSON.stringify(value, null, 2));
}

function onNetlify() {
  return Boolean(process.env.NETLIFY || process.env.AWS_LAMBDA_FUNCTION_NAME || process.env.LAMBDA_TASK_ROOT);
}

async function readRecord(name, file, fallback) {
  if (!onNetlify()) return readJson(file, fallback);
  const { getStore } = require('@netlify/blobs');
  const value = await getStore('hiring-file').get(name, { type: 'json' });
  return value == null ? fallback : value;
}

async function writeRecord(name, file, value) {
  if (!onNetlify()) {
    writeJson(file, value);
    return;
  }
  const { getStore } = require('@netlify/blobs');
  await getStore('hiring-file').setJSON(name, value);
}

async function loadGrants() {
  const grants = await readRecord('grants', GRANTS_FILE, { byToken: {}, byPayment: {} });
  if (!grants.byToken || !grants.byPayment) return { byToken: {}, byPayment: {} };
  const now = Date.now();
  for (const [token, grant] of Object.entries(grants.byToken)) {
    if (!grant || grant.expiresAt < now) {
      delete grants.byToken[token];
      if (grant && grants.byPayment[grant.paymentId] === token) delete grants.byPayment[grant.paymentId];
    }
  }
  return grants;
}

async function issueToken(paymentId, email) {
  const grants = await loadGrants();
  const existing = grants.byPayment[paymentId];
  if (existing && grants.byToken[existing]) {
    return { token: existing, expiresAt: grants.byToken[existing].expiresAt, paymentId };
  }
  const token = crypto.randomBytes(24).toString('hex');
  const expiresAt = Date.now() + TOKEN_TTL_MS;
  grants.byToken[token] = { paymentId, email, expiresAt, downloads: 0 };
  grants.byPayment[paymentId] = token;
  await writeRecord('grants', GRANTS_FILE, grants);
  return { token, expiresAt, paymentId };
}

async function consumeDownload(token) {
  if (typeof token !== 'string' || !/^[a-f0-9]{48}$/.test(token)) return null;
  const grants = await loadGrants();
  const grant = grants.byToken[token];
  if (!grant || grant.expiresAt < Date.now()) return null;
  if (grant.downloads >= MAX_DOWNLOADS) return null;
  grant.downloads += 1;
  await writeRecord('grants', GRANTS_FILE, grants);
  return grant;
}

async function currentPayee() {
  const saved = await readRecord('payee', PAYEE_FILE, null);
  const upi = cleanUpi(saved?.upi || process.env.UPI_ID || '');
  const name = cleanName(saved?.name || process.env.UPI_NAME || 'The Hiring File') || 'The Hiring File';
  return upi ? { upi, name } : null;
}

function upiLink(payee, reference) {
  const query = [
    ['pa', payee.upi],
    ['pn', payee.name],
    ['am', priceRupees().toFixed(2)],
    ['cu', 'INR'],
    ['tn', `Hiring list ${reference}`]
  ].map(([key, value]) => `${key}=${encodeURIComponent(value)}`).join('&');
  return `upi://pay?${query}`;
}

async function loadRequests() {
  const list = await readRecord('requests', REQUESTS_FILE, []);
  return Array.isArray(list) ? list : [];
}

async function saveRequests(list) {
  await writeRecord('requests', REQUESTS_FILE, list.slice(-300));
}

function adminPassword() {
  const password = String(process.env.ADMIN_PASSWORD || '');
  return password.length >= 8 ? password : '';
}

function signAdmin(expiresAt) {
  const body = String(expiresAt);
  const signature = crypto.createHmac('sha256', adminPassword()).update(body).digest('hex');
  return `${body}.${signature}`;
}

function adminOk(req) {
  if (!adminPassword()) return false;
  const header = req.get('authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  const [expiresAt, signature] = token.split('.');
  if (!/^\d+$/.test(expiresAt || '') || !/^[a-f0-9]{64}$/.test(signature || '')) return false;
  if (Number(expiresAt) < Date.now()) return false;
  const expected = crypto.createHmac('sha256', adminPassword()).update(expiresAt).digest('hex');
  return safeEqual(expected, signature);
}

function publicRequest(request) {
  return {
    id: request.id,
    name: request.name,
    email: request.email,
    amount: request.amount,
    status: request.status,
    createdAt: request.createdAt,
    decidedAt: request.decidedAt || ''
  };
}

async function logPayment(entry) {
  const payments = await readRecord('payments', PAYMENTS_FILE, []);
  const list = Array.isArray(payments) ? payments : [];
  if (!list.some((item) => item.paymentId === entry.paymentId)) {
    list.push(entry);
    await writeRecord('payments', PAYMENTS_FILE, list);
  }
}

async function confirmedPayment(rp, paymentId, orderId) {
  const payment = await rp.payments.fetch(paymentId);
  if (!payment || (orderId && payment.order_id !== orderId)) return null;
  if (!['captured', 'authorized'].includes(payment.status)) return null;
  if (Number(payment.amount) !== pricePaise() || payment.currency !== 'INR') return null;

  const order = await rp.orders.fetch(payment.order_id);
  if (!order || Number(order.amount) !== pricePaise() || order.currency !== 'INR') return null;
  if (String(order.notes?.product || '') !== PRODUCT) return null;
  return { payment, order };
}

const app = express();
app.disable('x-powered-by');
if (process.env.TRUST_PROXY === '1' || process.env.NETLIFY === 'true') app.set('trust proxy', 1);

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'DENY');
  next();
});

app.post('/api/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const secret = process.env.RAZORPAY_WEBHOOK_SECRET || '';
  const signature = req.get('x-razorpay-signature') || '';
  if (!secret || !signature) return res.status(400).json({ error: 'Webhook is not configured' });

  const expected = crypto.createHmac('sha256', secret).update(req.body).digest('hex');
  if (!safeEqual(expected, signature)) return res.status(400).json({ error: 'Invalid signature' });

  try {
    const event = JSON.parse(req.body.toString('utf8'));
    const payment = event?.payload?.payment?.entity;
    if (event.event === 'payment.captured' && payment?.id) {
      const rp = razorpayClient();
      if (rp) {
        const confirmed = await confirmedPayment(rp, payment.id);
        if (confirmed) {
          await logPayment({
            paymentId: payment.id,
            orderId: payment.order_id,
            email: String(confirmed.order.notes?.email || ''),
            name: String(confirmed.order.notes?.name || ''),
            amount: pricePaise(),
            at: new Date().toISOString(),
            source: 'webhook'
          });
        }
      }
    }
  } catch (error) {
    console.error('Webhook error:', error.message);
  }
  res.json({ ok: true });
});

app.use(express.json({ limit: '20kb' }));
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/health', (req, res) => {
  res.json({ ok: true, companies: catalog.companies.length });
});

function cellText(value) {
  if (value && typeof value === 'object') return value.text || '';
  return value == null ? '' : String(value);
}

function directPreview(limit = 5) {
  const sheet = (sheets.sheets || []).find((item) => item.name === 'Direct job links');
  if (!sheet) return [];
  const index = Object.fromEntries(sheet.columns.map((name, position) => [name, position]));
  const seen = new Set();
  const picked = [];
  for (const row of sheet.rows) {
    const name = cellText(row[index.Company]).trim();
    const link = row[index['Direct Job Apply Link (Click to Open)']];
    const url = link && typeof link === 'object' ? String(link.href || '') : '';
    if (!name || !url.startsWith('http') || seen.has(name)) continue;
    seen.add(name);
    picked.push({
      name,
      industry: cellText(row[index.Category]),
      location: cellText(row[index.Location]),
      url
    });
    if (picked.length === limit) break;
  }
  return picked;
}

app.get('/api/catalog', async (req, res) => {
  const preview = directPreview(5);
  const payee = await currentPayee();
  res.json({
    total: catalog.companies.length,
    updated: catalog.updated,
    priceRupees: priceRupees(),
    currency: 'INR',
    provider: 'qr',
    paymentsReady: Boolean(payee),
    testMode: false,
    upi: payee ? payee.upi : '',
    payeeName: payee ? payee.name : '',
    industries: industryCounts(catalog.companies),
    preview
  });
});

app.post('/api/pay-request', async (req, res) => {
  if (!allow(`pay:${clientIp(req)}`, 8, 10 * 60 * 1000)) {
    return res.status(429).json({ error: 'Too many attempts. Wait a few minutes and try again.' });
  }
  const payee = await currentPayee();
  if (!payee) return res.status(503).json({ error: 'The QR code is not ready yet.' });
  const name = cleanName(req.body?.name);
  const email = cleanEmail(req.body?.email);
  if (!name || !email) {
    return res.status(400).json({ error: 'Enter your name and a valid email.' });
  }
  const requests = await loadRequests();
  const recent = requests.find((item) => (
    item.email === email && item.status === 'pending' && Date.now() - Date.parse(item.createdAt) < 30 * 60 * 1000
  ));
  const request = recent || {
    id: `hf${crypto.randomBytes(5).toString('hex')}`,
    name,
    email,
    amount: priceRupees(),
    status: 'pending',
    createdAt: new Date().toISOString()
  };
  if (!recent) {
    requests.push(request);
    await saveRequests(requests);
  }
  res.json({
    id: request.id,
    amount: request.amount,
    upi: payee.upi,
    payeeName: payee.name,
    link: upiLink(payee, request.id),
    status: request.status
  });
});

app.post('/api/pay-status', async (req, res) => {
  if (!allow(`status:${clientIp(req)}`, 40, 10 * 60 * 1000)) {
    return res.status(429).json({ error: 'Too many attempts. Wait a few minutes and try again.' });
  }
  const id = cleanReference(req.body?.id);
  const email = cleanEmail(req.body?.email);
  if (!id || !email) return res.status(400).json({ error: 'Enter the reference and the same email.' });
  const request = (await loadRequests()).find((item) => item.id === id && item.email === email);
  if (!request) {
    return res.status(404).json({ error: 'That reference could not be found for this email.' });
  }
  if (request.status === 'rejected') {
    return res.status(402).json({ error: 'This payment was not confirmed. Pay again and use a new reference.' });
  }
  if (request.status !== 'approved') return res.json({ status: 'pending', id });
  const access = await issueToken(request.id, request.email);
  res.json({ status: 'approved', ...access });
});

app.post('/api/admin/login', (req, res) => {
  if (!allow(`admin:${clientIp(req)}`, 8, 10 * 60 * 1000)) {
    return res.status(429).json({ error: 'Too many attempts. Wait a few minutes and try again.' });
  }
  if (!adminPassword()) return res.status(503).json({ error: 'The admin password is not set on the server.' });
  const password = String(req.body?.password || '');
  const left = Buffer.from(password);
  const right = Buffer.from(adminPassword());
  if (left.length !== right.length || !crypto.timingSafeEqual(left, right)) {
    return res.status(401).json({ error: 'That password is not correct.' });
  }
  const expiresAt = Date.now() + 12 * 60 * 60 * 1000;
  res.json({ token: signAdmin(expiresAt), expiresAt });
});

app.get('/api/admin/requests', async (req, res) => {
  if (!adminOk(req)) return res.status(401).json({ error: 'Sign in again.' });
  const payee = await currentPayee();
  const requests = await loadRequests();
  res.json({
    payee: payee || { upi: '', name: '' },
    requests: requests.slice().reverse().map(publicRequest)
  });
});

app.post('/api/admin/payee', async (req, res) => {
  if (!adminOk(req)) return res.status(401).json({ error: 'Sign in again.' });
  const upi = cleanUpi(req.body?.upi);
  const name = cleanName(req.body?.name || 'The Hiring File');
  if (!upi || !name) {
    return res.status(400).json({ error: 'Enter a UPI ID such as name@bank, and the name shown on the QR.' });
  }
  await writeRecord('payee', PAYEE_FILE, { upi, name });
  res.json({ upi, name });
});

app.post('/api/admin/requests/:id/decide', async (req, res) => {
  if (!adminOk(req)) return res.status(401).json({ error: 'Sign in again.' });
  const id = cleanReference(req.params.id);
  const decision = req.body?.decision === 'approved' ? 'approved' : req.body?.decision === 'rejected' ? 'rejected' : '';
  if (!id || !decision) return res.status(400).json({ error: 'Choose confirm or reject.' });
  const requests = await loadRequests();
  const request = requests.find((item) => item.id === id);
  if (!request) return res.status(404).json({ error: 'That payment request was not found.' });
  request.status = decision;
  request.decidedAt = new Date().toISOString();
  await saveRequests(requests);
  if (decision === 'approved') await issueToken(request.id, request.email);
  res.json(publicRequest(request));
});

app.post('/api/create-order', async (req, res) => {
  if (!allow(`order:${clientIp(req)}`, 8, 10 * 60 * 1000)) {
    return res.status(429).json({ error: 'Too many payment attempts. Wait a few minutes and try again.' });
  }
  if (!paymentsConfigured()) {
    return res.status(503).json({
      error: 'Payments are not set up yet. Add the payment keys and restart the server.'
    });
  }

  const name = cleanName(req.body?.name);
  const email = cleanEmail(req.body?.email);
  if (!name || !email) {
    return res.status(400).json({ error: 'Enter your name and a valid email. The receipt uses this email.' });
  }
  const rp = razorpayClient();
  if (!rp) {
    return res.status(503).json({ error: 'Payments are not set up yet.' });
  }

  try {
    const order = await rp.orders.create({
      amount: pricePaise(),
      currency: 'INR',
      receipt: `hf${Date.now()}`.slice(0, 40),
      notes: {
        product: PRODUCT,
        email,
        name: name.slice(0, 60)
      }
    });
    res.json({
      keyId: process.env.RAZORPAY_KEY_ID,
      orderId: order.id,
      amount: order.amount,
      currency: order.currency
    });
  } catch (error) {
    console.error('Create order failed:', error.message);
    res.status(502).json({ error: 'Could not start the payment. Check the Razorpay keys and try again.' });
  }
});

app.post('/api/verify', async (req, res) => {
  if (!allow(`verify:${clientIp(req)}`, 12, 10 * 60 * 1000)) {
    return res.status(429).json({ error: 'Too many attempts. Wait a few minutes and try again.' });
  }
  const rp = razorpayClient();
  if (!rp) return res.status(503).json({ error: 'Payments are not set up yet.' });

  const orderId = req.body?.razorpay_order_id;
  const paymentId = req.body?.razorpay_payment_id;
  const signature = req.body?.razorpay_signature;
  if (!isRazorpayId(orderId, 'order_') || !isRazorpayId(paymentId, 'pay_') || !/^[a-f0-9]{64}$/i.test(signature || '')) {
    return res.status(400).json({ error: 'Payment confirmation was incomplete.' });
  }

  const expected = crypto
    .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
    .update(`${orderId}|${paymentId}`)
    .digest('hex');
  if (!safeEqual(expected, signature)) {
    return res.status(400).json({ error: 'Payment could not be verified.' });
  }

  try {
    const confirmed = await confirmedPayment(rp, paymentId, orderId);
    if (!confirmed) return res.status(402).json({ error: 'Payment is not confirmed for this list yet.' });
    const email = String(confirmed.order.notes?.email || '');
    await logPayment({
      paymentId,
      orderId,
      email,
      name: String(confirmed.order.notes?.name || ''),
      amount: pricePaise(),
      at: new Date().toISOString(),
      source: 'checkout'
    });
    res.json(await issueToken(paymentId, email));
  } catch (error) {
    console.error('Verify failed:', error.message);
    res.status(502).json({ error: 'Payment was received but could not be checked yet. Use Already paid in a minute.' });
  }
});

app.post('/api/recover', async (req, res) => {
  if (!allow(`recover:${clientIp(req)}`, 6, 10 * 60 * 1000)) {
    return res.status(429).json({ error: 'Too many attempts. Wait a few minutes and try again.' });
  }
  const rp = razorpayClient();
  if (!rp) return res.status(503).json({ error: 'Payments are not set up yet.' });

  const paymentId = req.body?.paymentId;
  const email = cleanEmail(req.body?.email);
  if (!isRazorpayId(paymentId, 'pay_') || !email) {
    return res.status(400).json({ error: 'Enter the Payment ID and the same email you used to pay.' });
  }

  try {
    const confirmed = await confirmedPayment(rp, paymentId);
    const noteEmail = String(confirmed?.order?.notes?.email || '').toLowerCase();
    if (!confirmed || noteEmail !== email) {
      return res.status(402).json({
        error: 'That payment could not be confirmed for this email. Use the Payment ID from Razorpay and the same email you paid with.'
      });
    }
    res.json(await issueToken(paymentId, email));
  } catch (error) {
    console.error('Recover failed:', error?.error?.description || error?.message || error);
    res.status(402).json({ error: 'That payment could not be confirmed. Check the Payment ID and email.' });
  }
});

async function validGrant(token) {
  if (typeof token !== 'string' || !/^[a-f0-9]{48}$/.test(token)) return null;
  const grants = await loadGrants();
  const grant = grants.byToken[token];
  if (!grant || grant.expiresAt < Date.now()) return null;
  return grant;
}

app.post('/api/list', async (req, res) => {
  if (!allow(`list:${clientIp(req)}`, 40, 10 * 60 * 1000)) {
    return res.status(429).json({ error: 'Too many attempts. Wait a few minutes and try again.' });
  }
  const grant = await validGrant(req.body?.token);
  if (!grant) {
    return res.status(401).json({
      error: 'This list is locked. Pay ₹20, or choose Already paid and enter your Payment ID.'
    });
  }
  res.setHeader('Cache-Control', 'no-store');
  res.json({ sheets: sheets.sheets });
});

app.use((error, req, res, next) => {
  if (error?.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'Invalid request' });
  }
  console.error(error);
  res.status(500).json({ error: 'Something went wrong. Try again.' });
});

if (require.main === module) {
  app.listen(PORT, () => {
    const provider = paymentProvider();
    const ready = provider ? `${provider} connected` : 'Payment keys missing — preview works, payment does not';
    console.log(`The Hiring File is running at http://localhost:${PORT}`);
    console.log(`${catalog.companies.length} companies · ₹${priceRupees()} · ${ready}`);
    if (catalog.companies.length < 200) {
      console.warn('The list has fewer than 200 companies. Add more in data/companies.json.');
    }
  });
}

module.exports = app;
