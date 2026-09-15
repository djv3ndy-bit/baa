import test from 'node:test';
import assert from 'node:assert/strict';
import { loadTypescript } from './load-typescript.mjs';

function harness(platform, visible = false) {
  const listeners = new Map(), cleanups = [], hooks = [];
  let index = 0;
  const jsx = (type, props) => ({ type, props });
  const components = loadTypescript('mobile/components/ConversationKeyboardView.tsx', {
    react: {
      useState(initial) {
        const slot = index++;
        if (!(slot in hooks)) hooks[slot] = typeof initial === 'function' ? initial() : initial;
        return [hooks[slot], next => { hooks[slot] = next; }];
      },
      useRef(initial) { const slot = index++; return hooks[slot] ??= { current: initial }; },
      useEffect(effect) { const slot = index++; if (!(slot in hooks)) { hooks[slot] = true; const cleanup = effect(); if (cleanup) cleanups.push(cleanup); } },
    },
    'react/jsx-runtime': { jsx, jsxs: jsx },
    'react-native-safe-area-context': { useSafeAreaInsets: () => ({ top: 24, bottom: 48 }) },
    'react-native': {
      Platform: { OS: platform }, KeyboardAvoidingView: 'avoiding-view', TextInput: 'input',
      Keyboard: {
        isVisible: () => visible,
        addListener(event, listener) {
          if (!listeners.has(event)) listeners.set(event, new Set());
          listeners.get(event).add(listener);
          return { remove: () => listeners.get(event).delete(listener) };
        },
      },
    },
  });
  return {
    render(name, props = {}) { index = 0; return components[name](props); },
    event(name) { for (const callback of listeners.get(name) ?? []) callback(); },
    unmount() { for (const cleanup of cleanups) cleanup(); },
    listenerCount() { return [...listeners.values()].reduce((n, values) => n + values.size, 0); },
  };
}

test('Android opening, closing and reopening enables avoidance only while the keyboard is visible', () => {
  const h = harness('android');
  assert.equal(h.render('ConversationKeyboardView').props.enabled, false);
  for (let i = 0; i < 3; i++) {
    h.event('keyboardDidShow');
    const opened = h.render('ConversationKeyboardView');
    assert.equal(opened.props.enabled, true);
    assert.equal(opened.props.keyboardVerticalOffset, 24);
    h.event('keyboardDidHide');
    assert.equal(h.render('ConversationKeyboardView').props.enabled, false);
  }
  h.unmount();
  assert.equal(h.listenerCount(), 0);
});

test('a conversation mounted with an already-open keyboard avoids it immediately', () => {
  const h = harness('android', true);
  assert.equal(h.render('ConversationKeyboardView').props.enabled, true);
  h.unmount();
});

test('Android dismissal blurs only this composer, retains its props, and removes the listener on unmount', () => {
  const h = harness('android');
  let blurs = 0;
  const onChangeText = () => {};
  const node = h.render('ConversationTextInput', { value: 'Unsent draft', multiline: true, maxLength: 2000, onChangeText });
  node.props.ref.current = { blur: () => blurs++ };
  h.event('keyboardDidHide');
  assert.equal(blurs, 1);
  assert.equal(node.props.value, 'Unsent draft');
  assert.equal(node.props.maxLength, 2000);
  assert.equal(node.props.onChangeText, onChangeText);
  assert.equal(node.props.allowFontScaling, undefined);
  h.unmount(); h.event('keyboardDidHide');
  assert.equal(blurs, 1);
  assert.equal(h.listenerCount(), 0);
});

test('iOS keeps padding behavior and receives no Android dismissal listener', () => {
  const h = harness('ios');
  const node = h.render('ConversationKeyboardView', { children: 'conversation', style: { flex: 1 } });
  assert.equal(node.props.behavior, 'padding');
  assert.equal(node.props.enabled, true);
  assert.equal(node.props.keyboardVerticalOffset, 0);
  assert.equal(node.props.children, 'conversation');
  assert.equal(h.listenerCount(), 0);
  const input = harness('ios'); input.render('ConversationTextInput');
  assert.equal(input.listenerCount(), 0);
});
