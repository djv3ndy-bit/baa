/** Display-only adapter for the authenticated account billing response. */
(function (root) {
  const providers = { apple: 'Apple', google: 'Google Play', stripe: 'Stripe' };
  const urls = { apple: 'https://apps.apple.com/account/subscriptions', google: 'https://play.google.com/store/account/subscriptions?package=com.baristajobmatch.app' };
  function present(billing, accountId) {
    const status = billing?.nativeStatus;
    if (!status) return null;
    if (status.verified !== true || status.accountId !== accountId || !['free', 'pro'].includes(status.access)) throw new Error('Please reload your subscription status.');
    const provider = providers[status.provider];
    const paid = status.access === 'pro';
    const end = status.status === 'grace' ? status.gracePeriodEnd : status.currentPeriodEnd;
    const date = end && Number.isFinite(Date.parse(end)) ? new Date(end).toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: 'numeric' }) : '';
    let title = paid ? 'Pro · Active' : 'Free · Active · $0';
    let detail = paid ? `Your Pro access is verified through ${provider}.` : 'Your first lifetime job, matches, messages, and interview scheduling are included.';
    if (paid && date) detail += ` ${status.status === 'grace' ? 'Grace access ends' : status.autoRenews ? 'Current period ends' : 'Access ends'} ${date}.`;
    if (status.status === 'grace') detail += ' Review your payment method with your billing provider.';
    if (status.status === 'payment_required') { title = 'Payment needs attention'; detail = 'Review your existing subscription before purchasing again.'; }
    if (status.status === 'pending') { title = 'Purchase pending'; detail = 'A purchase is still being confirmed. Restore purchases in the app or contact subscription support.'; }
    return { title, detail, manageable: Boolean(billing.canManageBilling), links: Object.entries(urls)
      .filter(([provider]) => status.subscriptions?.some(row => row.provider === provider && row.canManage))
      .map(([provider, url]) => ({ label: `Manage ${providers[provider]} subscription`, url })) };
  }
  function render({ billing, accountId, plan, detail, button }) {
    const result = present(billing, accountId);
    if (!result) return false;
    plan.textContent = result.title; detail.textContent = result.detail;
    button.disabled = false; delete button.dataset.retry;
    button.dataset.manageable = String(result.manageable);
    button.textContent = result.manageable ? 'Manage subscription' : 'View Free and Pro plans';
    detail.parentElement.querySelector('[data-store-management]')?.remove();
    if (result.links.length) {
      const links = document.createElement('p'); links.dataset.storeManagement = '';
      for (const [index, item] of result.links.entries()) {
        if (index) links.append(document.createTextNode(' · '));
        const link = document.createElement('a'); link.textContent = item.label; link.href = item.url;
        links.append(link);
      }
      detail.after(links);
    }
    return true;
  }
  root.BaristaMatchAccountBilling = Object.freeze({ present, render });
})(typeof window === 'undefined' ? globalThis : window);
