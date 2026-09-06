import test from 'node:test';
import assert from 'node:assert/strict';
import handler, { storedObjectsForProfile } from '../api/delete-account.js';

const USER = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const BASE = 'https://project.supabase.co';
const response = (data, status = 200) => new Response(JSON.stringify(data), { status });

function setup(t, options = {}) {
  const oldFetch = globalThis.fetch;
  const keys = ['SUPABASE_URL', 'SUPABASE_PUBLISHABLE_KEY', 'SUPABASE_SECRET_KEY'];
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  Object.assign(process.env, { SUPABASE_URL: BASE, SUPABASE_PUBLISHABLE_KEY: 'publishable-test', SUPABASE_SECRET_KEY: options.legacy ? 'legacy-service-key' : 'sb_secret_test' });
  t.after(() => {
    globalThis.fetch = oldFetch;
    for (const key of keys) previous[key] === undefined ? delete process.env[key] : process.env[key] = previous[key];
  });
  const files = new Map(['coffee-videos', 'cafe-images'].map(bucket => [bucket, new Set(options.files?.[bucket] || [])]));
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const path = new URL(url).pathname;
    const call = { path, method: init.method || 'GET', headers: init.headers, body: init.body ? JSON.parse(init.body) : null };
    calls.push(call);
    const override = options.override?.(call, calls);
    if (override !== undefined) return override;
    if (path === '/auth/v1/user') return response({ id: USER });
    if (path === '/rest/v1/profiles') return response(options.profiles || []);
    if (path.startsWith('/storage/v1/object/list/')) {
      const bucket = path.split('/').at(-1);
      const { prefix, offset, limit } = call.body;
      const entries = new Map();
      for (const file of files.get(bucket)) {
        if (!file.startsWith(prefix)) continue;
        const remainder = file.slice(prefix.length);
        const folder = remainder.includes('/');
        const name = remainder.split('/')[0];
        entries.set(name, { name, id: folder ? null : `object-${name}`, metadata: folder ? null : {} });
      }
      return response([...entries.values()].sort((a, b) => a.name.localeCompare(b.name)).slice(offset, offset + limit));
    }
    if (path.startsWith('/storage/v1/object/') && call.method === 'DELETE') {
      const bucket = path.split('/').at(-1);
      for (const file of call.body.prefixes) {
        assert.ok(file.startsWith(`${USER}/`), 'must not delete another member file');
        if (!options.leaveFiles) files.get(bucket).delete(file);
      }
      return response([]);
    }
    if (path === `/auth/v1/admin/users/${USER}` && call.method === 'DELETE') return response({ id: USER });
    throw new Error(`Unexpected test request: ${path}`);
  };
  const res = {
    statusCode: 200, headers: {}, body: null,
    setHeader(name, value) { this.headers[name] = value; },
    status(value) { this.statusCode = value; return this; },
    json(value) { this.body = value; return this; }
  };
  return {
    calls, files, res,
    run: (overrides = {}) => handler({ method: 'POST', headers: { authorization: 'Bearer valid-session' }, body: { confirmation: 'DELETE' }, ...overrides }, res),
    identityDeleted: () => calls.some(call => call.path.startsWith('/auth/v1/admin/users/') && call.method === 'DELETE')
  };
}

