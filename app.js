'use strict';
const $ = (s) => document.querySelector(s);
const brl = (c) => (c / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
const icon = (n) => `<svg class="i"><use href="#${n}"/></svg>`;
const spin = '<i class="spin"></i>';
let product = null, poll = null, tick = null;

function toast(msg) { const t = $('#toast'); t.textContent = msg; t.classList.add('on'); setTimeout(() => t.classList.remove('on'), 2600); }
async function api(url, body) {
  const r = await fetch(url, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : undefined);
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || 'Algo deu errado. Tente novamente.');
  return j;
}
const saved = () => { try { return JSON.parse(localStorage.getItem('ff_orders') || '[]'); } catch (_) { return []; } };
const saveOrder = (number, code) => { try { localStorage.setItem('ff_orders', JSON.stringify([{ number, code }, ...saved().filter((o) => o.number !== number)].slice(0, 5))); } catch (_) {} };

// menu
const menu = (on) => { $('#drawer').classList.toggle('on', on); $('#veil').classList.toggle('on', on || $('#sheet').classList.contains('on')); };
$('#openMenu').onclick = () => menu(true); $('#closeMenu').onclick = () => menu(false);
document.querySelectorAll('#drawer a').forEach((a) => (a.onclick = () => menu(false)));
function openSheet() { $('#sheet').classList.add('on'); $('#veil').classList.add('on'); }
function closeSheet() { $('#sheet').classList.remove('on'); $('#veil').classList.remove('on'); $('#drawer').classList.remove('on'); clearInterval(poll); clearInterval(tick); }
$('#veil').onclick = closeSheet; $('#closeSheet').onclick = closeSheet;

// produto
async function loadProduct() {
  try {
    product = await api('/api/product');
    $('#pname').textContent = product.name; $('#pdesc').textContent = product.description;
    $('#pprice').innerHTML = `<small>R$</small>${(product.price_cents / 100).toFixed(2).replace('.', ',')}`;
    $('#pstock').textContent = product.available;
    $('#pimg').src = product.image_url;
    const chip = $('#chip'); chip.textContent = product.status_label; chip.className = `chip ${product.status}`;
    const note = $('#pnote');
    const msgs = { EM_ATUALIZACAO: product.message, INDISPONIVEL: 'Produto indisponível no momento.', SEM_ESTOQUE: 'Estoque esgotado. Volte em breve.' };
    note.hidden = product.can_buy; note.textContent = msgs[product.status] || '';
    const b = $('#buy'); b.disabled = !product.can_buy; b.textContent = product.can_buy ? 'COMPRAR' : product.status_label;
    $('#fab').href = product.support_url;
    $('#skel').hidden = true; $('#prod').hidden = false;
  } catch (e) { $('#skel').outerHTML = `<p class="err">Não foi possível carregar a loja. Atualize a página.</p>`; }
}
$('#buy').onclick = () => { if (product?.can_buy) stepUid(); };

