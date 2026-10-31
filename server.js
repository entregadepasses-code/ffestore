'use strict';
const express = require('express');
const crypto = require('crypto');
const path = require('path');
const { Pool } = require('pg');

const {
  AUTOSYSTEM_API_KEY, MERCADOPAGO_ACCESS_TOKEN, ADMIN_PASSWORD, DATABASE_URL,
} = process.env;
const PORT = process.env.PORT || 3000;
const BASE_URL = (process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || '').replace(/\/$/, '');
const AUTO_BASE = 'https://autolikesystem.com.br/v1';
const PIX_MINUTES = 30;
const IS_PROD = process.env.NODE_ENV === 'production';
const SUPPORT_URL = 'https://wa.me/5549999163265';

const missing = () => ['AUTOSYSTEM_API_KEY', 'MERCADOPAGO_ACCESS_TOKEN', 'ADMIN_PASSWORD', 'DATABASE_URL']
  .filter((k) => !process.env[k]).concat(BASE_URL ? [] : ['PUBLIC_URL']);

if (!DATABASE_URL) { console.error('DATABASE_URL não configurada. Encerrando.'); process.exit(1); }
const local = /localhost|127\.0\.0\.1/.test(DATABASE_URL);
const pool = new Pool({ connectionString: DATABASE_URL, ssl: local || process.env.PGSSL === 'disable' ? false : { rejectUnauthorized: false } });
const q = (text, params) => pool.query(text, params);

// ---------- util ----------
async function log(level, message, data) {
  console[level === 'error' ? 'error' : 'log'](`[${level}] ${message}`, data ? JSON.stringify(data).slice(0, 500) : '');
  try { await q('INSERT INTO events(level,message,data) VALUES($1,$2,$3)', [level, message, data ? JSON.stringify(data) : null]); } catch (_) { /* ignore */ }
}
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const safeEq = (a, b) => { const x = Buffer.from(String(a)); const y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };
const hits = new Map();
function limit(name, max, windowMs) {
  return (req, res, next) => {
    const k = `${name}:${req.ip}`; const now = Date.now();
    const arr = (hits.get(k) || []).filter((t) => now - t < windowMs);
    if (arr.length >= max) return res.status(429).json({ error: 'Muitas tentativas. Aguarde um pouco e tente novamente.' });
    arr.push(now); hits.set(k, arr); next();
  };
}
setInterval(() => { const now = Date.now(); for (const [k, v] of hits) if (!v.some((t) => now - t < 900000)) hits.delete(k); }, 600000).unref();
const validUid = (u) => /^\d{5,15}$/.test(String(u || ''));
const STATUS_LABEL = { DISPONIVEL: 'DISPONÍVEL', INDISPONIVEL: 'INDISPONÍVEL', EM_ATUALIZACAO: 'EM ATUALIZAÇÃO', SEM_ESTOQUE: 'SEM ESTOQUE' };

