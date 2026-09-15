import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const html = readFileSync(new URL('../mobile-billing-return.html', import.meta.url), 'utf8');
const script = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)]
  .filter(([, attributes]) => !/\bsrc\s*=/.test(attributes))
  .map(([, , body]) => body).join('\n');

function returnPage(search = '', options = {}) {
  const events = [], timers = [];
  const link = { href: 'baristamatch://settings?billing=complete' };
  const status = { textContent: html.match(/<p id="status">([^<]+)<\/p>/)[1] };
  const location = {
    pathname: options.pathname || '/mobile-billing-return', search,
    hash: options.hash || '',
    replace(url) {
      events.push({ type: 'navigate', url });
      if (options.navigationBlocked) throw new Error('Browser requires a user gesture');
    },
  };
  const forbidden = () => { throw new Error('The return page must not access account data or submit a request'); };
  const context = vm.createContext({
    URLSearchParams, location,
    history: {
      replaceState(state, title, url) {
        events.push({ type: 'history', state, title, url });
        if (options.historyBlocked) throw new Error('History unavailable');
        location.search = '';
        location.hash = '';
      },
    },
    document: { getElementById: id => ({ 'open-app': link, status }[id]) },
    setTimeout(callback, delay) { timers.push({ callback, delay }); },
    fetch: forbidden,
    localStorage: { getItem: forbidden, setItem: forbidden },
    sessionStorage: { getItem: forbidden, setItem: forbidden },
  });
  vm.runInContext(script, context, { timeout: 1000 });
  return { events, timers, link, status, location };
}

test('successful checkout forwards only its valid session ID to the existing Settings route', () => {
  for (const sessionId of ['cs_test_A1b2C3', 'cs_live_A1b2C3', 'cs_A1b2C3']) {
    const page = returnPage(`?billing=success&session_id=${sessionId}`);
    const expected = `baristamatch://settings?billing=success&session_id=${sessionId}`;
    assert.equal(page.link.href, expected);
    assert.equal(page.events.at(-1).url, expected);
    assert.doesNotMatch(page.status.textContent, /complete|paid|confirmed|activated/i);
  }
});

test('cancel, portal and legacy returns keep their existing route and never forward a session ID', () => {
  for (const [query, result] of [
    ['?billing=canceled&session_id=cs_test_unused', 'canceled'],
    ['?billing=portal&session_id=cs_test_unused', 'portal'],
    ['?billing=success', 'success'],
    ['?billing=complete&session_id=cs_test_unused', 'complete'],
    ['', 'complete'],
    ['?billing=unknown&session_id=cs_test_unused', 'complete'],
  ]) {
    const page = returnPage(query);
    assert.equal(page.link.href, `baristamatch://settings?billing=${result}`);
    // Existing clients can continue reading billing and ignoring new parameters.
    const legacy = new URL(page.link.href);
    assert.equal(legacy.hostname, 'settings');
    assert.equal(legacy.searchParams.get('billing'), result);
  }
});

test('malformed, ambiguous and malicious session IDs cannot enter the app link', () => {
  const invalid = [
    '', 'cs_test_', 'not-a-checkout', 'cs_test_abc/def', 'cs_test_abc_def',
    'cs_test_abc?next=evil', 'cs_test_abc#fragment', 'cs_test_abc&access_token=secret',
    'cs_test_abc\n', 'cs_test_abc\u0000', '<script>alert(1)</script>',
    'https://attacker.invalid', 'javascript:alert(1)', `cs_test_${'a'.repeat(201)}`,
  ];
  for (const id of invalid) {
    assert.equal(returnPage(`?billing=success&session_id=${encodeURIComponent(id)}`).link.href,
      'baristamatch://settings?billing=success', JSON.stringify(id));
  }
  assert.equal(returnPage('?billing=success&session_id=cs_test_one&session_id=cs_test_two').link.href,
    'baristamatch://settings?billing=success');
  assert.equal(returnPage('?billing=javascript%3Aalert(1)&session_id=cs_test_one').link.href,
    'baristamatch://settings?billing=complete');
});

test('query and fragment account data are discarded before navigation and deferred analytics', () => {
  const page = returnPage('?billing=success&session_id=cs_test_receipt&access_token=private-access&refresh_token=private-refresh&next=https%3A%2F%2Fattacker.invalid', {
    hash: '#access_token=private-fragment',
  });
  assert.equal(page.link.href, 'baristamatch://settings?billing=success&session_id=cs_test_receipt');
  assert.deepEqual(page.events[0], { type: 'history', state: null, title: '', url: '/mobile-billing-return' });
  assert.equal(page.events[1].type, 'navigate');
  assert.equal(page.location.search, '');
  assert.equal(page.location.hash, '');
  assert.doesNotMatch(JSON.stringify(page.events), /private-|attacker/);
  const referrerPolicy = html.indexOf('<meta name="referrer" content="no-referrer">');
  assert.ok(referrerPolicy > 0 && referrerPolicy < html.indexOf('<script defer src="/analytics.js">'));
  assert.ok(referrerPolicy < html.indexOf('<img '));
});

test('history cleanup supports both clean and .html URLs without losing the app receipt', () => {
  for (const pathname of ['/mobile-billing-return', '/mobile-billing-return.html']) {
    const page = returnPage('?billing=success&session_id=cs_test_receipt', { pathname });
    assert.equal(page.events[0].url, pathname);
    assert.match(page.link.href, /session_id=cs_test_receipt$/);
  }
});

test('blocked automatic navigation or history cleanup preserves the manual return action', () => {
  for (const options of [{ navigationBlocked: true }, { historyBlocked: true }, { navigationBlocked: true, historyBlocked: true }]) {
    const page = returnPage('?billing=success&session_id=cs_test_receipt', options);
    assert.equal(page.link.href, 'baristamatch://settings?billing=success&session_id=cs_test_receipt');
    assert.equal(page.timers.length, 1);
    assert.equal(page.timers[0].delay, 1200);
    page.timers[0].callback();
    assert.equal(page.status.textContent, 'Tap below to return to the app.');
    assert.doesNotMatch(page.status.textContent, /complete|paid|confirmed|activated/i);
  }
});
