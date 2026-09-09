import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const read = file => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
const dashboard = read('dashboard.html');
const functionBody = (name, next) => dashboard.slice(dashboard.indexOf(`function ${name}(`) - (name === 'mountSubscriptionCheckout' ? 6 : 0), dashboard.indexOf(next, dashboard.indexOf(`function ${name}(`)));
const mountSource = functionBody('mountSubscriptionCheckout', '\nfunction openSection(');
const pricingSource = functionBody('pricingSubscriptionHtml', '\nObject.defineProperty(');
const tick = () => new Promise(setImmediate);

test('Subscription contains one shared plan/payment panel within the existing dashboard navigation', () => {
  const context = { billingReturnState: () => null };
  vm.runInNewContext(pricingSource, context);
  const html = context.pricingSubscriptionHtml();
  assert.match(html, /<h1 class="subscription-page-title">Subscription<\/h1>/);
  assert.equal((html.match(/class="subscription-plan"/g) || []).length, 1);
  assert.equal((html.match(/id="checkout-mount"/g) || []).length, 1);
  assert.ok(html.indexOf('subscription-benefits') < html.indexOf('id="checkout-mount"'));
  assert.match(html, /id="checkout-intro" hidden/);
  assert.match(html, /id="checkout-manage" data-go="Account Settings"/);
  assert.doesNotMatch(html, /<input|<iframe|checkout-header|checkout-brand|bmi-payment-form/);
  assert.match(dashboard, /<nav class="menu" id="menu"><\/nav>/);
  assert.match(dashboard, /<script src="\/checkout.js"><\/script>/);
  assert.doesNotMatch(dashboard, /<script[^>]+js\.stripe\.com/);
});

test('legacy checkout links open the authenticated dashboard without exposing pricing or making payments', () => {
  const legacy = read('checkout.html');
  assert.match(legacy, /location\.replace\('\/dashboard\.html\?section=subscription'\)/);
  assert.doesNotMatch(legacy, /\$9\.99|create-checkout-session|checkout\.js|js\.stripe\.com/);
});

test('dashboard waits for payment reconciliation and ignores a stale section or account', async t => {
  for (const change of ['none', 'section', 'account', 'replaced panel']) await t.test(change, async () => {
    let finish, panel = {};
    const calls = [], client = {};
    const context = {
      currentSection: 'Subscription', currentRole: 'cafe_owner_manager', currentUser: { id: 'cafe' }, activeClient: client,
      document: { getElementById: () => panel },
      reconcileBillingReturn: () => new Promise(resolve => { finish = resolve; }),
      window: { BaristaMatchCheckout: { mount: options => calls.push(options) } },
    };
    vm.runInNewContext(mountSource, context);
    const pending = context.mountSubscriptionCheckout();
    assert.equal(calls.length, 0);
    if (change === 'section') context.currentSection = 'Messages';
    if (change === 'account') context.currentUser = { id: 'other-cafe' };
    if (change === 'replaced panel') panel = {};
    finish(); await pending;
    assert.equal(calls.length, change === 'none' ? 1 : 0);
    if (change === 'none') { assert.equal(calls[0].client, client); assert.equal(calls[0].ownerId, 'cafe'); }
  });
});

test('section navigation destroys payment credentials before replacing the panel', async () => {
  const calls = [];
  const content = { set innerHTML(value) { calls.push('replace content'); } };
  const context = {
    currentSection: 'Subscription', messageRealtimeChannel: null,
    document: { querySelectorAll: () => [], querySelector: selector => selector === '.top h1' ? {} : null, getElementById: id => id === 'content' ? content : null },
    sectionPages: { barista: { 'Account Settings': '<div>Settings</div>' } },
    bindContentActions() {}, markSectionNotificationsRead() {},
    window: {
      BaristaMatchCheckout: { destroy: () => calls.push('destroy checkout') },
      BaristaMatchQuietFocus: { menuLabel: value => value, syncMobileNav() {} }, scrollTo() {},
    },
  };
  vm.runInNewContext(functionBody('openSection', '\n'), context);
  context.openSection('Account Settings', {}, 'barista');
  await tick();
  assert.deepEqual(calls, ['destroy checkout', 'replace content']);
});
