import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';

const mobile = new URL('../mobile/', import.meta.url);
const require = createRequire(new URL('package.json', mobile));
const ts = require('typescript');
function load(file, mocks = {}) {
  const source = fs.readFileSync(new URL(file, mobile), 'utf8');
  const module = { exports: {} };
  const code = ts.transpileModule(source, { compilerOptions: {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX,
  } }).outputText;
  vm.runInNewContext(code, { module, exports: module.exports, TypeError, Error,
    require(name) { if (Object.hasOwn(mocks, name)) return mocks[name]; throw Error(`Unmocked module: ${name}`); },
  }, { filename: file });
  return module.exports;
}
const { androidChatErrorMessage } = load('lib/androidChatError.ts');
const { messageError } = load('lib/messaging.ts');
const copy = 'Connection lost. Check this conversation before trying again.';

test('Android maps the observed wrapped network failure without claiming the message was not sent', () => {
  assert.equal(androidChatErrorMessage('TypeError: Network request failed'), copy);
  assert.equal(androidChatErrorMessage('TypeError: Failed to fetch'), copy);
  assert.equal(androidChatErrorMessage('  TypeError: Network request failed\n'), copy);
  assert.equal(/not sent|send again|resend/i.test(copy), false);
});

test('real shared formatter output from a PostgREST-shaped failed fetch is fixed only at Android presentation', () => {
  const wrapped = { message: 'TypeError: Network request failed', details: 'TypeError: Network request failed\n at privateTransport', hint: '', code: '' };
  const shared = messageError(wrapped);
  assert.equal(shared, 'TypeError: Network request failed');
  assert.equal(androidChatErrorMessage(shared), copy);
  assert.equal(wrapped.details, 'TypeError: Network request failed\n at privateTransport');
  assert.equal(messageError(new TypeError('network failure')), copy);
});

test('counterexamples, existing safe copy and other actionable errors are preserved', () => {
  for (const value of ['', copy, 'You appear to be offline. Check your connection and try again.',
    'The request timed out. Check your connection and refresh before trying again.',
    'Your session changed. Reopen this screen before continuing.',
    'TypeError: Cannot read property of undefined', 'RangeError: Failed to fetch',
    'Server: TypeError: Network request failed', 'TypeError: Network request failed: unauthorized',
    'TypeError: Failed to fetch user profile', 'Message contains TypeError: Network request failed',
    'Network request failed', 'Failed to fetch', '{"message":"TypeError: Network request failed"}']) {
    assert.equal(androidChatErrorMessage(value), value);
    assert.equal(androidChatErrorMessage(value, 'inbox'), value);
  }
});

test('inbox uses connection-specific copy while conversation and structured wrapper behavior stay unchanged', () => {
  for (const message of ['TypeError: Network request failed', 'TypeError: Failed to fetch']) {
    const shared = messageError({ message, details: 'private stack', hint: '', code: '' });
    assert.equal(androidChatErrorMessage(shared, 'inbox'), 'Connection lost. Check your connection and try again.');
    assert.equal(androidChatErrorMessage(shared), copy);
    assert.equal(androidChatErrorMessage(shared, 'conversation'), copy);
  }
});

test('settings maps only its observed bare fetch error and known wrappers without widening chat/inbox matching', () => {
  const generic = 'Connection lost. Check your connection and try again.';
  for (const value of ['Network request failed', 'TypeError: Network request failed', 'TypeError: Failed to fetch']) {
    assert.equal(androidChatErrorMessage(value, 'settings'), generic);
  }
  assert.equal(androidChatErrorMessage('Network request failed', 'inbox'), 'Network request failed');
  assert.equal(androidChatErrorMessage('Network request failed'), 'Network request failed');
  for (const value of ['Failed to fetch', 'Network request failed for another account', 'Network request failed: denied',
    'Your session changed. Reopen this screen before continuing.', 'Could not change password', 'Delete was not confirmed',
    'Subscription status is unavailable.', 'TypeError: Failed to fetch configuration', 'TypeError: Network request failed.']) {
    assert.equal(androidChatErrorMessage(value, 'settings'), value);
  }
});

