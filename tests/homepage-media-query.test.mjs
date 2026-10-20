import assert from 'node:assert/strict';
import test from 'node:test';
import { listenMediaQuery } from '../homepage/media-query.js';

test('modern preference changes stop reaching the handler after cleanup', () => {
  const query = new EventTarget();
  const changes = [];
  query.matches = false;
  query.addListener = () => assert.fail('Legacy API should not be used');
  const unsubscribe = listenMediaQuery(query, () => changes.push(query.matches));

  query.matches = true;
  query.dispatchEvent(new Event('change'));
  unsubscribe();
  query.matches = false;
  query.dispatchEvent(new Event('change'));

  assert.deepEqual(changes, [true]);
});

test('older Safari receives the listener directly and removes that same listener', () => {
  const listeners = new Set();
  const calls = [];
  const query = {
    matches: false,
    addListener(listener) {
      assert.equal(this, query);
      assert.equal(arguments.length, 1);
      listeners.add(listener);
    },
    removeListener(listener) {
      assert.equal(this, query);
      assert.equal(arguments.length, 1);
      assert.equal(listener, handler);
      listeners.delete(listener);
    }
  };
  function handler(event) { calls.push(event.matches); }
  const unsubscribe = listenMediaQuery(query, handler);
  query.matches = true;
  for (const listener of listeners) listener({matches: query.matches});
  unsubscribe();
  query.matches = false;
  for (const listener of listeners) listener({matches: query.matches});

  assert.deepEqual(calls, [true]);
  assert.equal(listeners.size, 0);
});

test('browsers without preference listeners retain the initial match without throwing', () => {
  for (const query of [undefined, null, {}, {matches: true}]) {
    const unsubscribe = listenMediaQuery(query, () => assert.fail('No change API exists'));
    assert.equal(typeof unsubscribe, 'function');
    assert.doesNotThrow(unsubscribe);
  }
});
