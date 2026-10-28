(() => {
  const $ = id => document.getElementById(id);
  const TOKEN_KEY = 'rupee-store-admin-token';
  const POLL_MS = 2000;
  let token = null;
  let timer = null;
  let previous = new Map();
  let failures = 0;
  let generation = 0; // bumps on every (re)start so a stale in-flight poll never schedules a second loop

  function readToken() {
    try { return sessionStorage.getItem(TOKEN_KEY); } catch { return null; }
  }
  function writeToken(value) {
    try {
      if (value) sessionStorage.setItem(TOKEN_KEY, value);
      else sessionStorage.removeItem(TOKEN_KEY);
    } catch {}
  }

  const fmtTime = iso => iso ? new Date(iso).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '—';

  function cell(text, cls) {
    const td = document.createElement('td');
    td.textContent = text;
    if (cls) td.className = cls;
    return td;
  }

  function setLive(state, text) {
    $('liveBadge').className = `live ${state}`;
    $('liveText').textContent = text;
  }

  function showLogin(message) {
    stop();
    $('dash').hidden = true;
    $('login').hidden = false;
    $('loginError').hidden = !message;
    $('loginError').textContent = message || '';
    setLive('off', 'Signed out');
  }

  function render(data) {
    const s = data.stats || {};
    const paid = s.PAID || { count: 0, amount: '0.00' };
    $('statPaidToday').textContent = `₹${data.paidToday.amount}`;
    $('statPaidTodayCount').textContent = `${data.paidToday.count} payment${data.paidToday.count === 1 ? '' : 's'}`;
    $('statPaidAll').textContent = `₹${paid.amount}`;
    $('statPaidAllCount').textContent = `${paid.count} payment${paid.count === 1 ? '' : 's'}`;
    $('statPending').textContent = String(s.PENDING?.count || 0);
    $('statReview').textContent = String(s.REVIEW?.count || 0);

    const banner = $('gatewayBanner');
    banner.hidden = false;
    if (data.gateway.linked) {
      banner.className = 'banner ok';
      banner.textContent = `Gateway linked: ${data.gateway.host} (address updated ${fmtTime(data.gateway.updatedAt)})`;
    } else {
      banner.className = 'banner';
      banner.textContent = `Customers cannot pay right now: ${data.gateway.reason}`;
    }

    const body = $('ordersBody');
    const next = new Map();
    const rows = data.orders.map(o => {
      const tr = document.createElement('tr');
      const signature = `${o.status}|${o.utr}|${o.settlementState}`;
      next.set(o.orderId, signature);
      if (previous.size && previous.get(o.orderId) !== signature) tr.className = 'flash';
      const idCell = cell(`${o.orderId.slice(0, 9)}…`, 'mono');
      idCell.title = `${o.orderId}${o.paymentId ? `\nPayment ${o.paymentId}` : ''}`;
      tr.append(cell(fmtTime(o.createdAt)), idCell, cell(`₹${o.amount}`));
      const st = document.createElement('td');
      const badge = document.createElement('span');
      badge.className = `badge ${o.status}`;
      badge.textContent = o.status === 'PAID' && o.settlementState === 'RECONCILED' ? 'PAID ✓ reconciled' : o.status;
      badge.title = o.gatewayStatus ? `Gateway: ${o.gatewayStatus}` : '';
      st.append(badge);
      tr.append(st, cell(o.utr || '—', 'mono'), cell(fmtTime(o.paidAt)));
      return tr;
    });
    body.replaceChildren(...rows);
    previous = next;
    $('emptyOrders').hidden = data.orders.length > 0;
    $('updatedAt').textContent = `Updated ${fmtTime(data.serverTime)}`;

    const events = data.events.map(e => {
      const li = document.createElement('li');
      li.className = e.kind;
      const when = document.createElement('div');
      when.className = 'when';
      when.textContent = fmtTime(e.at);
      const what = document.createElement('div');
      what.className = 'what';
      what.textContent = e.from || e.to ? `${e.kind}: ${e.from || '·'} → ${e.to || '·'}` : e.kind;
      const detail = document.createElement('div');
      detail.className = 'detail';
      detail.textContent = `${e.orderId}${e.detail ? ` — ${e.detail}` : ''}`;
      li.append(when, what, detail);
      return li;
    });
    $('events').replaceChildren(...events);
  }

  async function poll() {
    const gen = generation;
    try {
      const res = await fetch('/api/admin/orders', { headers: { Authorization: `Bearer ${token}` }, cache: 'no-store' });
      if (gen !== generation) return;
      if (res.status === 401) {
        writeToken(null);
        showLogin('That token was not accepted.');
        return;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (gen !== generation) return;
      render(data);
      failures = 0;
      setLive('on', 'Live');
    } catch {
      if (gen !== generation) return;
      failures += 1;
      setLive('off', failures > 2 ? 'Connection lost, retrying…' : 'Retrying…');
    }
    timer = setTimeout(poll, document.hidden ? POLL_MS * 5 : POLL_MS);
  }

  function start() {
    $('login').hidden = true;
    $('dash').hidden = false;
    previous = new Map();
    stop();
    poll();
  }

  function stop() {
    generation += 1;
    if (timer) clearTimeout(timer);
    timer = null;
  }

  $('loginForm').addEventListener('submit', e => {
    e.preventDefault();
    token = $('tokenInput').value.trim();
    $('tokenInput').value = '';
    writeToken(token);
    start();
  });
  $('logoutBtn').addEventListener('click', () => {
    token = null;
    writeToken(null);
    showLogin();
  });
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && token && !$('dash').hidden) { stop(); poll(); }
  });

  token = readToken();
  if (token) start();
  else showLogin();
})();
