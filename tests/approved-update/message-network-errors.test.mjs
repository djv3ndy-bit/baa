import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// Exercise the approved formatter in the actual app source.
const path = new URL('../../mobile/lib/messaging.ts', import.meta.url);
const source = readFileSync(path, 'utf8');
const start = source.indexOf('export function messageError(');
const end = source.indexOf('\n}\n', start) + 2;
assert.ok(start >= 0 && end > start);
const { messageError } = vm.runInNewContext(`const messageError = (${source.slice(start, end).replace('export ', '').replace('error: unknown', 'error')}); ({messageError});`, { TypeError });

test('gateway errors and HTML responses use the context-specific recovery message', () => {
  for (const message of ['Gateway Timeout', '504 Gateway Timeout', 'Bad Gateway', '502: Bad Gateway', 'Internal Server Error', 'Service Unavailable', '<html><body>Gateway Timeout</body></html>', '<!DOCTYPE html>']) {
    assert.equal(messageError({ message }, 'Messages could not load. Please try again.'), 'Messages could not load. Please try again.');
    assert.equal(messageError({ message }, 'Message could not be sent. Check this conversation before trying again.'), 'Message could not be sent. Check this conversation before trying again.');
  }
});

test('connection errors explain recovery without claiming that a pending message was sent', () => {
  for (const message of ['offline', 'Network request failed', 'Failed to fetch']) assert.match(messageError({ message }), /offline.*connection.*try again/);
  assert.equal(messageError(new TypeError('network')), 'Connection lost. Check this conversation before trying again.');
});

test('account, permission, draft and delivery warnings retain their original meaning', () => {
  for (const message of ['Your session expired. Please log in again.', 'This conversation is not available.', 'Your account changed. Reopen this conversation before sending.', 'Delivery could not be confirmed. Check this conversation before trying again.', 'This message request has changed. Please review your draft.']) assert.equal(messageError({ message }), message);
  for (const error of [null, undefined, {}, { message: '' }]) assert.equal(messageError(error, 'Please retry.'), 'Please retry.');
});