// ---------- banco ----------
async function initDb() {
  await q(`
  CREATE TABLE IF NOT EXISTS product (
    id INT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    name TEXT NOT NULL, description TEXT NOT NULL,
    price_cents INT NOT NULL CHECK (price_cents > 0),
    stock INT NOT NULL DEFAULT 0 CHECK (stock >= 0),
    reserved INT NOT NULL DEFAULT 0 CHECK (reserved >= 0),
    status TEXT NOT NULL DEFAULT 'INDISPONIVEL',
    maintenance_message TEXT NOT NULL DEFAULT 'Estamos atualizando a loja. Volte em alguns minutos.',
    image BYTEA, image_mime TEXT, image_version INT NOT NULL DEFAULT 0,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now());
  CREATE TABLE IF NOT EXISTS orders (
    id BIGSERIAL PRIMARY KEY, tracking_hash TEXT NOT NULL, product_name TEXT NOT NULL,
    uid TEXT NOT NULL, player_name TEXT, player_level TEXT, ip TEXT,
    amount_cents INT NOT NULL, mp_payment_id TEXT UNIQUE, pix_code TEXT, pix_qr_base64 TEXT,
    payment_status TEXT NOT NULL DEFAULT 'PENDENTE', mp_status TEXT,
    delivery_status TEXT NOT NULL DEFAULT 'AGUARDANDO', delivery_message TEXT,
    stock_state TEXT NOT NULL DEFAULT 'RESERVADO',
    expires_at TIMESTAMPTZ NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    paid_at TIMESTAMPTZ, delivered_at TIMESTAMPTZ, delivery_started_at TIMESTAMPTZ);
  CREATE INDEX IF NOT EXISTS orders_pending_idx ON orders(payment_status, expires_at);
  CREATE TABLE IF NOT EXISTS delivery_attempts (
    id BIGSERIAL PRIMARY KEY, order_id BIGINT NOT NULL REFERENCES orders(id),
    http_status INT, ok BOOLEAN NOT NULL, response TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now());
  CREATE TABLE IF NOT EXISTS admin_log (id BIGSERIAL PRIMARY KEY, action TEXT NOT NULL, details JSONB, created_at TIMESTAMPTZ NOT NULL DEFAULT now());
  CREATE TABLE IF NOT EXISTS events (id BIGSERIAL PRIMARY KEY, level TEXT NOT NULL, message TEXT NOT NULL, data JSONB, created_at TIMESTAMPTZ NOT NULL DEFAULT now());
  INSERT INTO product(id,name,description,price_cents,stock,status)
    VALUES(1,'Passe Booyah','Passe Booyah do Free Fire entregue direto na sua conta após a confirmação do PIX.',1000,0,'INDISPONIVEL')
    ON CONFLICT (id) DO NOTHING;`);
}
const normalizeProduct = () => q(`UPDATE product SET status = CASE
  WHEN status='DISPONIVEL' AND stock<=0 THEN 'SEM_ESTOQUE'
  WHEN status='SEM_ESTOQUE' AND stock>0 THEN 'DISPONIVEL' ELSE status END, updated_at=now() WHERE id=1`);

// ---------- integrações ----------
async function mp(pathname, opts = {}) {
  const r = await fetch(`https://api.mercadopago.com${pathname}`, {
    ...opts, headers: { Authorization: `Bearer ${MERCADOPAGO_ACCESS_TOKEN}`, 'Content-Type': 'application/json', ...(opts.headers || {}) },
    signal: AbortSignal.timeout(20000),
  });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error(`Mercado Pago ${r.status}`); e.status = r.status; e.body = body; throw e; }
  return body;
}
async function autoApi(endpoint, params, timeout) {
  const url = new URL(`${AUTO_BASE}/${endpoint}`);
  url.searchParams.set('key', AUTOSYSTEM_API_KEY);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const r = await fetch(url, { signal: AbortSignal.timeout(timeout) });
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch (_) { /* texto puro */ }
  return { httpStatus: r.status, httpOk: r.ok, text: text.replace(AUTOSYSTEM_API_KEY, '***'), json };
}
// A resposta exata da API não foi informada: detecção tolerante. Confirme com uma resposta real (ver README).
function findKey(obj, names, depth = 0) {
  if (!obj || typeof obj !== 'object' || depth > 4) return undefined;
  for (const [k, v] of Object.entries(obj)) if (names.includes(k.toLowerCase()) && v != null && typeof v !== 'object') return v;
  for (const v of Object.values(obj)) { const f = findKey(v, names, depth + 1); if (f !== undefined) return f; }
  return undefined;
}
function looksFailed(res) {
  if (!res.httpOk) return true;
  const j = res.json;
  if (!j) return /erro|error|falh|fail|inv[aá]lid|n[aã]o encontrad/i.test(res.text);
  if (j.success === false || j.sucesso === false || j.error || j.erro) return true;
  const st = String(j.status ?? '').toLowerCase();
  return ['error', 'erro', 'fail', 'failed', 'falha', 'false'].includes(st);
}
async function lookupPlayer(uid) {
  const res = await autoApi('info', { uid }, 15000);
  if (looksFailed(res)) return null;
  const name = findKey(res.json, ['nickname', 'nick', 'name', 'nome', 'playername', 'player_name']);
  const level = findKey(res.json, ['level', 'nivel', 'nível', 'lvl']);
  if (!name) return null;
  return { name: String(name).slice(0, 60), level: level != null ? String(level).slice(0, 10) : '—' };
}