const sharedRoute = fs.readFileSync(new URL('app/chat/[id].tsx', mobile), 'utf8');
const androidRoute = fs.readFileSync(new URL('app/chat/[id].android.tsx', mobile), 'utf8');
test('Android route differs only by the narrow display formatter import and error text', () => {
  const expected = sharedRoute
    .replace("import { useConversation } from '@/lib/useConversation';", "import { useConversation } from '@/lib/useConversation';\nimport { androidChatErrorMessage } from '@/lib/androidChatError';")
    .replace('style={s.errorText}>{error}</Text>', 'style={s.errorText}>{androidChatErrorMessage(error)}</Text>');
  assert.equal(androidRoute, expected);
});

test('Android inbox differs only by the display formatter import and contextual error label', () => {
  const source = fs.readFileSync(new URL('app/messages.tsx', mobile), 'utf8');
  const expected = source
    .replace("import { Conversation, LatestMessageRequest, loadConversations, messageError, withMessageDeadline } from '@/lib/messaging';", "import { Conversation, LatestMessageRequest, loadConversations, messageError, withMessageDeadline } from '@/lib/messaging';\nimport { androidChatErrorMessage } from '@/lib/androidChatError';")
    .replace('style={s.error}>{error}</Text>', "style={s.error}>{androidChatErrorMessage(error, 'inbox')}</Text>");
  assert.equal(fs.readFileSync(new URL('app/messages.android.tsx', mobile), 'utf8'), expected);
});

test('Android settings differs only by the formatter import and account load-error label; all actions remain identical', () => {
  const source = fs.readFileSync(new URL('app/settings.tsx', mobile), 'utf8');
  const expected = source
    .replace("import { useWebsiteCheckout } from '@/lib/useWebsiteCheckout';", "import { useWebsiteCheckout } from '@/lib/useWebsiteCheckout';\nimport { androidChatErrorMessage } from '@/lib/androidChatError';")
    .replace('title="Account unavailable" copy={loadError}', 'title="Account unavailable" copy={androidChatErrorMessage(loadError, \'settings\')}');
  assert.equal(fs.readFileSync(new URL('app/settings.android.tsx', mobile), 'utf8'), expected);
});

function render(file, error) {
  const calls = { send: 0, retry: 0, setBody: [] };
  const jsx = (type, props) => ({ type, props });
  const view = { loading: false, refreshing: false, ready: true, messages: [], body: 'Retained unsent draft',
    setBody: value => calls.setBody.push(value), me: 'test-barista', otherUserId: 'test-cafe', name: 'Synthetic café', sending: false,
    error, send: () => calls.send++, retry: () => calls.retry++ };
  const components = Object.fromEntries(['ActivityIndicator', 'Pressable', 'RefreshControl', 'SafeAreaView', 'ScrollView', 'Text', 'View'].map(name => [name, name]));
  const Chat = load(file, {
    react: { useState: value => [value, () => {}], useRef: value => ({ current: value }) },
    'react/jsx-runtime': { jsx, jsxs: jsx },
    'react-native': { ...components, Alert: { alert() { throw Error('Unexpected alert'); } }, StyleSheet: { create: value => value } },
    'expo-router': { router: {}, useLocalSearchParams: () => ({ id: 'test-application', kind: 'application' }) },
    '@/lib/safety': {}, '@/lib/useConversation': { useConversation: () => view },
    '@/lib/androidChatError': { androidChatErrorMessage },
    '@/components/ConversationKeyboardView': { ConversationKeyboardView: 'ConversationKeyboardView', ConversationTextInput: 'ConversationTextInput' },
  }).default;
  const tree = Chat();
  function collect(node, predicate, values = []) {
    if (!node || typeof node !== 'object') return values;
    if (Array.isArray(node)) { for (const item of node) collect(item, predicate, values); return values; }
    if (predicate(node)) values.push(node);
    collect(node.props?.children, predicate, values);
    return values;
  }
  return { calls, find: predicate => collect(tree, predicate) };
}

