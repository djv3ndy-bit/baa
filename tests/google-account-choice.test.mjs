import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';
import vm from 'node:vm';

const requireMobile = createRequire(new URL('../mobile/package.json', import.meta.url));
const ts = requireMobile('typescript');
const source = ts.createSourceFile('login.tsx', readFileSync(new URL('../mobile/app/login.tsx', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const screen = source.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'OriginalLoginScreen');
const declarations = ['oauthAppCallback', 'oauthRedirect', 'oauthStart'].map(name => {
  const statement = source.statements.find(node => ts.isVariableStatement(node) && node.declarationList.declarations.some(declaration => declaration.name.getText(source) === name));
  assert.ok(statement, `${name} remains defined in the login screen`);
  return statement.getText(source);
});
for (const name of ['routeSignedIn', 'signInWithProvider']) {
  const declaration = screen?.body.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name);
  assert.ok(declaration, `${name} remains defined in the login screen`);
  declarations.push(declaration.getText(source));
}
const executable = ts.transpileModule(`${declarations.join('\n')}\nglobalThis.providerLogin = signInWithProvider;`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;
const plain = value => JSON.parse(JSON.stringify(value));

function harness({ browserResults = [], users = [], contexts = [] } = {}) {
  const oauthCalls = [], browserCalls = [], exchanges = [], routes = [], loading = [], alerts = [];
  const request = { current: false }, active = { current: true };
  const context = {
    request, active, setSocialLoading: value => loading.push(value),
    supabase: { auth: { signInWithOAuth: async options => {
      oauthCalls.push(plain(options));
      return { data: { url: `https://provider.example.test/authorize?attempt=${oauthCalls.length}` } };
    } } },
    WebBrowser: { openAuthSessionAsync: async (...args) => {
      browserCalls.push(plain(args));
      return browserResults.shift() || { type: 'cancel' };
    } },
    completeMobileAuth: async url => { exchanges.push(url); return users.shift(); },
    getCurrentContext: async () => contexts.shift() || { user: null },
    router: { replace: route => routes.push(plain(route)) },
    Alert: { alert: (...args) => alerts.push(args) },
  };
  vm.runInNewContext(executable, context);
  return { ...context, oauthCalls, browserCalls, exchanges, routes, loading, alerts };
}

test('each explicit native Google attempt requests account selection and preserves the callback bridge', async () => {
  const h = harness({
    browserResults: [{ type: 'success', url: 'callback-one' }, { type: 'success', url: 'callback-two' }],
    users: [{ id: 'account-one' }, { id: 'account-two' }],
    contexts: [{ user: { id: 'account-one' }, role: 'barista' }, { user: { id: 'account-two' }, role: null }],
  });
  await h.providerLogin('google');
  await h.providerLogin('google');
  assert.deepEqual(h.oauthCalls, [1, 2].map(() => ({
    provider: 'google', options: {
      redirectTo: 'https://www.baristajobmatch.com/mobile-auth-callback.html',
      skipBrowserRedirect: true, queryParams: { prompt: 'select_account' },
    },
  })));
  assert.deepEqual(h.browserCalls, [1, 2].map(attempt => [
    `https://www.baristajobmatch.com/mobile-auth-start.html#${encodeURIComponent(`https://provider.example.test/authorize?attempt=${attempt}`)}`,
    'baristamatch://auth/callback', { preferEphemeralSession: false },
  ]));
  assert.deepEqual(h.exchanges, ['callback-one', 'callback-two']);
  assert.deepEqual(h.routes, ['/home', { pathname: '/signup', params: { complete: '1' } }]);
  assert.deepEqual(h.alerts, []);
});

test('native Apple sign-in keeps its existing options without a Google account prompt', async () => {
  const h = harness();
  await h.providerLogin('apple');
  assert.deepEqual(h.oauthCalls, [{ provider: 'apple', options: {
    redirectTo: 'https://www.baristajobmatch.com/mobile-auth-callback.html', skipBrowserRedirect: true,
  } }]);
  assert.deepEqual(h.exchanges, []);
  assert.deepEqual(h.routes, []);
});

test('canceling Google permits another chooser attempt without completing or routing the previous account', async () => {
  const h = harness({
    browserResults: [{ type: 'cancel' }, { type: 'success', url: 'new-account-callback' }],
    users: [{ id: 'new-account' }], contexts: [{ user: { id: 'new-account' }, role: 'barista' }],
  });
  await h.providerLogin('google');
  assert.deepEqual(h.exchanges, []);
  assert.deepEqual(h.routes, []);
  assert.equal(h.request.current, false);
  assert.equal(h.loading.at(-1), null);
  await h.providerLogin('google');
  assert.equal(h.oauthCalls.length, 2);
  assert.ok(h.oauthCalls.every(call => call.options.queryParams.prompt === 'select_account'));
  assert.deepEqual(h.exchanges, ['new-account-callback']);
  assert.deepEqual(h.routes, ['/home']);
});

test('a Google completion cannot route an account that changed before the profile check', async () => {
  const h = harness({
    browserResults: [{ type: 'success', url: 'selected-account-callback' }],
    users: [{ id: 'selected-account' }], contexts: [{ user: { id: 'different-account' }, role: 'barista' }],
  });
  await h.providerLogin('google');
  assert.deepEqual(h.routes, []);
  assert.equal(h.request.current, false);
  assert.equal(h.loading.at(-1), null);
});