// etapas de compra
const body = (h) => { $('#sheetBody').innerHTML = h; };
function stepUid(err = '', uid = '') {
  clearInterval(poll); clearInterval(tick); openSheet();
  body(`${stepper(1)}<h3>Seu UID</h3><p class="lead">Digite o UID da conta do Free Fire que vai receber o ${esc(product.name)}.</p>
  ${err ? `<p class="err">${esc(err)}</p>` : ''}
  <input class="f" id="uid" inputmode="numeric" autocomplete="off" placeholder="Ex.: 123456789" maxlength="15" value="${esc(uid)}">
  <button class="btn red" id="next">PRÓXIMO</button>`);
  const input = $('#uid'); input.focus();
  input.oninput = () => { input.value = input.value.replace(/\D/g, ''); };
  input.onkeydown = (e) => { if (e.key === 'Enter') $('#next').click(); };
  $('#next').onclick = async () => {
    const v = input.value.trim();
    if (!/^\d{5,15}$/.test(v)) return stepUid('Digite um UID válido (somente números).', v);
    $('#next').disabled = true; $('#next').innerHTML = spin;
    try { stepConfirm(await api('/api/player', { uid: v })); } catch (e) { stepUid(e.message, v); }
  };
}
const stepper = (n) => `<div class="steps">${['Conta', 'Pagamento', 'Entrega'].map((t, k) => `${k ? `<span class="ln ${k < n ? 'done' : ''}"></span>` : ''}<span class="s ${k + 1 < n ? 'done' : k + 1 === n ? 'on' : ''}"><i>${k + 1 < n ? icon('check') : k + 1}</i>${t}</span>`).join('')}</div>`;
async function copyText(t) { try { await navigator.clipboard.writeText(t); } catch (_) { const a = document.createElement('textarea'); a.value = t; document.body.append(a); a.select(); document.execCommand('copy'); a.remove(); } toast('Copiado'); }
function stepConfirm(p) {
  body(`${stepper(1)}<h3>Confirme sua conta</h3><p class="lead">Confira se estes dados são seus antes de pagar.</p>
  <div class="player"><div class="av">${esc(p.name.slice(0, 1).toUpperCase())}</div><b>${esc(p.name)}</b><div class="chips"><span>Nível ${esc(p.level)}</span><span>UID ${esc(p.uid)}</span></div></div>
  <div class="sum"><div class="meta"><span>Produto</span><b>${esc(product.name)}</b></div><div class="meta"><span>Valor</span><b>${brl(product.price_cents)}</b></div></div>
  <button class="btn red" id="yes">ESSA É MINHA CONTA</button><button class="btn ghost" id="no">ESSA NÃO É MINHA CONTA</button>`);
  $('#no').onclick = () => stepUid('', '');
  $('#yes').onclick = async () => {
    $('#yes').disabled = true; $('#no').disabled = true; $('#yes').innerHTML = `${spin} Gerando PIX`;
    try { const r = await api('/api/orders', { uid: p.uid }); saveOrder(r.order.number, r.code); stepPay(r.order, r.code); }
    catch (e) { stepUid(e.message, p.uid); }
  };
}
function badge(s) { const m = { APROVADO: ['ok', 'Aprovado'], ENTREGUE: ['ok', 'Entregue'], PENDENTE: ['wait', 'Aguardando pagamento'], AGUARDANDO: ['wait', 'Aguardando'], ENTREGANDO: ['wait', 'Entregando'], REEMBOLSANDO: ['wait', 'Reembolsando'], REJEITADO: ['bad', 'Rejeitado'], CANCELADO: ['bad', 'Cancelado'], EXPIRADO: ['bad', 'Expirado'], ERRO: ['bad', 'Em tratamento'], NAO_ENTREGUE: ['bad', 'Não entregue'], REEMBOLSADO: ['bad', 'Reembolsado'] }[s] || ['wait', s]; return `<span class="badge ${m[0]}">${m[1]}</span>`; }
function stepPay(o, code) {
  openSheet(); clearInterval(poll); clearInterval(tick);
  const total = Math.max(1, new Date(o.expires_at) - new Date(o.created_at));
  body(`${stepper(2)}<h3>Pague com PIX</h3><p class="lead">Escaneie o QR Code ou copie o código no app do seu banco.</p>
  <div class="top2"><div class="amount"><small>Valor total</small><b>${brl(o.amount_cents)}</b></div><span class="timer">${icon('clock')}<span id="left">--:--</span></span></div>
  <div class="prog"><i id="bar" style="width:100%"></i></div>
  <div class="qr"><img alt="QR Code PIX" src="data:image/png;base64,${esc(o.pix_qr_base64)}"></div>
  <div class="code">${esc(o.pix_code)}</div>
  <button class="btn red" id="copy">${icon('copy')}COPIAR PIX</button>
  <p class="wait"><i class="dot amber"></i>Aguardando o pagamento. Confirmamos sozinhos.</p>
  <div class="sum"><div class="meta"><span>Pedido</span><b>#${String(o.number).padStart(6, '0')}</b></div><div class="meta"><span>Conta</span><b>${esc(o.player_name)} · ${esc(o.uid)}</b></div></div>
  <div class="keybox"><small>Código de acompanhamento. Guarde, ele aparece só agora.</small><b>${esc(code)}</b><button class="btn ghost" id="copyCode">${icon('copy')}Copiar código</button></div>`);
  $('#copy').onclick = () => copyText(o.pix_code); $('#copyCode').onclick = () => copyText(code);
  const exp = new Date(o.expires_at).getTime();
  tick = setInterval(() => { const ms = Math.max(0, exp - Date.now()), s = Math.floor(ms / 1000); const el = $('#left'); if (el) el.textContent = `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`; const b = $('#bar'); if (b) b.style.width = `${Math.min(100, ms / total * 100)}%`; }, 500);
  poll = setInterval(async () => {
    try { const n = await api('/api/orders/lookup', { number: o.number, code }); if (n.payment_status !== 'PENDENTE') { clearInterval(poll); clearInterval(tick); showOrder(n, code); } } catch (_) { /* tenta de novo */ }
  }, 4000);
}
function showOrder(o, code) {
  clearInterval(poll); clearInterval(tick); openSheet();
  const P = o.payment_status, D = o.delivery_status;
  const paid = P === 'APROVADO', done = D === 'ENTREGUE', refunded = P === 'REEMBOLSADO', refunding = D === 'REEMBOLSANDO';
  const badPay = ['REJEITADO', 'CANCELADO', 'EXPIRADO'].includes(P), failed = D === 'ERRO' || D === 'NAO_ENTREGUE';
  const k = done ? 'ok' : (badPay || refunded || failed) ? 'bad' : 'wait';
  const ic = done ? 'check' : k === 'bad' ? 'alert' : 'clock';
  const title = done ? 'Passe entregue!' : refunded ? 'Pedido reembolsado' : refunding ? 'Reembolsando…' : badPay ? `Pagamento ${P.toLowerCase()}` : D === 'ERRO' ? 'Problema na entrega' : paid ? 'Entregando seu Passe…' : 'Aguardando pagamento';
  const text = done ? 'Abra o Free Fire e confira sua conta.' : refunded ? (o.delivery_message || 'O valor foi devolvido no seu PIX.') : refunding ? 'Não foi possível entregar. Estamos devolvendo o valor no seu PIX.' : badPay ? 'Nenhuma entrega foi feita. Você pode fazer um novo pedido.' : D === 'ERRO' ? (o.delivery_message || '') : paid ? 'Pagamento confirmado. A entrega está em andamento.' : 'Assim que o PIX for aprovado, a entrega é automática.';
  const t = (st, i, ttl, sub) => `<div class="t ${st}"><i>${icon(i)}</i><div><b>${ttl}</b><span>${sub}</span></div></div>`;
  const pay = refunded ? t('bad', 'alert', 'Pagamento reembolsado', 'Valor devolvido no PIX') : badPay ? t('bad', 'alert', `Pagamento ${P.toLowerCase()}`, 'Nada foi cobrado') : paid ? t('done', 'check', 'Pagamento aprovado', 'Confirmado pelo Mercado Pago') : t('now', 'clock', 'Aguardando o PIX', 'Confirmamos sozinhos');
  const del = done ? t('done', 'check', 'Passe entregue', 'Já está na sua conta') : (failed || refunded || refunding) ? t('bad', 'alert', 'Não entregue', refunded || refunding ? 'Valor devolvido' : 'Nossa equipe está resolvendo') : paid ? t('now', 'clock', 'Entregando o Passe', 'Isso leva só alguns instantes') : t('', 'box', 'Entrega', 'Acontece logo após o pagamento');
  body(`<div class="big ${k}">${icon(ic)}</div><h3 style="text-align:center">${esc(title)}</h3><p class="lead" style="text-align:center">${esc(text)}</p>
  <div class="tl">${t('done', 'check', 'Pedido criado', new Date(o.created_at).toLocaleString('pt-BR'))}${pay}${del}</div>
  <div class="sum"><div class="meta"><span>Pedido</span><b>#${String(o.number).padStart(6, '0')}</b></div><div class="meta"><span>Produto</span><b>${esc(o.product)}</b></div><div class="meta"><span>UID</span><b>${esc(o.uid)}</b></div><div class="meta"><span>Valor</span><b>${brl(o.amount_cents)}</b></div></div>
  ${P === 'PENDENTE' && o.pix_code ? '<button class="btn red" id="resume">VER PIX</button>' : ''}${D === 'ERRO' ? `<a class="btn ghost" target="_blank" rel="noopener" href="${esc(product?.support_url || '#')}">${icon('head')}Falar com o suporte</a>` : ''}<button class="btn ghost" id="done">FECHAR</button>`);
  $('#done').onclick = closeSheet; if ($('#resume')) $('#resume').onclick = () => stepPay(o, code);
  if (paid && !done) poll = setInterval(async () => { try { const n = await api('/api/orders/lookup', { number: o.number, code }); if (n.delivery_status !== D || n.payment_status !== P) showOrder(n, code); } catch (_) {} }, 4000);
}

