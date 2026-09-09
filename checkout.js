(() => {
  'use strict';
  let stripeScriptPromise;
  function loadStripe() {
    if (typeof window.Stripe === 'function') return Promise.resolve();
    if (!stripeScriptPromise) stripeScriptPromise = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      const fail = () => { clearTimeout(timer); script.remove(); stripeScriptPromise = null; reject(new Error('The payment form did not load. Please try again.')); };
      const timer = setTimeout(fail, 20000);
      script.src = 'https://js.stripe.com/dahlia/stripe.js';
      script.async = true;
      script.onload = () => { if (typeof window.Stripe !== 'function') return fail(); clearTimeout(timer); resolve(); };
      script.onerror = fail;
      document.head.appendChild(script);
    });
    return stripeScriptPromise;
  }

  function createController(options = {}) {
  const surface = document.getElementById('checkout-surface');
  const intro = document.getElementById('checkout-intro');
  const message = document.getElementById('checkout-message');
  const title = document.getElementById('checkout-message-title');
  const detail = document.getElementById('checkout-message-detail');
  const spinner = document.getElementById('checkout-spinner');
  const retry = document.getElementById('checkout-retry');
  const login = document.getElementById('checkout-login');
  const manage = document.getElementById('checkout-manage');
  const hosted = document.getElementById('checkout-hosted');
  const mount = document.getElementById('checkout-mount');
  let client = options.client, ownerId = options.ownerId, checkout, authSubscription, generation = 0, busy = false, disposed = false;

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
    hosted.hidden = action !== 'hosted';
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

  async function openCheckout({ continueHosted = false } = {}) {
    if (busy || disposed) return;
    busy = true;
    retry.disabled = true;
    hosted.disabled = true;
    const attempt = ++generation;
    const isCurrent = () => !disposed && attempt === generation;
    destroyCheckout();
    intro.hidden = true;
    showMessage('Opening secure checkout…', 'Checking your café account and subscription.', '', true);
    try {
      const config = await request('/api/config');
      if (!isCurrent()) return;
      const embeddedReady = config.stripeEmbeddedCheckoutConfigured === true;
      if (!client) {
        if (!window.supabase?.createClient) throw new Error('The account service did not load. Refresh this page to try again.');
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
      if (!embeddedReady && !continueHosted) {
        showMessage('Ready for your next hire?', 'Continue to secure checkout to choose how you pay.', 'hosted');
        return;
      }
      if (embeddedReady) { await loadStripe(); if (!isCurrent()) return; }
      const latest = await currentSession();
      if (!isCurrent()) return;
      const result = await request('/api/create-checkout-session', {
        method: 'POST', headers: { ...headers, Authorization: `Bearer ${latest.access_token}` },
        body: JSON.stringify(embeddedReady ? { channel: 'web', uiMode: 'embedded' } : { channel: 'web' })
      });
      if (!isCurrent()) return;
      if (!embeddedReady) {
        if (typeof result.url !== 'string' || !/^https:\/\/checkout\.stripe\.com\//.test(result.url)) {
          throw new Error('Secure checkout could not be opened. Please try again.');
        }
        await currentSession();
        if (!isCurrent()) return;
        generation++;
        busy = false;
        location.assign(result.url);
        return;
      }
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
      if (isCurrent()) { busy = false; retry.disabled = false; hosted.disabled = false; }
    }
  }

  const retryClick = () => { void openCheckout(); };
  const hostedClick = () => { void openCheckout({ continueHosted: true }); };
  const pageHide = () => { generation++; busy = false; destroyCheckout(); intro.hidden = true; };
  const pageShow = event => { if (event.persisted) void openCheckout(); };
  retry.addEventListener('click', retryClick);
  hosted.addEventListener('click', hostedClick);
  window.addEventListener('pagehide', pageHide);
  window.addEventListener('pageshow', pageShow);
  void openCheckout();
  return {
    destroy() {
      disposed = true;
      pageHide();
      authSubscription?.unsubscribe();
      retry.removeEventListener('click', retryClick);
      hosted.removeEventListener('click', hostedClick);
      window.removeEventListener('pagehide', pageHide);
      window.removeEventListener('pageshow', pageShow);
    }
  };
  }

  let activeController;
  window.BaristaMatchCheckout = {
    mount(options) { this.destroy(); activeController = createController(options); },
    destroy() { activeController?.destroy(); activeController = null; }
  };
})();
