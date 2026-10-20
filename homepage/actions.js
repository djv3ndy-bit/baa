let actions;

/** Bind account links and navigation before starting the independent session check. */
export function initHomepageActions() {
  if (actions) return actions;

  const header = document.getElementById('site-header');
  const mobile = document.getElementById('mobile-menu');
  const navigation = document.getElementById('nav-links');
  const resource = document.getElementById('resource-menu');
  const resourceButton = resource?.querySelector('button');
  const resourcePopover = resource?.querySelector('.resource-popover');
  const dialog = document.getElementById('role-dialog');
  const guestActions = document.getElementById('guest-actions');
  const userActions = document.getElementById('user-actions');
  const mobileLogin = document.getElementById('mobile-login');
  const logout = document.getElementById('logout-button');
  let dialogOpener = null;
  let warned = false;

  function warnSessionUnavailable() {
    if (warned) return;
    warned = true;
    console.warn('Session check unavailable');
  }

  function closeResources() {
    resource?.classList.remove('open');
    resourceButton?.setAttribute('aria-expanded', 'false');
  }

  function closeMenu() {
    header?.classList.remove('open');
    mobile?.setAttribute('aria-expanded', 'false');
    mobile?.setAttribute('aria-label', 'Open menu');
    closeResources();
  }

  if (mobile) {
    if (navigation?.id) mobile.setAttribute('aria-controls', navigation.id);
    mobile.setAttribute('aria-expanded', 'false');
    mobile.setAttribute('aria-label', 'Open menu');
    mobile.addEventListener('click', () => {
      if (!header) return;
      const open = !header.classList.contains('open');
      header.classList.toggle('open', open);
      mobile.setAttribute('aria-expanded', String(open));
      mobile.setAttribute('aria-label', open ? 'Close menu' : 'Open menu');
      if (!open) closeResources();
    });
  }

  if (resourceButton) {
    resourceButton.setAttribute('aria-expanded', 'false');
    if (resourcePopover) {
      if (!resourcePopover.id) resourcePopover.id = 'resource-popover';
      resourceButton.setAttribute('aria-controls', resourcePopover.id);
    }
    resourceButton.addEventListener('click', event => {
      event.stopPropagation();
      const open = resource.classList.toggle('open');
      resourceButton.setAttribute('aria-expanded', String(open));
    });
  }

  header?.querySelectorAll('a').forEach(link => {
    link.addEventListener('click', closeMenu);
  });
  document.addEventListener('click', event => {
    if (!resource?.contains(event.target)) closeResources();
    if (!header?.contains(event.target)) closeMenu();
  });
  document.addEventListener('keydown', event => {
    if (event.key !== 'Escape') return;
    const menuWasOpen = Boolean(header?.classList.contains('open'));
    const resourcesWereOpen = Boolean(resource?.classList.contains('open'));
    closeMenu();
    // The native dialog handles Escape and restores focus when it closes.
    if (dialog?.open) return;
    if (menuWasOpen) mobile?.focus();
    else if (resourcesWereOpen) resourceButton?.focus();
  });

  document.querySelectorAll('[data-role]').forEach(control => {
    control.addEventListener('click', event => {
      if (document.body.dataset.signedIn === 'true') {
        if (control instanceof HTMLAnchorElement) {
          control.href = '/dashboard.html';
        } else {
          event.preventDefault();
          location.href = '/dashboard.html';
        }
      } else if (!(control instanceof HTMLAnchorElement)) {
        event.preventDefault();
        location.href = '/signup.html?role=' + encodeURIComponent(control.dataset.role || '');
      }
    });
  });

  if (dialog) {
    const title = dialog.querySelector('h2');
    if (title) {
      if (!title.id) title.id = 'role-dialog-title';
      dialog.setAttribute('aria-labelledby', title.id);
    }
    const close = dialog.querySelector('#dialog-close, .dialog-close');
    close?.setAttribute('aria-label', 'Close');
    close?.addEventListener('click', () => dialog.close());
    dialog.addEventListener('click', event => {
      if (event.target !== dialog) return;
      const bounds = dialog.getBoundingClientRect();
      if (event.clientX < bounds.left || event.clientX > bounds.right ||
          event.clientY < bounds.top || event.clientY > bounds.bottom) {
        dialog.close();
      }
    });
    dialog.addEventListener('close', () => {
      // Native restoration handles visible openers. A mobile menu opener can
      // become hidden when that menu closes, so return to its toggle instead.
      const opener = dialogOpener;
      dialogOpener = null;
      if (opener?.isConnected && opener.getClientRects().length) return;
      if (mobile?.getClientRects().length) mobile.focus({preventScroll: true});
    });
  }
  document.querySelectorAll('[data-open-role]').forEach(button => {
    button.addEventListener('click', event => {
      event.preventDefault();
      dialogOpener = button;
      closeMenu();
      if (dialog && typeof dialog.showModal === 'function') {
        if (!dialog.open) dialog.showModal();
      } else {
        location.href = '/signup.html';
      }
    });
  });

  function syncMobileLogin() {
    if (!mobileLogin) return;
    const signedIn = userActions ? !userActions.hidden : document.body.dataset.signedIn === 'true';
    mobileLogin.hidden = false;
    mobileLogin.href = signedIn ? '/dashboard.html' : '/login.html';
    mobileLogin.textContent = signedIn ? 'Dashboard' : 'Log in';
  }

  function setSignedIn(signedIn) {
    document.body.dataset.signedIn = String(signedIn);
    if (guestActions) guestActions.hidden = signedIn;
    if (userActions) userActions.hidden = !signedIn;
    document.querySelectorAll('a[data-role]').forEach(link => {
      link.href = signedIn ? '/dashboard.html' :
        '/signup.html?role=' + encodeURIComponent(link.dataset.role || '');
    });
    syncMobileLogin();
  }

  syncMobileLogin();
  if (userActions && typeof MutationObserver !== 'undefined') {
    new MutationObserver(syncMobileLogin).observe(userActions, {
      attributes: true, attributeFilter: ['hidden']
    });
  }

  async function checkSession() {
    try {
      const response = await fetch('/api/config', {cache: 'no-store'});
      const config = await response.json();
      if (!response.ok || !config.supabaseUrl || !config.supabasePublishableKey ||
          typeof window.supabase?.createClient !== 'function') {
        warnSessionUnavailable();
        return;
      }
      const client = window.supabase.createClient(config.supabaseUrl, config.supabasePublishableKey);
      const result = await client.auth.getSession();
      if (result.error) {
        await client.auth.signOut({scope: 'local'}).catch(() => {});
        setSignedIn(false);
        warnSessionUnavailable();
        return;
      }
      const session = result.data?.session;
      setSignedIn(Boolean(session));
      if (session && logout) {
        logout.addEventListener('click', async () => {
          logout.disabled = true;
          try {
            await client.auth.signOut();
            location.reload();
          } catch {
            logout.disabled = false;
            warnSessionUnavailable();
          }
        });
      }
    } catch {
      warnSessionUnavailable();
    }
  }

  // Preserve the installed web app's existing entry route.
  if ((matchMedia('(display-mode: standalone)').matches || navigator.standalone === true) &&
      location.pathname === '/') {
    location.replace('/login.html');
  }

  actions = {sessionReady: checkSession()};
  return actions;
}