// acompanhar pedido
function track(err = '', number = '', code = '') {
  menu(false); openSheet();
  const list = saved().map((s) => `<button class="btn ghost" data-n="${s.number}" data-c="${esc(s.code)}">Pedido #${String(s.number).padStart(6, '0')}</button>`).join('');
  body(`<h3>Acompanhar pedido</h3><p class="lead">Use o número do pedido e o código de acompanhamento.</p>
  ${err ? `<p class="err">${esc(err)}</p>` : ''}
  <input class="f" id="tn" inputmode="numeric" placeholder="Número do pedido" value="${esc(number)}"><input class="f" id="tc" autocapitalize="characters" placeholder="Código de acompanhamento" value="${esc(code)}">
  <button class="btn red" id="go">CONSULTAR</button>${list ? `<p class="lead" style="margin:18px 0 8px">Neste aparelho</p>${list}` : ''}`);
  const run = async (n, c) => {
    $('#go').disabled = true; $('#go').innerHTML = spin;
    try { const o = await api('/api/orders/lookup', { number: n, code: c }); saveOrder(o.number, c.toUpperCase()); showOrder(o, c.toUpperCase()); } catch (e) { track(e.message, n, c); }
  };
  $('#go').onclick = () => run($('#tn').value, $('#tc').value);
  document.querySelectorAll('[data-n]').forEach((b) => (b.onclick = () => run(b.dataset.n, b.dataset.c)));
}
['#openTrack', '#menuTrack', '#ftTrack'].forEach((s) => ($(s).onclick = (e) => { e.preventDefault(); track(); }));
loadProduct(); setInterval(loadProduct, 60000);