// ---------- estoque / pedidos ----------
async function closeOrder(id, status, mpStatus) {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const { rows: [o] } = await c.query('SELECT payment_status, stock_state FROM orders WHERE id=$1 FOR UPDATE', [id]);
    if (!o || o.payment_status !== 'PENDENTE') { await c.query('COMMIT'); return; }
    await c.query('UPDATE orders SET payment_status=$2, mp_status=$3, stock_state=$4 WHERE id=$1', [id, status, mpStatus || null, 'LIBERADO']);
    if (o.stock_state === 'RESERVADO') await c.query('UPDATE product SET reserved=GREATEST(reserved-1,0) WHERE id=1');
    await c.query('COMMIT');
  } catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
}
async function approveOrder(id, mpStatus) {
  const c = await pool.connect(); let go = false;
  try {
    await c.query('BEGIN');
    const { rows: [o] } = await c.query('SELECT payment_status, stock_state FROM orders WHERE id=$1 FOR UPDATE', [id]);
    if (!o || o.payment_status === 'APROVADO') { await c.query('COMMIT'); return; }
    await c.query(`UPDATE orders SET payment_status='APROVADO', mp_status=$2, paid_at=now() WHERE id=$1`, [id, mpStatus]);
    if (o.stock_state === 'LIBERADO') { // reserva expirou antes do pagamento ser aprovado
      const r = await c.query('UPDATE product SET reserved=reserved+1 WHERE id=1 AND stock-reserved>=1');
      if (r.rowCount) await c.query(`UPDATE orders SET stock_state='RESERVADO' WHERE id=$1`, [id]);
      else await c.query(`UPDATE orders SET delivery_status='ERRO', delivery_message=$2 WHERE id=$1`, [id, 'Pagamento aprovado após a reserva expirar e sem estoque. Reembolso necessário.']);
    }
    await c.query('COMMIT'); go = true;
  } catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
  if (go) fulfill(id).catch((e) => log('error', 'fulfill falhou', { id, e: e.message }));
}
async function fulfill(id) {
  // Reivindicação atômica: só uma execução consegue passar de AGUARDANDO para ENTREGANDO.
  const claim = await q(`UPDATE orders SET delivery_status='ENTREGANDO', delivery_message=NULL, delivery_started_at=now()
    WHERE id=$1 AND payment_status='APROVADO' AND delivery_status='AGUARDANDO' AND stock_state='RESERVADO' RETURNING uid`, [id]);
  if (!claim.rowCount) return;
  const uid = claim.rows[0].uid;
  let res;
  try { res = await autoApi('passe/pedir', { uid, tipo: 'booyah' }, 45000); } catch (e) {
    await q(`INSERT INTO delivery_attempts(order_id,ok,response) VALUES($1,false,$2)`, [id, `Sem resposta: ${e.message}`]);
    await q(`UPDATE orders SET delivery_status='ERRO', delivery_message=$2 WHERE id=$1`, [id, 'Sem resposta da API de entrega. Resultado incerto: confirme no jogo antes de reenviar.']);
    return log('error', 'Entrega sem resposta', { id });
  }
  const ok = !looksFailed(res);
  await q(`INSERT INTO delivery_attempts(order_id,http_status,ok,response) VALUES($1,$2,$3,$4)`, [id, res.httpStatus, ok, res.text.slice(0, 4000)]);
  if (!ok) {
    const uncertain = res.httpStatus >= 500; // erro do servidor da API: resultado incerto, não reembolsa sozinho
    await q(`UPDATE orders SET delivery_status='ERRO', delivery_message=$2 WHERE id=$1`, [id, uncertain ? `A API de entrega falhou (HTTP ${res.httpStatus}). Resultado incerto: confirme no jogo antes de reembolsar ou reenviar.` : `A API recusou a entrega (HTTP ${res.httpStatus}).`]);
    log('error', 'Entrega recusada', { id, http: res.httpStatus });
    if (!uncertain) await autoRefund(id);
    return;
  }
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query(`UPDATE orders SET delivery_status='ENTREGUE', delivered_at=now(), stock_state='CONSUMIDO', delivery_message='Passe Booyah entregue.' WHERE id=$1`, [id]);
    await c.query('UPDATE product SET stock=GREATEST(stock-1,0), reserved=GREATEST(reserved-1,0) WHERE id=1');
    await c.query(`UPDATE product SET status='SEM_ESTOQUE' WHERE id=1 AND status='DISPONIVEL' AND stock<=0`);
    await c.query('COMMIT');
  } catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
  log('info', 'Entrega concluída', { id });
}