test('actual Android route shows friendly copy while retaining draft and explicit send/refresh actions', () => {
  const android = render('app/chat/[id].android.tsx', 'TypeError: Network request failed');
  assert.equal(android.find(node => node.props?.accessibilityRole === 'alert')[0].props.children, copy);
  assert.equal(android.find(node => node.props?.accessibilityLabel === 'Message')[0].props.value, 'Retained unsent draft');
  assert.equal(android.calls.send, 0);
  assert.equal(android.calls.retry, 0);
  android.find(node => node.props?.accessibilityLabel === 'Send message')[0].props.onPress();
  android.find(node => node.type === 'Pressable' && node.props?.children?.props?.children === 'Refresh conversation')[0].props.onPress();
  assert.equal(android.calls.send, 1);
  assert.equal(android.calls.retry, 1);
  const fallback = render('app/chat/[id].tsx', 'TypeError: Network request failed');
  assert.equal(fallback.find(node => node.props?.accessibilityRole === 'alert')[0].props.children, 'TypeError: Network request failed');
  assert.equal(fallback.calls.send, 0);
});

test('rendered Android inbox keeps its rows, manual retry and chat destination without triggering a send', () => {
  function inbox(file) {
    const states = [], routes = []; let slot = 0;
    const jsx = (type, props) => ({ type, props });
    const row = { id: 'test-application', kind: 'application', name: 'Synthetic café', preview: 'Existing QA preview', unread: 2 };
    const Messages = load(file, {
      react: { useState(initial) { const i = slot++; states[i] = i === 4 ? 'TypeError: Network request failed' : initial; return [states[i], value => { states[i] = typeof value === 'function' ? value(states[i]) : value; }]; }, useCallback: value => value },
      'react/jsx-runtime': { jsx, jsxs: jsx },
      'react-native': { ...Object.fromEntries(['ActivityIndicator', 'Pressable', 'RefreshControl', 'SafeAreaView', 'ScrollView', 'Text', 'View'].map(value => [value, value])), AppState: {}, StyleSheet: { create: value => value } },
      'expo-router': { router: { push: route => routes.push(route) }, useFocusEffect() {} },
      '@/features/section-memory/useSectionMemory': { useSectionMemory: () => ({ initial: { rows: [row], role: 'barista' } }), withSectionMemory: component => component },
      '@/lib/dashboardPrism': { dashboardPrism: {}, prismPanel: {} }, '@/lib/supabase': {}, '@/lib/session': {}, '@/components/AppBottomNav': { AppBottomNav: 'AppBottomNav' },
      '@/lib/messaging': {}, '@/lib/androidChatError': { androidChatErrorMessage },
    }).default;
    const tree = Messages();
    const nodes = [];
    function visit(node) { if (!node || typeof node !== 'object') return; if (Array.isArray(node)) { node.forEach(visit); return; } nodes.push(node); visit(node.props?.children); }
    visit(tree);
    return { states, routes, nodes };
  }
  const android = inbox('app/messages.android.tsx');
  assert.equal(android.nodes.find(node => node.props?.accessibilityRole === 'alert').props.children, 'Connection lost. Check your connection and try again.');
  assert.equal(android.states[1], false);
  assert.equal(android.states[5], 0);
  assert.equal(android.routes.length, 0);
  assert.ok(android.nodes.some(node => node.props?.children === 'Existing QA preview'));
  android.nodes.find(node => node.type === 'Pressable' && node.props?.children?.props?.children === 'Try again').props.onPress();
  assert.equal(android.states[1], true);
  assert.equal(android.states[5], 1);
  android.nodes.find(node => node.props?.accessibilityLabel === 'Synthetic café, 2 unread messages').props.onPress();
  assert.equal(android.routes[0].pathname, '/chat/[id]');
  assert.equal(android.routes[0].params.id, 'test-application');
  assert.equal(android.routes[0].params.kind, 'application');
  const fallback = inbox('app/messages.tsx');
  assert.equal(fallback.nodes.find(node => node.props?.accessibilityRole === 'alert').props.children, 'TypeError: Network request failed');
});