test('profile files: includes all owned media and deduplicates references', () => {
  const image = `${BASE}/storage/v1/object/public/cafe-images/${USER}/avatar.jpg`;
  assert.deepEqual(storedObjectsForProfile({ avatar_url: image, bar_picture_url: image, video_path: `${USER}/video.mp4` }, USER, BASE), [
    ['coffee-videos', `${USER}/video.mp4`], ['cafe-images', `${USER}/avatar.jpg`]
  ]);
});
test('profile files: rejects another member, external origins and traversal', () => {
  assert.deepEqual(storedObjectsForProfile({ video_path: `${OTHER}/x.mp4`, avatar_url: `${BASE}/storage/v1/object/public/cafe-images/${USER}/%2e%2e/x.jpg`, bar_picture_url: `https://evil.example/storage/v1/object/public/cafe-images/${USER}/x.jpg` }, USER, BASE), []);
});
test('rejects GET without making requests', async t => {
  const mock = setup(t); await mock.run({ method: 'GET' });
  assert.equal(mock.res.statusCode, 405); assert.equal(mock.calls.length, 0);
  assert.equal(mock.res.headers.Allow, 'POST');
});
test('missing server configuration fails closed', async t => {
  const mock = setup(t); delete process.env.SUPABASE_SECRET_KEY; await mock.run();
  assert.equal(mock.res.statusCode, 503); assert.equal(mock.calls.length, 0);
});
test('requires explicit deletion confirmation', async t => {
  const mock = setup(t); await mock.run({ body: { confirmation: 'yes' } });
  assert.equal(mock.res.statusCode, 400); assert.equal(mock.calls.length, 0);
});
test('requires authentication', async t => {
  const mock = setup(t); await mock.run({ headers: {} });
  assert.equal(mock.res.statusCode, 401); assert.equal(mock.calls.length, 0);
});
test('rejects an expired session', async t => {
  const mock = setup(t, { override: c => c.path === '/auth/v1/user' ? response({}, 401) : undefined });
  await mock.run(); assert.equal(mock.res.statusCode, 401); assert.equal(mock.identityDeleted(), false);
});
test('does not misreport an auth service outage as bad credentials', async t => {
  const mock = setup(t, { override: c => c.path === '/auth/v1/user' ? response({}, 503) : undefined });
  await mock.run(); assert.equal(mock.res.statusCode, 502); assert.equal(mock.identityDeleted(), false);
});
test('does not trust malformed authenticated user IDs', async t => {
  const mock = setup(t, { override: c => c.path === '/auth/v1/user' ? response({ id: '../other-user' }) : undefined });
  await mock.run(); assert.equal(mock.res.statusCode, 502); assert.equal(mock.identityDeleted(), false);
});
test('profile lookup failure cannot delete the identity', async t => {
  const mock = setup(t, { override: c => c.path === '/rest/v1/profiles' ? response({}, 503) : undefined });
  await mock.run(); assert.equal(mock.res.statusCode, 502); assert.equal(mock.identityDeleted(), false);
  assert.equal(mock.calls.some(c => c.method === 'DELETE'), false);
});
test('malformed profile response fails closed', async t => {
  const mock = setup(t, { override: c => c.path === '/rest/v1/profiles' ? response({ error: 'not an array' }) : undefined });
  await mock.run(); assert.equal(mock.res.statusCode, 502); assert.equal(mock.identityDeleted(), false);
});
test('a genuinely missing profile still permits deletion of the authenticated account', async t => {
  const mock = setup(t); await mock.run();
  assert.equal(mock.res.statusCode, 200); assert.equal(mock.identityDeleted(), true);
});
test('storage inventory failure makes no destructive calls', async t => {
  const mock = setup(t, { override: c => c.path.endsWith('/list/cafe-images') ? response({}, 503) : undefined });
  await mock.run(); assert.equal(mock.res.statusCode, 502); assert.equal(mock.calls.some(c => c.method === 'DELETE'), false);
});
for (const name of ['../other.jpg', '.', '..', 'nested/file.jpg', 'folder\\file.jpg', '\u0000bad']) {
  test(`rejects unsafe storage row ${JSON.stringify(name)}`, async t => {
    const mock = setup(t, { override: c => c.path.includes('/object/list/') ? response([{ id: 'file', name, metadata: {} }]) : undefined });
    await mock.run(); assert.equal(mock.res.statusCode, 502); assert.equal(mock.identityDeleted(), false);
  });
}
test('cleans superseded uploads, nested folders and every page; preserves other users', async t => {
  const images = Array.from({ length: 105 }, (_, i) => `${USER}/image-${String(i).padStart(3, '0')}.jpg`);
  const mock = setup(t, { files: { 'cafe-images': [...images, `${USER}/nested/old.jpg`, `${OTHER}/keep.jpg`], 'coffee-videos': [`${USER}/old-video.mp4`] } });
  await mock.run({ body: { confirmation: 'DELETE', user_id: OTHER } });
  assert.equal(mock.res.statusCode, 200);
  assert.deepEqual([...mock.files.get('cafe-images')], [`${OTHER}/keep.jpg`]);
  assert.equal(mock.files.get('coffee-videos').size, 0);
  assert.ok(mock.calls.some(c => c.body?.offset === 100));
  assert.ok(mock.calls.some(c => c.body?.prefix === `${USER}/nested/`));
  assert.equal(mock.calls.at(-1).path, `/auth/v1/admin/users/${USER}`);
  assert.ok(mock.calls.filter(c => c.method === 'DELETE' && c.body).every(c => c.body.prefixes.length <= 100));
});
test('modern secret keys are not sent as JWT Authorization headers', async t => {
  const mock = setup(t); await mock.run();
  assert.equal(mock.calls.find(c => c.path === '/rest/v1/profiles').headers.Authorization, undefined);
  assert.equal(mock.calls[0].headers.Authorization, 'Bearer valid-session');
});
test('legacy server keys retain their required Authorization header', async t => {
  const mock = setup(t, { legacy: true }); await mock.run();
  assert.equal(mock.calls.find(c => c.path === '/rest/v1/profiles').headers.Authorization, 'Bearer legacy-service-key');
});
test('storage deletion error cannot delete identity', async t => {
  const mock = setup(t, { files: { 'cafe-images': [`${USER}/x.jpg`] }, override: c => c.method === 'DELETE' ? response({}, 503) : undefined });
  await mock.run(); assert.equal(mock.res.statusCode, 502); assert.equal(mock.identityDeleted(), false);
});
test('cleanup must be verified before deleting identity', async t => {
  const mock = setup(t, { files: { 'cafe-images': [`${USER}/x.jpg`] }, leaveFiles: true });
  await mock.run(); assert.equal(mock.res.statusCode, 502); assert.equal(mock.identityDeleted(), false);
});
test('identity deletion failure does not report success', async t => {
  const mock = setup(t, { override: c => c.path.includes('/admin/users/') ? response({}, 503) : undefined });
  await mock.run(); assert.equal(mock.res.statusCode, 502); assert.equal(mock.res.body.success, undefined);
});
test('timeouts report a retryable error without leaking credentials', async t => {
  const mock = setup(t, { override: () => { throw new DOMException('private upstream details', 'TimeoutError'); } });
  await mock.run(); assert.equal(mock.res.statusCode, 504); assert.equal(mock.identityDeleted(), false);
  assert.doesNotMatch(JSON.stringify(mock.res.body), /private upstream|sb_secret|valid-session/);
});