// Reembolso total no Mercado Pago. Só roda para pedido pago com entrega em ERRO; a reivindicação atômica evita reembolso duplicado.
async function autoRefund(id) {
  const claim = await q(`UPDATE orders SET delivery_status='REEMBOLSANDO' WHERE id=$1 AND payment_status='APROVADO' AND delivery_status='ERRO' RETURNING mp_payment_id`, [id]);
  if (!claim.rowCount) return false;
  try {
    await mp(`/v1/payments/${claim.rows[0].mp_payment_id}/refunds`, { method: 'POST', headers: { 'X-Idempotency-Key': `ffestore-refund-${id}` }, body: '{}' });
  } catch (e) {
    await q(`UPDATE orders SET delivery_status='ERRO', delivery_message=$2 WHERE id=$1`, [id, 'A entrega falhou e o reembolso automático também falhou. Reembolso pendente com o administrador.']);
    log('error', 'Reembolso falhou', { id, status: e.status, body: e.body });
    return false;
  }
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const { rows: [o] } = await c.query('SELECT stock_state FROM orders WHERE id=$1 FOR UPDATE', [id]);
    await c.query(`UPDATE orders SET payment_status='REEMBOLSADO', delivery_status='NAO_ENTREGUE', stock_state='LIBERADO', delivery_message='Não foi possível entregar o Passe. O valor foi reembolsado no seu PIX.' WHERE id=$1`, [id]);
    if (o.stock_state === 'RESERVADO') await c.query('UPDATE product SET reserved=GREATEST(reserved-1,0) WHERE id=1');
    await c.query('COMMIT');
  } catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
  log('info', 'Reembolso concluído', { id });
  return true;
}
async function applyPayment(order, p) {
  if (String(p.external_reference) !== String(order.id)) return log('error', 'external_reference divergente', { id: order.id });
  if (Math.round(Number(p.transaction_amount) * 100) !== order.amount_cents) return log('error', 'Valor divergente', { id: order.id });
  if (order.mp_payment_id && String(p.id) !== String(order.mp_payment_id)) return log('error', 'payment id divergente', { id: order.id });
  switch (p.status) {
    case 'approved': return approveOrder(order.id, p.status);
    case 'rejected': return closeOrder(order.id, 'REJEITADO', p.status);
    case 'cancelled': return closeOrder(order.id, p.status_detail === 'expired' ? 'EXPIRADO' : 'CANCELADO', p.status);
    case 'refunded': case 'charged_back':
      return q(`UPDATE orders SET payment_status='REEMBOLSADO', mp_status=$2 WHERE id=$1 AND payment_status='APROVADO'`, [order.id, p.status]);
    default: return q('UPDATE orders SET mp_status=$2 WHERE id=$1 AND payment_status=$3', [order.id, p.status, 'PENDENTE']);
  }
}
const lastSync = new Map();
async function syncOrder(order) {
  if (!order.mp_payment_id || order.payment_status !== 'PENDENTE') return;
  if (Date.now() - (lastSync.get(order.id) || 0) < 4000) return;
  lastSync.set(order.id, Date.now());
  const p = await mp(`/v1/payments/${order.mp_payment_id}`);
  await applyPayment(order, p);
}

// ---------- app ----------
const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use((req, res, next) => {
  res.set({ 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'same-origin' });
  next();
});
app.use('/api/admin/product/image', express.json({ limit: '15mb' }));
app.use(express.json({ limit: '100kb' }));
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));

const productView = (p) => {
  const available = Math.max(p.stock - p.reserved, 0);
  return {
    name: p.name, description: p.description, price_cents: p.price_cents, available,
    status: p.status, status_label: STATUS_LABEL[p.status], message: p.status === 'EM_ATUALIZACAO' ? p.maintenance_message : null,
    can_buy: p.status === 'DISPONIVEL' && available > 0, image_url: `/product-image?v=${p.image_version}`, support_url: SUPPORT_URL,
  };
};
app.get('/api/product', async (_req, res) => {
  const { rows: [p] } = await q('SELECT * FROM product WHERE id=1');
  res.json(productView(p));
});
app.get('/product-image', async (req, res) => {
  const { rows: [p] } = await q('SELECT image, image_mime FROM product WHERE id=1');
  if (!p.image) return res.sendFile(path.join(__dirname, 'public', 'booyah.svg'));
  res.set({ 'Content-Type': p.image_mime, 'Cache-Control': 'public, max-age=86400' }).send(p.image);
});

