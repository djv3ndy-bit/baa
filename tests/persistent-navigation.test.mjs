import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const context = { window: {} };
vm.runInNewContext(fs.readFileSync('dashboard-quiet-focus.js', 'utf8'), context);
const { syncMobileNav } = context.window.BaristaMatchQuietFocus;
function hostFixture() {
  let buttons = [], renders = 0;
  return {
    dataset: {},
    set innerHTML(html) {
      renders++;
      buttons = [...html.matchAll(/data-go="([^"]+)"/g)].map(match => ({
        dataset: { go: match[1] }, active: false, attrs: {},
        classList: { toggle(_name, active) { this.owner.active = active; } },
        setAttribute(key, value) { this.attrs[key] = value; },
        removeAttribute(key) { delete this.attrs[key]; }
      }));
      buttons.forEach(button => { button.classList.owner = button; });
    },
    querySelectorAll: () => buttons,
    contains: button => buttons.includes(button),
    get buttons() { return buttons; },
    get renders() { return renders; }
  };
}
test('tabs remain mounted and active state follows each barista page', () => {
  const host = hostFixture();
  for (const page of ['Overview', 'Discover', 'Find Jobs', 'Matches', 'Messages', 'My Profile', 'Overview']) {
    syncMobileNav(host, false, page, () => {});
    assert.equal(host.renders, 1, 'page changes must preserve the navigation DOM');
    assert.equal(host.buttons.length, 5);
    const selected = host.buttons.filter(button => button.active);
    assert.equal(selected.length, 1);
    assert.equal(selected[0].dataset.go, page === 'Find Jobs' ? 'Discover' : page);
    assert.equal(selected[0].attrs['aria-current'], 'page');
  }
});
test('tabs navigate from icon clicks, stay visible in settings, and support café pages', () => {
  const host = hostFixture();
  let destination;
  syncMobileNav(host, false, 'Account Settings', page => { destination = page; });
  assert.equal(host.buttons.length, 5);
  assert.equal(host.buttons.filter(button => button.active).length, 0);
  const messages = host.buttons.find(button => button.dataset.go === 'Messages');
  host.onclick({ target: { closest: () => messages } });
  assert.equal(destination, 'Messages');
  syncMobileNav(host, true, 'Job Posts', () => {});
  assert.equal(host.buttons.find(button => button.active).dataset.go, 'Job Posts');
});
test('navigation host sits outside the replaceable content section', () => {
  const html = fs.readFileSync('dashboard.html', 'utf8');
  assert.match(html, /<section class="content" id="content"><\/section>\s*<\/main>\s*<div id="dashboard-mobile-navigation"><\/div>/);
  assert.match(html, /syncMobileNav\(document\.getElementById\('dashboard-mobile-navigation'\)/);
});
