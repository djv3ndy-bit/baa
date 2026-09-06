import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import ts from 'typescript';
import Yoga from 'yoga-layout';

// Render the actual TSX with inert hooks/native hosts. No account/network call is
// allowed. Yoga measures the real style tree; text uses deterministic synthetic
// metrics, NOT an iOS/Android font renderer or physical-device screenshot.
const ROOT = resolve(process.env.BJM_LAYOUT_SOURCE_ROOT || fileURLToPath(new URL('../../', import.meta.url)));
const flatten = value => Array.isArray(value) ? Object.assign({}, ...value.map(flatten)) : typeof value === 'function' ? flatten(value({ pressed: false })) : value || {};
const kids = value => [value].flat(Infinity).filter(x => x !== null && x !== undefined && x !== false && x !== true);
const textOf = element => typeof element === 'string' || typeof element === 'number' ? String(element) : kids(element?.props?.children).map(textOf).join('');
function render(file, { states = {}, props = {}, platform = 'ios', width = 393 } = {}) {
  const sheets = [], routes = [];
  let index = 0;
  const react = {
    useState(initial) { const n = index++; return [Object.hasOwn(states, n) ? states[n] : typeof initial === 'function' ? initial() : initial, () => {}]; },
    useEffect() {}, useCallback: fn => fn, useMemo: fn => fn(), useRef: initial => ({ current: initial }),
  };
  const element = (type, props) => ({ type, props: props || {} });
  const native = {
    StyleSheet: { create(value) { sheets.push(value); return value; }, flatten },
    Platform: { OS: platform, select: options => options[platform] ?? options.default },
    Dimensions: { get: () => ({ width, height: 844 }) },
    Animated: { event: () => () => {}, View: 'View', ValueXY: class { x = { interpolate: () => 0 }; getTranslateTransform() { return []; } } },
    PanResponder: { create: () => ({ panHandlers: {} }) },
    Alert: { alert() { throw new Error('Unexpected Alert during static layout rendering'); } },
  };
  for (const name of ['View', 'Text', 'Pressable', 'Image', 'ScrollView', 'SafeAreaView', 'TextInput', 'ActivityIndicator', 'KeyboardAvoidingView', 'RefreshControl']) native[name] = name;
  const module = { exports: {} };
  const require = name => {
    if (name === 'react') return react;
    if (name === 'react/jsx-runtime') return { jsx: element, jsxs: element, Fragment: 'Fragment' };
    if (name === 'react-native') return native;
    if (name === 'expo-router') return { router: { push: path => routes.push(path), replace: path => routes.push(path), back: () => routes.push('back') }, useLocalSearchParams: () => ({ id: 'test-match', kind: 'discovery' }) };
    if (/\.(png|jpg)$/.test(name)) return 1;
    if (name.endsWith('/timeGreeting')) return { getTimeGreeting: () => 'Good morning' };
    // Async effects are not run. Stubs must not be used as production services.
    return {};
  };
  const source = readFileSync(resolve(ROOT, file), 'utf8');
  const output = ts.transpileModule(source, { compilerOptions: { jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  vm.runInNewContext(output, { module, exports: module.exports, require, console, URL, process: { env: {} } }, { filename: file });
  const component = module.exports.default || module.exports.QuietFocusHome || module.exports.AppBottomNav;
  const tree = component({ ...props, onOpenSettings: () => routes.push('/settings') });
  function findStyle(key) {
    const style = sheets.map(s => s[key]).find(Boolean);
    assert.ok(style, `${file}: style ${key} exists`);
    function visit(node) {
      if (!node || typeof node !== 'object') return null;
      if (typeof node.type === 'function') return visit(node.type(node.props));
      const sourceStyle = typeof node.props?.style === 'function' ? node.props.style({ pressed: false }) : node.props?.style;
      if (kids(sourceStyle).includes(style)) return node;
      for (const child of kids(node.props?.children)) { const found = visit(child); if (found) return found; }
      return null;
    }
    const found = visit(tree); assert.ok(found, `${file}: rendered ${key} exists`); return found;
  }
  return { tree, findStyle, routes };
}

const edges = { '': Yoga.EDGE_ALL, Top: Yoga.EDGE_TOP, Right: Yoga.EDGE_RIGHT, Bottom: Yoga.EDGE_BOTTOM, Left: Yoga.EDGE_LEFT, Horizontal: Yoga.EDGE_HORIZONTAL, Vertical: Yoga.EDGE_VERTICAL };
function applyStyle(node, style) {
  for (const [key, value] of Object.entries(style)) {
    if (value === undefined || value === null) continue;
    const dimensions = { width: 'Width', height: 'Height', minWidth: 'MinWidth', maxWidth: 'MaxWidth', minHeight: 'MinHeight', maxHeight: 'MaxHeight', flexBasis: 'FlexBasis' };
    if (dimensions[key]) { node[`set${dimensions[key]}`](value); continue; }
    const scalar = { flexGrow: 'setFlexGrow', flexShrink: 'setFlexShrink', aspectRatio: 'setAspectRatio' };
    if (scalar[key]) { node[scalar[key]](value); continue; }
    // RN documents flex: 1 as grow:1/shrink:1/basis:0. Yoga's own shorthand
    // defaults differ; use RN's resolved values rather than browser CSS defaults.
    if (key === 'flex' && value > 0) { node.setFlexGrow(value); node.setFlexShrink(1); node.setFlexBasis(0); continue; }
    if (key === 'flexDirection') { node.setFlexDirection({ row: Yoga.FLEX_DIRECTION_ROW, column: Yoga.FLEX_DIRECTION_COLUMN }[value]); continue; }
    if (key === 'flexWrap') { node.setFlexWrap(value === 'wrap' ? Yoga.WRAP_WRAP : Yoga.WRAP_NO_WRAP); continue; }
    if (key === 'alignItems' || key === 'alignSelf') {
      const align = { center: Yoga.ALIGN_CENTER, 'flex-start': Yoga.ALIGN_FLEX_START, 'flex-end': Yoga.ALIGN_FLEX_END, stretch: Yoga.ALIGN_STRETCH, baseline: Yoga.ALIGN_BASELINE }[value];
      if (align !== undefined) node[key === 'alignItems' ? 'setAlignItems' : 'setAlignSelf'](align); continue;
    }
    if (key === 'justifyContent') { node.setJustifyContent({ center: Yoga.JUSTIFY_CENTER, 'flex-start': Yoga.JUSTIFY_FLEX_START, 'flex-end': Yoga.JUSTIFY_FLEX_END, 'space-between': Yoga.JUSTIFY_SPACE_BETWEEN, 'space-around': Yoga.JUSTIFY_SPACE_AROUND }[value]); continue; }
    if (key === 'gap') { node.setGap(Yoga.GUTTER_ALL, value); continue; }
    let match = /^(padding|margin)(Top|Right|Bottom|Left|Horizontal|Vertical)?$/.exec(key);
    if (match) { node[match[1] === 'padding' ? 'setPadding' : 'setMargin'](edges[match[2] || ''], value); continue; }
    match = /^border(Top|Right|Bottom|Left)?Width$/.exec(key);
    if (match) node.setBorder(edges[match[1] || ''], value);
  }
}
function layout(element, width, fontScale, direction = 'ltr') {
  const records = [];
  function build(element, parent = null) {
    if (typeof element.type === 'function') return build(element.type(element.props), parent);
    const node = Yoga.Node.create();
    const style = flatten(element.props?.style);
    applyStyle(node, style);
    const record = { node, element, parent, style }; records.push(record);
    if (element.type === 'Text' || element.type === 'TextInput') {
      const scale = element.props.allowFontScaling === false ? 1 : fontScale;
      const size = (style.fontSize || 14) * scale;
      const lineHeight = (style.lineHeight || (style.fontSize || 14) * 1.25) * scale;
      const text = element.type === 'TextInput' ? element.props.value || element.props.placeholder || '9–5' : textOf(element);
      node.setMeasureFunc((available, mode) => {
        const charWidth = size * 0.57 + (style.letterSpacing || 0);
        const natural = Math.max(...text.split('\n').map(line => line.length * charWidth), 1);
        const constrained = mode === Yoga.MEASURE_MODE_UNDEFINED ? natural : Math.min(natural, Math.max(available, 1));
        let lines = text.split('\n').reduce((sum, line) => sum + Math.max(1, Math.ceil(line.length * charWidth / Math.max(constrained, 1))), 0);
        if (element.props.numberOfLines) lines = Math.min(lines, element.props.numberOfLines);
        return { width: constrained, height: lines * lineHeight };
      });
    } else {
      for (const child of kids(element.props?.children)) {
        if (typeof child !== 'object') continue;
        const built = build(child, record); node.insertChild(built, node.getChildCount());
      }
    }
    return node;
  }
  const root = build(element); root.setWidth(width); root.calculateLayout(width, undefined, direction === 'rtl' ? Yoga.DIRECTION_RTL : Yoga.DIRECTION_LTR);
  return { root, records, free: () => root.freeRecursive() };
}
function assertContained(result, context, checkTargets = true) {
  const { root, records } = result;
  for (const record of records) {
    const box = record.node.getComputedLayout();
    if (record.parent) {
      const parentBox = record.parent.node.getComputedLayout();
      assert.ok(box.left >= -1 && box.left + box.width <= parentBox.width + 1, `${context}: ${record.element.type} ${textOf(record.element).slice(0, 45)} horizontal overflow (${box.left}+${box.width}>${parentBox.width})`);
      assert.ok(box.top >= -6 && box.top + box.height <= parentBox.height + 6, `${context}: vertical clipping (${box.top}+${box.height}>${parentBox.height})`);
    }
    if (checkTargets && record.element.type === 'Pressable') {
      assert.ok(box.width >= 44 && box.height >= 44, `${context}: header action remains at least 44×44`);
    }
  }
  assert.ok(root.getComputedHeight() > 0);
}
const homeProps = { role: 'cafe_owner_manager', firstName: 'A very long café name', location: 'Miami, Florida', profileProgress: 80, counts: { jobs: 3, matches: 5, alerts: 1, candidates: 999 }, refreshing: false, cafePlanCopy: 'First hire free', onRefresh() {} };
const cases = [
  { name: 'café profile', file: 'mobile/app/profile.tsx', states: { 0: false, 3: 'cafe_owner_manager' } },
  { name: 'barista profile', file: 'mobile/app/profile.tsx', states: { 0: false } },
  { name: 'discover settings', file: 'mobile/app/discover.tsx', states: { 0: false, 2: 'cafe_owner_manager' } },
  { name: 'home settings', file: 'mobile/components/QuietFocusHome.tsx', props: homeProps, key: 'brandRow' },
  { name: 'candidate review', file: 'mobile/app/candidates.tsx', states: { 0: false, 1: Array.from({length: 125}, () => ({ id: 'test', barista: {} })) } },
  { name: 'candidate empty', file: 'mobile/app/candidates.tsx', states: { 0: false } },
  { name: 'job posts', file: 'mobile/app/jobs.tsx', states: { 0: false } },
  { name: 'account settings', file: 'mobile/app/settings.tsx' },
  { name: 'post job', file: 'mobile/app/post-job.tsx', states: { 3: false } },
  { name: 'café plans', file: 'mobile/app/subscription.tsx', states: { 0: false } },
  { name: 'conversation', file: 'mobile/app/chat/[id].tsx', states: { 0: false, 5: 'A very long café and barista conversation display name for checking wrapping' } },
];
for (const spec of cases) for (const width of [320, 360, 375, 393, 430, 768]) for (const fontScale of [1, 1.3, 1.6, 2]) {
  test(`${spec.name}: ${width}px, font scale ${fontScale}`, () => {
    const rendered = render(spec.file, { ...spec, width });
    const result = layout(rendered.findStyle(spec.key || 'header'), width, fontScale);
    try { assertContained(result, spec.name); } finally { result.free(); }
  });
}
for (const spec of cases.slice(0, 4)) {
  test(`${spec.name}: settings tap is still wired to its existing route`, () => {
    const rendered = render(spec.file, spec);
    const result = layout(rendered.findStyle(spec.key || 'header'), 320, 2);
    try {
      const action = result.records.find(r => r.element.type === 'Pressable');
      assert.equal(action.element.props.accessibilityRole, 'button');
      assert.match(action.element.props.accessibilityLabel, /settings/i);
      action.element.props.onPress();
      assert.equal(rendered.routes.at(-1), '/settings');
    } finally { result.free(); }
  });
}
// Test the pre-existing bottom navigation, which already constrains its tab widths.
for (const role of ['barista', 'cafe_owner_manager']) test(`bottom navigation preserves ${role} tab targets at 320px`, () => {
  const rendered = render('mobile/components/AppBottomNav.tsx', { props: { role, active: 'profile' } });
  const result = layout(rendered.tree, 320, 2);
  try {
    const tabs = result.records.filter(r => r.element.type === 'Pressable');
    assert.equal(tabs.length, role === 'barista' ? 5 : 6);
    for (const tab of tabs) { const b = tab.node.getComputedLayout(); assert.ok(b.left >= 0 && b.left + b.width <= 321 && b.width >= 44); tab.element.props.onPress(); }
    assert.deepEqual(rendered.routes, role === 'barista' ? ['/home', '/discover', '/matches', '/messages', '/profile'] : ['/home', '/discover', '/candidates', '/matches', '/messages', '/profile']);
  } finally { result.free(); }
});

for (const platform of ['android', 'ios']) for (const direction of ['ltr', 'rtl']) for (const spec of cases.slice(0, 4)) {
  test(`${spec.name}: ${platform} ${direction} at narrow width and large text`, () => {
    const rendered = render(spec.file, { ...spec, platform, width: 320 });
    const result = layout(rendered.findStyle(spec.key || 'header'), 320, 2, direction);
    try { assertContained(result, spec.name); } finally { result.free(); }
  });
}
for (const key of ['mediaRow', 'hoursRow', 'choice']) for (const width of [320, 393]) for (const fontScale of [1, 2]) {
  test(`café profile editor ${key}: ${width}px, scale ${fontScale}`, () => {
    const rendered = render('mobile/app/profile.tsx', { states: { 0: false, 1: true, 3: 'cafe_owner_manager', 6: { Sunday: '7:00 AM–10:00 PM' } } });
    // Page/card horizontal padding = 18 + 18 on each side; card borders = 2.
    const result = layout(rendered.findStyle(key), width - 74, fontScale);
    try { assertContained(result, key, false); } finally { result.free(); }
  });
}
for (const width of [320, 393]) for (const fontScale of [1, 2]) {
  test(`café onboarding plan heading: ${width}px, scale ${fontScale}`, () => {
    const rendered = render('mobile/app/cafe-trial.tsx');
    const result = layout(rendered.findStyle('head'), width - 92, fontScale);
    try { assertContained(result, 'café onboarding', false); } finally { result.free(); }
  });
}