app.post('/api/player', limit('player', 12, 60000), async (req, res) => {
  const uid = String(req.body.uid || '').trim();
  if (!validUid(uid)) return res.status(400).json({ error: 'UID inválido. Digite somente números.' });
  if (!AUTOSYSTEM_API_KEY) return res.status(503).json({ error: 'Consulta de jogador ainda não configurada.' });
  try {
    const player = await lookupPlayer(uid);
    if (!player) return res.status(404).json({ error: 'Jogador não encontrado. Confira o UID.' });
    res.json({ uid, ...player });
  } catch (e) { log('error', 'Consulta de UID falhou', { e: e.message }); res.status(502).json({ error: 'Não foi possível consultar o jogador agora. Tente novamente.' }); }
});

const orderView = (o) => ({
  number: o.id, product: o.product_name, uid: o.uid, player_name: o.player_name, amount_cents: o.amount_cents,
  payment_status: o.payment_status, mp_status: o.mp_status, delivery_status: o.delivery_status,
  delivery_message: o.delivery_status === 'ERRO' ? 'Houve um problema na entrega. Nossa equipe já foi avisada e vai resolver sem nova cobrança. Fale com o suporte.' : o.delivery_message,
  created_at: o.created_at, expires_at: o.expires_at,
  ...(o.payment_status === 'PENDENTE' ? { pix_code: o.pix_code, pix_qr_base64: o.pix_qr_base64 } : {}),
});

app.post('/api/orders', limit('order', 6, 600000), async (req, res) => {
  const uid = String(req.body.uid || '').trim();
  if (!validUid(uid)) return res.status(400).json({ error: 'UID inválido.' });
  if (!MERCADOPAGO_ACCESS_TOKEN || !AUTOSYSTEM_API_KEY || !BASE_URL) return res.status(503).json({ error: 'Pagamento ainda não configurado. Fale com o suporte.' });
  try {
    const player = await lookupPlayer(uid); // o servidor refaz a consulta: não confia no navegador
    if (!player) return res.status(404).json({ error: 'Jogador não encontrado. Confira o UID.' });
    const open = await q(`SELECT count(*)::int n FROM orders WHERE ip=$1 AND payment_status='PENDENTE'`, [req.ip]);
    if (open.rows[0].n >= 3) return res.status(429).json({ error: 'Você já tem pedidos aguardando pagamento. Conclua ou aguarde expirar.' });

    const code = crypto.randomBytes(6).toString('hex').toUpperCase();
    const c = await pool.connect(); let order;
    try {
      await c.query('BEGIN');
      // O UPDATE trava a linha do produto: compras simultâneas são serializadas e a última unidade nunca é vendida duas vezes.
      const r = await c.query(`UPDATE product SET reserved=reserved+1 WHERE id=1 AND status='DISPONIVEL' AND stock-reserved>=1 RETURNING name, price_cents`);
      if (!r.rowCount) { await c.query('ROLLBACK'); return res.status(409).json({ error: 'Produto indisponível no momento.' }); }
      const ins = await c.query(`INSERT INTO orders(tracking_hash,product_name,uid,player_name,player_level,ip,amount_cents,expires_at)
        VALUES($1,$2,$3,$4,$5,$6,$7, now() + ($8 || ' minutes')::interval) RETURNING *`,
      [sha(code), r.rows[0].name, uid, player.name, player.level, req.ip, r.rows[0].price_cents, String(PIX_MINUTES)]);
      order = ins.rows[0];
      await c.query('COMMIT');
    } catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }

    try {
      const exp = new Date(Date.now() + PIX_MINUTES * 60000).toISOString().replace('Z', '+00:00');
      const p = await mp('/v1/payments', {
        method: 'POST', headers: { 'X-Idempotency-Key': `ffestore-order-${order.id}` },
        body: JSON.stringify({
          transaction_amount: order.amount_cents / 100, description: order.product_name, payment_method_id: 'pix',
          external_reference: String(order.id), date_of_expiration: exp,
          notification_url: `${BASE_URL}/api/webhooks/mercadopago`,
          payer: { email: process.env.PAYER_EMAIL || 'cliente@ffestore.com.br' },
        }),
      });
      const td = p.point_of_interaction?.transaction_data;
      if (!td?.qr_code) throw new Error('Mercado Pago não retornou o PIX');
      const { rows: [saved] } = await q(`UPDATE orders SET mp_payment_id=$2, pix_code=$3, pix_qr_base64=$4, mp_status=$5 WHERE id=$1 RETURNING *`,
        [order.id, String(p.id), td.qr_code, td.qr_code_base64, p.status]);
      res.json({ code, order: orderView(saved) });
    } catch (e) {
      await closeOrder(order.id, 'CANCELADO', 'erro_criacao');
      log('error', 'Falha ao criar PIX', { id: order.id, status: e.status, body: e.body });
      res.status(502).json({ error: 'Não foi possível gerar o PIX agora. Tente novamente em instantes.' });
    }
  } catch (e) { log('error', 'Erro ao criar pedido', { e: e.message }); res.status(500).json({ error: 'Erro interno. Tente novamente.' }); }
});

