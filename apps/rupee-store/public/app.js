(() => {
  const $ = id => document.getElementById(id);
  const buyBtn = $('buyBtn');
  const buyError = $('buyError');

  const STATES = {
    PENDING: { icon: '⏳', cls: 'pending', title: 'Waiting for your payment', text: 'Finish paying in the checkout. This page updates by itself once the bank credit is seen.' },
    PAID: { icon: '✓', cls: 'paid', title: 'Payment received', text: 'Thank you! Your payment was confirmed by the gateway.' },
    REVIEW: { icon: '!', cls: 'review', title: 'Payment under review', text: 'We saw a payment but need to confirm it manually. You will not be charged twice.' },
    FAILED: { icon: '✕', cls: 'failed', title: 'Payment not received', text: 'No matching payment arrived in time. If money left your account, contact the merchant with your UTR.' },
    EXPIRED: { icon: '✕', cls: 'failed', title: 'Checkout expired', text: 'The payment window closed before a payment arrived.' },
    CANCELLED: { icon: '✕', cls: 'failed', title: 'Checkout cancelled', text: 'You left the checkout without paying.' }
  };
  const FINAL = new Set(['PAID', 'FAILED', 'EXPIRED', 'CANCELLED']);

  function showError(message) {
    buyError.textContent = message;
    buyError.hidden = false;
  }

  async function buy() {
    buyError.hidden = true;
    buyBtn.disabled = true;
    buyBtn.textContent = 'Starting secure checkout…';
    try {
      const res = await fetch('/api/orders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}'
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.checkoutUrl) throw new Error(data.error || 'Could not start the payment.');
      const target = new URL(data.checkoutUrl);
      if (target.protocol !== 'https:' && target.protocol !== 'http:') throw new Error('Unexpected checkout address.');
      window.location.assign(target.href);
    } catch (err) {
      showError(err.message);
      buyBtn.disabled = false;
      buyBtn.textContent = 'Buy now with UPI';
    }
  }

  function render(order) {
    const state = STATES[order.status] || STATES.PENDING;
    $('orderPanel').hidden = false;
    $('orderPanel').className = `order ${state.cls}`;
    $('orderIcon').textContent = state.icon;
    $('orderTitle').textContent = state.title;
    $('orderText').textContent = state.text;
    $('orderId').textContent = order.orderId;
    $('orderAmount').textContent = `₹${order.amount}`;
    $('utrRow').hidden = !order.utr;
    $('orderUtr').textContent = order.utr || '';
    $('newOrderBtn').hidden = !FINAL.has(order.status);
  }

  async function watchOrder(orderId) {
    let delay = 2000;
    let paidPolls = 0;
    for (let i = 0; i < 400; i += 1) {
      try {
        const res = await fetch(`/api/orders/${encodeURIComponent(orderId)}`, { cache: 'no-store' });
        if (res.status === 404) {
          $('orderPanel').hidden = true;
          return;
        }
        if (res.ok) {
          const order = await res.json();
          render(order);
          // The bank reference (UTR) can land a moment after PAID; keep looking briefly for it.
          if (order.status === 'PAID' && !order.utr && paidPolls < 10) {
            paidPolls += 1;
          } else if (FINAL.has(order.status)) {
            return;
          }
        }
      } catch {}
      await new Promise(r => setTimeout(r, delay));
      delay = Math.min(delay + 500, 5000);
    }
  }

  buyBtn.addEventListener('click', buy);
  $('newOrderBtn').addEventListener('click', () => {
    window.location.assign('/');
  });

  const orderId = new URLSearchParams(window.location.search).get('order');
  if (orderId && /^R1-[A-Za-z0-9_-]{22}$/.test(orderId)) watchOrder(orderId);

  fetch('/api/product', { cache: 'no-store' }).then(r => r.json()).then(p => {
    if (p.name) $('productName').textContent = p.name;
    if (p.description) $('productDescription').textContent = p.description;
    if (p.amount) $('productPrice').textContent = p.amount;
    if (!p.ready) showError(p.notReadyReason || 'This store is not connected to the payment gateway yet.');
  }).catch(() => {});
})();