test('rendered Android settings formats account-load copy only and keeps billing error and retry callback intact', () => {
  function settings(file) {
    let state = 0;
    const jsx = (type, props) => ({ type, props });
    const Settings = load(file, {
      react: { useState(initial) { const i = state++; return [({ 0: 'cafe_owner_manager', 1: 'synthetic-cafe', 2: false,
        3: 'Network request failed', 15: 'TypeError: Network request failed' })[i] ?? initial, () => {}]; },
      useRef: value => ({ current: value }), useCallback: value => value, useEffect() {} },
      'react/jsx-runtime': { jsx, jsxs: jsx },
      'react-native': { ...Object.fromEntries(['Alert', 'Pressable', 'SafeAreaView', 'ScrollView', 'Text', 'TextInput', 'View'].map(value => [value, value])), AppState: {}, Linking: {}, Platform: { OS: 'android' }, StyleSheet: { create: value => value } },
      'expo-router': { router: {}, useFocusEffect() {}, useLocalSearchParams: () => ({}) },
      'expo-web-browser': {}, '@react-native-async-storage/async-storage': {},
      '../features/native-subscription/NativeSubscriptionSummary': { NativeSubscriptionSummary: 'NativeSubscriptionSummary' },
      '../features/native-subscription/ExpoSubscriptionEntry': { nativeSubscriptionScreenEnabled: true },
      '@/lib/dashboardPrism': { dashboardPrism: {}, prismPanel: {} }, '@/lib/supabase': {}, '@/lib/accountDeletion': {},
      '@/lib/session': {}, '@/lib/pushNotifications': {}, '@/lib/api': {}, '@/lib/legalLinks': {}, '@/lib/useWebsiteCheckout': {},
      '@/lib/androidChatError': { androidChatErrorMessage },
    }).default;
    const nodes = [];
    function visit(node) { if (!node || typeof node !== 'object') return; if (Array.isArray(node)) { node.forEach(visit); return; } nodes.push(node); visit(node.props?.children); }
    visit(Settings());
    return nodes;
  }
  const android = settings('app/settings.android.tsx');
  const account = android.find(node => node.props?.title === 'Account unavailable');
  assert.equal(account.props.copy, 'Connection lost. Check your connection and try again.');
  assert.equal(account.props.action, 'Try again');
  assert.equal(typeof account.props.onPress, 'function');
  const billing = android.find(node => node.type?.name === 'SubscriptionCard');
  assert.equal(billing.props.error, 'TypeError: Network request failed');
  assert.equal(android.some(node => node.props?.children === 'Change password'), true);
  assert.equal(android.some(node => node.props?.children === 'Log out'), true);
  const fallback = settings('app/settings.tsx');
  assert.equal(fallback.find(node => node.props?.title === 'Account unavailable').props.copy, 'Network request failed');
});

test('installed Expo Router selects the Android override and leaves iOS/web on the default route', () => {
  const { getRoutes } = require('expo-router/build/getRoutesCore');
  const keys = ['./_layout.tsx', './chat/[id].tsx', './chat/[id].android.tsx', './messages.tsx', './messages.android.tsx', './settings.tsx', './settings.android.tsx'];
  const context = Object.assign(() => ({ default() {} }), { keys: () => keys });
  for (const platform of ['android', 'ios', 'web']) {
    const tree = getRoutes(context, { platform, skipGenerated: true, ignoreEntryPoints: true,
      getSystemRoute() { throw Error('Unexpected system route'); } });
    const route = tree.children.find(node => node.route === 'chat/[id]');
    assert.ok(route);
    assert.equal(route.contextKey, platform === 'android' ? './chat/[id].android.tsx' : './chat/[id].tsx');
    const inbox = tree.children.find(node => node.route === 'messages');
    assert.ok(inbox);
    assert.equal(inbox.contextKey, platform === 'android' ? './messages.android.tsx' : './messages.tsx');
    const settings = tree.children.find(node => node.route === 'settings');
    assert.ok(settings);
    assert.equal(settings.contextKey, platform === 'android' ? './settings.android.tsx' : './settings.tsx');
  }
});