app.post('/api/orders/lookup', limit('lookup', 40, 600000), async (req, res) => {
  const id = parseInt(String(req.body.number || '').replace(/\D/g, ''), 10);
  const code = String(req.body.code || '').trim().toUpperCase();
  if (!id || id > 2147483647 || !code) return res.status(400).json({ error: 'Informe o número do pedido e o código.' });
  const { rows: [o] } = await q('SELECT * FROM orders WHERE id=$1', [id]);
  if (!o || !safeEq(o.tracking_hash, sha(code))) return res.status(404).json({ error: 'Pedido não encontrado. Confira os dados.' });
  try { await syncOrder(o); } catch (e) { log('error', 'sync falhou', { id, e: e.message }); }
  const { rows: [fresh] } = await q('SELECT * FROM orders WHERE id=$1', [id]);
  res.json(orderView(fresh));
});

// ---------- webhook Mercado Pago ----------
// O webhook é só um aviso: nada é confiado do corpo da requisição. O pagamento é sempre consultado direto na API do Mercado Pago.
app.post('/api/webhooks/mercadopago', limit('webhook', 120, 60000), async (req, res) => {
  const type = req.query.type || req.body.type || req.query.topic;
  const payId = req.query['data.id'] || req.body?.data?.id;
  if (type !== 'payment' || !payId) return res.sendStatus(200);
  try {
    const p = await mp(`/v1/payments/${encodeURIComponent(payId)}`); // sempre confirma direto na API do Mercado Pago
    const { rows: [o] } = await q('SELECT * FROM orders WHERE id=$1', [parseInt(p.external_reference, 10) || 0]);
    if (o) await applyPayment(o, p);
    res.sendStatus(200);
  } catch (e) { log('error', 'Webhook falhou', { payId, e: e.message }); res.sendStatus(500); }
});

// ---------- admin ----------
const adminSecret = () => sha(`ffestore:${ADMIN_PASSWORD}`);
const sign = (v) => crypto.createHmac('sha256', adminSecret()).update(v).digest('hex');
function readCookie(req, name) { const m = (req.headers.cookie || '').split(';').map((s) => s.trim()).find((s) => s.startsWith(`${name}=`)); return m ? decodeURIComponent(m.slice(name.length + 1)) : null; }
function requireAdmin(req, res, next) {
  const t = ADMIN_PASSWORD && readCookie(req, 'ff_admin');
  if (t) { const [exp, sig] = t.split('.'); if (exp && sig && Number(exp) > Date.now() && safeEq(sig, sign(exp))) return next(); }
  res.status(401).json({ error: 'Sessão expirada. Entre novamente.' });
}
const adminLog = (action, details) => q('INSERT INTO admin_log(action,details) VALUES($1,$2)', [action, JSON.stringify(details)]);

