(() => {
  'use strict';
  const surface = document.getElementById('checkout-surface');
  const intro = document.getElementById('checkout-intro');
  const message = document.getElementById('checkout-message');
  const title = document.getElementById('checkout-message-title');
  const detail = document.getElementById('checkout-message-detail');
  const spinner = document.getElementById('checkout-spinner');
  const retry = document.getElementById('checkout-retry');
  const login = document.getElementById('checkout-login');
  const manage = document.getElementById('checkout-manage');
  const mount = document.getElementById('checkout-mount');
  let client, checkout, authSubscription, ownerId, generation = 0, busy = false;

  function destroyCheckout() {
    if (checkout) { try { checkout.destroy(); } catch {} checkout = null; }
    mount.replaceChildren();
  }

  function showMessage(heading, description, action = 'retry', loading = false) {
    message.hidden = false;
    title.textContent = heading;
    detail.textContent = description;
    spinner.hidden = !loading;
    retry.hidden = action !== 'retry';
    login.hidden = action !== 'login';
    manage.hidden = action !== 'manage';
    surface.setAttribute('aria-busy', String(loading));
  }

  async function request(url, options = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20000);
    try {
      const response = await fetch(url, { ...options, cache: 'no-store', signal: controller.signal });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        const error = new Error(body.error || 'Checkout is temporarily unavailable. Please try again.');
        error.status = response.status;
        throw error;
      }
      return body;
    } finally { clearTimeout(timer); }
  }

  async function currentSession() {
    const result = await client.auth.getSession();
    const session = result.data?.session;
    if (result.error || !session?.access_token || !session.user?.id) {
      const error = new Error('Please log in with your café account to continue.');
      error.status = 401;
      throw error;
    }
    if (ownerId && session.user.id !== ownerId) {
      const error = new Error('The signed-in account changed. Return to your café before continuing.');
      error.status = 401;
      throw error;
    }
    return session;
  }

  async function openCheckout() {
    if (busy) return;
    busy = true;
    retry.disabled = true;
    const attempt = ++generation;
    const isCurrent = () => attempt === generation;
    destroyCheckout();
    intro.hidden = true;
    showMessage('Opening secure checkout…', 'Checking your café account and subscription.', '', true);
    try {
      if (!client) {
        if (!window.supabase?.createClient) throw new Error('The account service did not load. Refresh this page to try again.');
        const config = await request('/api/config');
        if (!isCurrent()) return;
        if (!config.supabaseUrl || !config.supabasePublishableKey) throw new Error('The account service is temporarily unavailable.');
        client = window.supabase.createClient(config.supabaseUrl, config.supabasePublishableKey, {
          auth: { storageKey: `sb-${new URL(config.supabaseUrl).hostname.split('.')[0]}-auth-token` }
        });
      }
      const session = await currentSession();
      if (!isCurrent()) return;
      ownerId = session.user.id;
      if (!authSubscription) {
        authSubscription = client.auth.onAuthStateChange((_event, nextSession) => {
          if (!ownerId || nextSession?.user?.id === ownerId) return;
          generation++;
          busy = false;
          destroyCheckout();
          intro.hidden = true;
          showMessage('Your session changed', 'Log in with your café account before continuing.', 'login');
        }).data.subscription;
      }
      const headers = { Authorization: `Bearer ${session.access_token}`, 'Content-Type': 'application/json' };
      const billing = await request('/api/billing-status', { headers });
      if (!isCurrent()) return;
      intro.hidden = false;
      if (billing.canManageBilling) {
        showMessage('Your café already has a subscription', 'View your current plan and payment details from your account.', 'manage');
        return;
      }
      if (billing.billingPaused) {
        showMessage('Subscriptions are currently paused', 'Your café can continue using its Free plan.', 'manage');
        return;
      }
      if (typeof window.Stripe !== 'function') throw new Error('The payment form did not load. Refresh this page to try again.');
      const latest = await currentSession();
      if (!isCurrent()) return;
      const result = await request('/api/create-checkout-session', {
        method: 'POST', headers: { ...headers, Authorization: `Bearer ${latest.access_token}` },
        body: JSON.stringify({ channel: 'web', uiMode: 'embedded' })
      });
      if (!isCurrent()) return;
      // Keep session credentials only in memory. Never put them in a URL,
      // browser storage, analytics, or application logs.
      if (!/^pk_(live|test)_[A-Za-z0-9]+$/.test(result.publishableKey || '') ||
          !/^cs_(?:live_|test_)?[A-Za-z0-9]+$/.test(result.sessionId || '') ||
          typeof result.clientSecret !== 'string' || !result.clientSecret.startsWith(`${result.sessionId}_secret_`)) {
        throw new Error('Secure checkout could not be opened. Please try again.');
      }
      await currentSession();
      if (!isCurrent()) return;
      const stripe = window.Stripe(result.publishableKey);
      const instance = await stripe.createEmbeddedCheckoutPage({
        fetchClientSecret: async () => {
          await currentSession();
          if (!isCurrent()) throw new Error('Checkout was closed.');
          return result.clientSecret;
        },
        onComplete: () => {
          if (!isCurrent()) return;
          generation++;
          busy = false;
          // The dashboard confirms ownership and paid status on the server.
          // A client callback never grants Pro access on its own.
          destroyCheckout();
          showMessage('Confirming your subscription…', 'Checking payment and Pro access.', '', true);
          location.assign(`/dashboard.html?billing=success&session_id=${encodeURIComponent(result.sessionId)}`);
        }
      });
      if (!isCurrent()) { instance.destroy(); return; }
      checkout = instance;
      checkout.mount('#checkout-mount');
      message.hidden = true;
      surface.setAttribute('aria-busy', 'false');
    } catch (error) {
      if (!isCurrent()) return;
      destroyCheckout();
      const signIn = error.status === 401 || error.status === 403;
      if (signIn) intro.hidden = true;
      showMessage(signIn ? 'Sign in to your café' : 'Checkout could not be opened',
        signIn ? 'Please log in with a café account to continue.' : error.name === 'AbortError'
          ? 'Checkout took too long to respond. Please try again.'
          : error.message || 'Please check your connection and try again.', signIn ? 'login' : 'retry');
    } finally {
      if (isCurrent()) { busy = false; retry.disabled = false; }
    }
  }

  retry.addEventListener('click', () => { void openCheckout(); });
  window.addEventListener('pagehide', () => { generation++; busy = false; destroyCheckout(); intro.hidden = true; });
  window.addEventListener('pageshow', event => { if (event.persisted) void openCheckout(); });
  void openCheckout();
})();