// partículas vermelhas subindo
(() => {
  const cv = $('#fx'); if (!cv || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const ctx = cv.getContext('2d'); let w, h, ps = [];
  const dpr = Math.min(devicePixelRatio || 1, 2);
  const mk = (init) => ({ x: Math.random() * w, y: init ? Math.random() * h : h + 10, r: Math.random() * 2 + .6, v: Math.random() * .5 + .25, a: Math.random() * .6 + .2, s: Math.random() * 6, k: Math.random() * .6 + .2 });
  const fit = () => { w = innerWidth; h = innerHeight; cv.width = w * dpr; cv.height = h * dpr; ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ps = Array.from({ length: w < 600 ? 32 : 60 }, () => mk(true)); };
  addEventListener('resize', fit); fit();
  (function loop(t) {
    if (!document.hidden) {
      ctx.clearRect(0, 0, w, h);
      for (const p of ps) {
        p.y -= p.v; p.x += Math.sin(t / 1400 + p.s) * p.k * .4;
        if (p.y < -10) Object.assign(p, mk(false));
        const f = Math.min(1, p.y / (h * .25), (h - p.y) / 40 + .3);
        ctx.beginPath(); ctx.fillStyle = `rgba(255,${50 + p.r * 10 | 0},65,${Math.max(0, p.a * f)})`;
        ctx.shadowColor = 'rgba(225,29,42,.9)'; ctx.shadowBlur = 8; ctx.arc(p.x, p.y, p.r, 0, 6.283); ctx.fill();
      }
    }
    requestAnimationFrame(loop);
  })(0);
})();

// toque 5x no logo do topo abre o painel (que pede a senha)
(() => { let n = 0, t; const logo = document.querySelector('.bar .logo'); if (!logo) return;
  logo.addEventListener('click', () => { n++; clearTimeout(t); t = setTimeout(() => { n = 0; }, 2000); if (n >= 5) { n = 0; location.href = '/admin'; } }); })();