app.post('/api/admin/login', limit('login', 6, 900000), (req, res) => {
  if (!ADMIN_PASSWORD) return res.status(503).json({ error: 'ADMIN_PASSWORD não configurada no servidor.' });
  if (!safeEq(sha(req.body.password || ''), sha(ADMIN_PASSWORD))) return res.status(401).json({ error: 'Senha incorreta.' });
  const exp = String(Date.now() + 8 * 3600000);
  res.set('Set-Cookie', `ff_admin=${exp}.${sign(exp)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800${IS_PROD ? '; Secure' : ''}`);
  adminLog('login', { ip: req.ip }).catch(() => {});
  res.json({ ok: true });
});
app.post('/api/admin/logout', (_req, res) => { res.set('Set-Cookie', 'ff_admin=; HttpOnly; Path=/; Max-Age=0'); res.json({ ok: true }); });
app.get('/api/admin/summary', requireAdmin, async (_req, res) => {
  const { rows: [s] } = await q(`SELECT count(*)::int total,
    count(*) FILTER (WHERE payment_status='APROVADO')::int approved, count(*) FILTER (WHERE payment_status='PENDENTE')::int pending,
    count(*) FILTER (WHERE delivery_status='ENTREGUE')::int delivered, count(*) FILTER (WHERE delivery_status='ERRO')::int delivery_errors,
    COALESCE(sum(amount_cents) FILTER (WHERE payment_status='APROVADO'),0)::int revenue_cents FROM orders`);
  const { rows: [p] } = await q('SELECT name,description,price_cents,stock,reserved,status,maintenance_message,image_version FROM product WHERE id=1');
  res.json({ summary: s, product: p, missing_config: missing() });
});
app.get('/api/admin/orders', requireAdmin, async (req, res) => {
  const f = String(req.query.filter || ''); const term = String(req.query.q || '').trim();
  const where = []; const params = [];
  if (f === 'pending') where.push(`payment_status='PENDENTE'`);
  if (f === 'approved') where.push(`payment_status='APROVADO'`);
  if (f === 'delivered') where.push(`delivery_status='ENTREGUE'`);
  if (f === 'errors') where.push(`delivery_status='ERRO'`);
  if (term) { params.push(term.replace(/\D/g, '') || '0'); where.push(`(id::text=$1 OR uid=$1)`); }
  const { rows } = await q(`SELECT id,uid,player_name,amount_cents,payment_status,delivery_status,created_at FROM orders ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY id DESC LIMIT 100`, params);
  res.json(rows);
});
app.get('/api/admin/orders/:id', requireAdmin, async (req, res) => {
  const id = parseInt(req.params.id, 10) || 0;
  const { rows: [o] } = await q('SELECT id,uid,player_name,player_level,amount_cents,mp_payment_id,mp_status,payment_status,delivery_status,delivery_message,stock_state,created_at,paid_at,delivered_at FROM orders WHERE id=$1', [id]);
  if (!o) return res.status(404).json({ error: 'Pedido não encontrado.' });
  const { rows: attempts } = await q('SELECT http_status,ok,response,created_at FROM delivery_attempts WHERE order_id=$1 ORDER BY id DESC', [id]);
  res.json({ order: o, attempts });
});
app.post('/api/admin/orders/:id/retry-delivery', requireAdmin, async (req, res) => {
  const id = parseInt(req.params.id, 10) || 0;
  // Só reabre pedidos já pagos (aprovados) com entrega em ERRO. Nunca cobra de novo.
  const r = await q(`UPDATE orders SET delivery_status='AGUARDANDO' WHERE id=$1 AND payment_status='APROVADO' AND delivery_status='ERRO' AND stock_state='RESERVADO'`, [id]);
  if (!r.rowCount) return res.status(409).json({ error: 'Este pedido não pode ser reenviado (precisa estar pago, com erro de entrega e reserva ativa).' });
  await adminLog('retry_delivery', { order: id });
  await fulfill(id);
  const { rows: [o] } = await q('SELECT delivery_status FROM orders WHERE id=$1', [id]);
  res.json({ delivery_status: o.delivery_status });
});
app.post('/api/admin/orders/:id/refund', requireAdmin, async (req, res) => {
  const id = parseInt(req.params.id, 10) || 0;
  const ok = await autoRefund(id);
  await adminLog('manual_refund', { order: id, ok });
  if (!ok) return res.status(409).json({ error: 'Não foi possível reembolsar (o pedido precisa estar pago e com erro de entrega).' });
  res.json({ ok: true });
});
app.put('/api/admin/product', requireAdmin, async (req, res) => {
  const b = req.body; const price = Math.round(Number(String(b.price).replace(',', '.')) * 100);
  const name = String(b.name || '').trim().slice(0, 80); const description = String(b.description || '').trim().slice(0, 500);
  if (!name || !description || !(price >= 100 && price <= 1000000)) return res.status(400).json({ error: 'Confira nome, descrição e preço (mínimo R$ 1,00).' });
  if (!STATUS_LABEL[b.status]) return res.status(400).json({ error: 'Status inválido.' });
  const msg = String(b.maintenance_message || '').trim().slice(0, 200) || 'Estamos atualizando a loja. Volte em alguns minutos.';
  const { rows: [old] } = await q('SELECT name,description,price_cents,status FROM product WHERE id=1');
  await q('UPDATE product SET name=$1, description=$2, price_cents=$3, status=$4, maintenance_message=$5 WHERE id=1', [name, description, price, b.status, msg]);
  await normalizeProduct();
  await adminLog('product_update', { old, new: { name, description, price_cents: price, status: b.status } });
  res.json({ ok: true });
});
app.post('/api/admin/product/image', requireAdmin, async (req, res) => {
  const { mime, data } = req.body;
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(mime) || typeof data !== 'string') return res.status(400).json({ error: 'Use PNG, JPG ou WEBP.' });
  const buf = Buffer.from(data, 'base64');
  if (!buf.length || buf.length > 8 * 1024 * 1024) return res.status(400).json({ error: 'A imagem é grande demais, escolha outra.' });
  await q('UPDATE product SET image=$1, image_mime=$2, image_version=image_version+1 WHERE id=1', [buf, mime]);
  await adminLog('image_update', { bytes: buf.length });
  res.json({ ok: true });
});
app.post('/api/admin/stock', requireAdmin, async (req, res) => {
  const n = parseInt(req.body.amount, 10); const mode = req.body.mode;
  if (!(n >= 0 && n <= 100000) || !['add', 'remove', 'set'].includes(mode)) return res.status(400).json({ error: 'Quantidade inválida.' });
  const expr = { add: 'stock+$1', remove: 'stock-$1', set: '$1' }[mode];
  const r = await q(`UPDATE product SET stock=${expr} WHERE id=1 AND ${expr} >= reserved`, [n]);
  if (!r.rowCount) return res.status(409).json({ error: 'O estoque não pode ficar abaixo das unidades reservadas.' });
  await normalizeProduct();
  await adminLog('stock_update', { mode, amount: n });
  res.json({ ok: true });
});
app.get('/api/admin/log', requireAdmin, async (_req, res) => {
  const [a, e] = await Promise.all([q('SELECT action,details,created_at FROM admin_log ORDER BY id DESC LIMIT 30'), q(`SELECT level,message,created_at FROM events WHERE level<>'info' ORDER BY id DESC LIMIT 30`)]);
  res.json({ admin: a.rows, events: e.rows });
});

