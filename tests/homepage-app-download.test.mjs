import assert from 'node:assert/strict';
import test from 'node:test';
import { getAppDownloadOffer, initAppDownload } from '../homepage/app-download.js';

const ANDROID_URL = 'https://play.google.com/store/apps/details?id=com.baristajobmatch.app';

function browser({userAgent = 'Mozilla/5.0 (Linux; Android 16)', width = 390, standalone = false, dismissed = false} = {}) {
  const values = new Map(dismissed ? [['baristamatch_app_strip_dismissed', '1']] : []);
  return {
    navigator: {userAgent},
    matchMedia(query) { return {matches: query.includes('standalone') ? standalone : width <= 680}; },
    localStorage: {getItem: key => values.get(key), setItem: (key, value) => values.set(key, value)}
  };
}

function documentFixture() {
  const elements = [];
  const createElement = tagName => {
    const node = {
      tagName, children: [], attributes: {}, listeners: {}, removed: false,
      append(...children) { this.children.push(...children); },
      prepend(child) { this.children.unshift(child); },
      setAttribute(name, value) { this.attributes[name] = value; },
      addEventListener(name, handler) { this.listeners[name] = handler; },
      remove() { this.removed = true; }
    };
    elements.push(node);
    return node;
  };
  return {
    head: createElement('head'), body: createElement('body'), createElement,
    getElementById(id) { return elements.find(node => node.id === id && !node.removed) || null; }
  };
}

test('Android phones and tablets receive the verified Google Play option', () => {
  for (const width of [320, 390, 800, 1280]) {
    const offer = getAppDownloadOffer(browser({width}));
    assert.equal(offer.platform, 'android');
    assert.equal(offer.href, ANDROID_URL);
    assert.equal(offer.label, 'Get BaristaMatch on Google Play');
  }
});

test('iPhone and iPad browsers receive no app prompt at any width', () => {
  for (const userAgent of ['iPhone', 'iPad', 'iPod', 'Mozilla/5.0 (Macintosh; Intel Mac OS X)']) {
    for (const width of [320, 390, 680, 800, 1280]) {
      const view = {...browser({userAgent, width}), document: documentFixture()};
      assert.equal(getAppDownloadOffer(view), null);
      assert.equal(initAppDownload(view), null);
      assert.equal(view.document.body.children.length, 0);
    }
  }
});

test('desktop browsers and installed standalone contexts have no banner', () => {
  for (const userAgent of ['Mozilla/5.0 (Windows NT 10.0)', 'Mozilla/5.0 (Macintosh)']) {
    assert.equal(getAppDownloadOffer(browser({userAgent})), null);
  }
  assert.equal(getAppDownloadOffer(browser({standalone: true})), null);
  const iosApp = browser({userAgent: 'iPhone'});
  iosApp.navigator.standalone = true;
  assert.equal(getAppDownloadOffer(iosApp), null);
});

test('the Android banner offers a link and dismisses without navigating', () => {
  const view = {...browser({width: 320}), document: documentFixture()};
  const strip = initAppDownload(view);
  assert.equal(strip.attributes['data-platform'], 'android');
  const link = strip.children.find(node => node.tagName === 'a');
  assert.equal(link.href, ANDROID_URL);
  assert.equal(link.target, '_blank');
  assert.equal(link.attributes['aria-label'], 'Get BaristaMatch on Google Play');
  assert.equal(link.textContent, 'Google Play');
  assert.equal(view.location, undefined);
  assert.equal(initAppDownload(view), null, 'Do not insert a second banner');

  const close = strip.children.find(node => node.tagName === 'button');
  assert.equal(close.type, 'button');
  assert.equal(close.attributes['aria-label'], 'Dismiss app suggestion');
  close.listeners.click();
  assert.equal(strip.removed, true);
  assert.equal(initAppDownload(view), null, 'Remember dismissal on a later initialization');
});

test('remembered dismissal prevents Android suggestions', () => {
  assert.equal(getAppDownloadOffer(browser({dismissed: true})), null);
});

test('blocked storage does not prevent the option or its dismissal', () => {
  for (const getterThrows of [false, true]) {
    const view = {...browser(), document: documentFixture()};
    if (getterThrows) {
      Object.defineProperty(view, 'localStorage', {get() { throw new Error('Storage blocked'); }});
    } else {
      view.localStorage = {
        getItem() { throw new Error('Storage blocked'); },
        setItem() { throw new Error('Storage blocked'); }
      };
    }
    const strip = initAppDownload(view);
    assert.ok(strip);
    assert.doesNotThrow(() => strip.children.find(node => node.tagName === 'button').listeners.click());
    assert.equal(strip.removed, true);
  }
});