app.use('/api', (_req, res) => res.status(404).json({ error: 'Rota não encontrada.' }));
app.use((err, _req, res, _next) => { log('error', 'Erro não tratado', { e: err.message }); res.status(500).json({ error: 'Erro interno.' }); });

// ---------- rotinas ----------
async function maintenance() {
  try {
    const { rows: expired } = await q(`SELECT * FROM orders WHERE payment_status='PENDENTE' AND expires_at < now() - interval '1 minute' LIMIT 20`);
    for (const o of expired) {
      try {
        if (o.mp_payment_id) {
          const p = await mp(`/v1/payments/${o.mp_payment_id}`);
          if (p.status === 'approved') { await applyPayment(o, p); continue; }
          if (p.status === 'pending' || p.status === 'in_process') await mp(`/v1/payments/${o.mp_payment_id}`, { method: 'PUT', body: JSON.stringify({ status: 'cancelled' }) }).catch(() => {});
        }
        await closeOrder(o.id, 'EXPIRADO', 'expired');
      } catch (e) { log('error', 'Expiração falhou', { id: o.id, e: e.message }); }
    }
    // pagamentos aprovados cuja entrega nunca foi iniciada (ex.: servidor reiniciou)
    const { rows: waiting } = await q(`SELECT id FROM orders WHERE payment_status='APROVADO' AND delivery_status='AGUARDANDO' AND paid_at < now() - interval '1 minute' LIMIT 10`);
    for (const o of waiting) await fulfill(o.id);
    // entrega travada: resultado incerto, não reenvia sozinho
    await q(`UPDATE orders SET delivery_status='ERRO', delivery_message='Entrega interrompida. Resultado incerto: confirme no jogo antes de reenviar.' WHERE delivery_status='ENTREGANDO' AND delivery_started_at < now() - interval '5 minutes'`);
  } catch (e) { log('error', 'Rotina falhou', { e: e.message }); }
}

initDb().then(() => {
  app.listen(PORT, () => console.log(`FF ESTORE na porta ${PORT}. Variáveis faltando: ${missing().join(', ') || 'nenhuma'}`));
  setInterval(maintenance, 60000).unref(); maintenance();
}).catch((e) => { console.error('Falha ao iniciar o banco:', e.message); process.exit(1); });
