import { listenMediaQuery } from './media-query.js';

/* Depth for the existing homepage. Content and native navigation stay in place. */
export function initSectionMotion({paused = false} = {}) {
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  const finePointer = matchMedia('(hover: hover) and (pointer: fine)');
  const changes = new Map();
  const removers = [];
  const states = [];
  const active = new Set();
  let userPaused = Boolean(paused);
  let disposed = false;
  let frame = 0;
  let previousTime = 0;
  let motionTime = 0;
  let layoutDirty = true;
  let viewportHeight = innerHeight;
  let compact = innerWidth <= 680;

  const clamp = (value, min = -1, max = 1) => Math.max(min, Math.min(max, value));
  const enabled = () => !disposed && !userPaused && !reduced.matches;
  const runnable = () => enabled() && !document.hidden;
  const ease = value => 1 - Math.pow(1 - value, 4);

  function remember(node) {
    if (!changes.has(node)) changes.set(node, {classes: new Set(), properties: new Map()});
    return changes.get(node);
  }
  function addClass(node, name) {
    if (!node.classList.contains(name)) {
      remember(node).classes.add(name);
      node.classList.add(name);
    }
  }
  function property(node, name, value) {
    const saved = remember(node).properties;
    if (!saved.has(name)) saved.set(name, [node.style.getPropertyValue(name), node.style.getPropertyPriority(name)]);
    if (node.style.getPropertyValue(name) !== value) node.style.setProperty(name, value);
  }
  function listen(node, event, handler, options) {
    node.addEventListener(event, handler, options);
    removers.push(() => node.removeEventListener(event, handler, options));
  }
  function pageTop(node) {
    let top = 0;
    for (let current = node; current; current = current.offsetParent) top += current.offsetTop || 0;
    return top;
  }
  function requestFrame() {
    if (!frame && runnable()) frame = requestAnimationFrame(paint);
  }
  function measure() {
    viewportHeight = innerHeight;
    compact = innerWidth <= 680;
    states.forEach(state => {
      state.top = pageTop(state.node);
      state.height = state.node.offsetHeight;
    });
    layoutDirty = false;
  }

  function register(selector, kind, stagger = 80) {
    document.querySelectorAll(selector).forEach((node, index) => {
      const state = {
        node, kind, index, direction: index % 2 ? -1 : 1,
        delay: (index % (kind === 'footer' ? 5 : 3)) * stagger,
        start: null, entered: false, p: 0, px: 0, py: 0, hover: 0,
        targetX: 0, targetY: 0, targetHover: 0, touchUntil: 0, top: 0, height: 0,
        ambient: ['panel', 'final', 'choice', 'step', 'benefit'].includes(kind),
        ambientTime: 0, phase: states.length * 1.37
      };
      states.push(state);
      // The signup choices already inherit their panel's entry opacity.
      if (kind !== 'choice') addClass(node, 'sm-item');
      addClass(node, 'sm-' + kind);
      if (kind === 'panel' || kind === 'final') {
        node.querySelectorAll(kind === 'panel' ? ':scope > img' : '.final-image img').forEach(image => addClass(image, 'sm-photo'));
        node.querySelectorAll('.community-copy,.audience-copy,.final-copy').forEach(copy => addClass(copy, 'sm-copy'));
        node.querySelectorAll('.choice').forEach(choice => addClass(choice, 'sm-choice'));
      }
      node.querySelectorAll('.step-icon,.benefit-icon').forEach(icon => addClass(icon, 'sm-icon'));
      if (kind === 'heading') return;

      const point = event => {
        if (!runnable() || event.pointerType === 'touch' || !finePointer.matches) return;
        const rect = node.getBoundingClientRect();
        state.targetX = clamp((event.clientX - rect.left) / Math.max(rect.width, 1) * 2 - 1);
        state.targetY = clamp((event.clientY - rect.top) / Math.max(rect.height, 1) * 2 - 1);
        state.targetHover = 1;
        requestFrame();
      };
      const reset = () => {
        state.targetX = 0;
        state.targetY = 0;
        state.targetHover = 0;
        state.touchUntil = 0;
        requestFrame();
      };
      listen(node, 'pointermove', point, {passive: true});
      listen(node, 'pointerleave', reset, {passive: true});
      listen(node, 'pointerdown', event => {
        if (!runnable() || event.pointerType !== 'touch') return;
        const rect = node.getBoundingClientRect();
        state.targetX = clamp((event.clientX - rect.left) / Math.max(rect.width, 1) * 2 - 1);
        state.targetY = -.65;
        state.targetHover = .55;
        state.touchUntil = performance.now() + 260;
        requestFrame();
      }, {passive: true});
      listen(node, 'pointercancel', reset, {passive: true});
      listen(node, 'focusin', () => {
        if (!runnable()) return;
        state.targetX = state.direction * .35;
        state.targetY = -.3;
        state.targetHover = .75;
        requestFrame();
      });
      listen(node, 'focusout', event => { if (!node.contains(event.relatedTarget)) reset(); });
    });
  }

  register('#how .kicker,#how .title,.benefits > h2', 'heading', 45);
  register('#how .step', 'step', 110);
  register('.community,.audience-card', 'panel', 70);
  register('.benefit', 'benefit', 80);
  register('.final-panel', 'final');
  register('.final-panel > .choice', 'choice', 100);
  register('.footer-grid > div', 'footer', 65);

  document.querySelectorAll('.nav-links > a,.resource-button,.resource-popover > a,.header-actions > .button,.footer-links > a,.choice > a').forEach(node => {
    addClass(node, 'sm-control');
    listen(node, 'pointermove', event => {
      if (!runnable() || event.pointerType === 'touch' || !finePointer.matches) return;
      const rect = node.getBoundingClientRect();
      property(node, '--sm-control-yaw', (clamp((event.clientX - rect.left) / Math.max(rect.width, 1) * 2 - 1) * 10).toFixed(2) + 'deg');
      property(node, '--sm-control-pitch', (-clamp((event.clientY - rect.top) / Math.max(rect.height, 1) * 2 - 1) * 8).toFixed(2) + 'deg');
    }, {passive: true});
    listen(node, 'pointerleave', () => {
      property(node, '--sm-control-yaw', '-7deg');
      property(node, '--sm-control-pitch', '6deg');
    }, {passive: true});
  });

  function paint(now) {
    frame = 0;
    if (!runnable()) return;
    if (layoutDirty) measure();
    const delta = previousTime ? clamp(now - previousTime, 8, 48) : 16;
    previousTime = now;
    motionTime += delta;
    const blend = 1 - Math.exp(-delta / 105);
    const scrollTop = window.scrollY || 0;
    let continueMotion = false;

    active.forEach(state => {
      const top = state.top - scrollTop;
      const bottom = top + state.height;
      if (bottom < -90 || top > viewportHeight + 90) return;
      if (!state.entered && top < viewportHeight * .94 && bottom > 0) {
        state.entered = true;
        state.start = motionTime + state.delay;
      }
      if (!state.entered) return;
      const elapsed = clamp((motionTime - state.start) / (state.kind === 'panel' ? 1120 : 940), 0, 1);
      const entry = 1 - ease(elapsed);
      const targetP = clamp((top + state.height * .5 - viewportHeight * .5) / (viewportHeight * .72));
      if (state.touchUntil && now >= state.touchUntil) {
        state.touchUntil = 0;
        state.targetX = 0;
        state.targetY = 0;
        state.targetHover = 0;
      }
      state.p += (targetP - state.p) * blend;
      state.px += (state.targetX - state.px) * blend;
      state.py += (state.targetY - state.py) * blend;
      state.hover += (state.targetHover - state.hover) * blend;
      const p = state.p, px = state.px, py = state.py, hover = state.hover;
      const direction = state.direction;
      // Only visible surfaces keep a clock running; photographs retain their approved framing.
      const drifting = state.ambient && bottom > 0 && top < viewportHeight;
      if (drifting) state.ambientTime += delta / 1000;
      const phase = state.ambientTime * .72 + state.phase;
      const amplitude = (1 - entry) * (compact ? .5 : 1);
      const float = Math.sin(phase) * amplitude;
      const sway = Math.cos(phase * .83) * amplitude;
      let pitch = 0, yaw = 0, lift = 0;

      if (state.kind === 'panel' || state.kind === 'final') {
        const strength = compact ? 4.2 : 5.7;
        const interaction = state.kind === 'final' ? .72 : 1;
        pitch = entry * (compact ? 10 : 13) - p * 3.4 - py * (compact ? 2.6 : 4.2) * interaction + float * .65;
        yaw = entry * direction * (compact ? 7 : 11) + p * direction * strength + px * (compact ? 3.3 : 5.5) * interaction + sway * .8;
        lift = entry * 38 - p * 9 + float * 2.5 - hover * (compact ? 2 : 4);
        property(state.node, '--sm-photo-transform', `perspective(1000px) translate3d(${(px * -2.5).toFixed(2)}%,${(-p * 4.6 - py * 1.6).toFixed(2)}%,0) scale(1.14)`);
        property(state.node, '--sm-copy-transform', `perspective(1000px) translate3d(${(px * 3.5).toFixed(2)}px,${(-p * 3).toFixed(2)}px,6px) rotateY(${(-px * 1.15).toFixed(2)}deg)`);
        property(state.node, '--sm-choice-transform', `perspective(700px) translateY(${(-p * 5 - px * 2).toFixed(2)}px) rotateX(${(entry * 9 - p * 3).toFixed(2)}deg)`);
      } else if (state.kind === 'step' || state.kind === 'benefit') {
        pitch = entry * 16 - p * 4.5 - py * 4.5 + float * .35;
        yaw = entry * direction * 10 + p * direction * 3.8 + px * 5.5 + sway * .5;
        lift = entry * 34 - p * 6 + float * 1.2 - hover * 3;
      } else if (state.kind === 'choice') {
        pitch = entry * 6 - p * 2 - py * 4 + float * .9;
        yaw = entry * direction * 4 + px * 5 + sway * direction * 1.15;
        lift = entry * 12 - p * 3 + float * 2.3 - hover * (compact ? 2 : 5);
      } else if (state.kind === 'footer') {
        pitch = entry * 14 - p * 3;
        yaw = entry * direction * 9 + px * 3;
        lift = entry * 30 - p * 4;
      } else {
        pitch = entry * 8;
        lift = entry * 21;
      }

      if (state.kind === 'choice') {
        property(state.node, '--sm-choice-local-transform', `perspective(1000px) translate3d(0,${lift.toFixed(2)}px,${(6 + hover * 8).toFixed(2)}px) rotateX(${pitch.toFixed(2)}deg) rotateY(${yaw.toFixed(2)}deg)`);
      } else {
        property(state.node, '--sm-transform', `perspective(${compact ? 1600 : 1900}px) translate3d(0,${lift.toFixed(2)}px,0) rotateX(${pitch.toFixed(2)}deg) rotateY(${yaw.toFixed(2)}deg)`);
        property(state.node, '--sm-opacity', (1 - entry * .26).toFixed(3));
      }
      if (state.kind === 'step' || state.kind === 'benefit') {
        property(state.node, '--sm-icon-transform', `perspective(480px) translate3d(${(px * 1.5).toFixed(2)}px,${(-5 - p * 4 - entry * 8 + float * 2.6 - hover * 2).toFixed(2)}px,${(18 + hover * 7).toFixed(2)}px) rotateX(${(-p * 13 - py * 10 + float * 3).toFixed(2)}deg) rotateY(${(entry * -32 + p * 19 + px * 22 + sway * 6).toFixed(2)}deg) rotateZ(${(p * direction * 5 + float * direction * 2).toFixed(2)}deg)`);
      }
      if (drifting || elapsed < 1 || state.touchUntil || Math.abs(targetP - p) > .002 || Math.abs(state.targetX - px) > .002 || Math.abs(state.targetY - py) > .002 || Math.abs(state.targetHover - hover) > .002) continueMotion = true;
    });
    if (continueMotion) requestFrame();
    else previousTime = 0;
  }

  let observer;
  if ('IntersectionObserver' in window) {
    const byNode = new Map(states.map(state => [state.node, state]));
    observer = new IntersectionObserver(entries => {
      entries.forEach(entry => {
        const state = byNode.get(entry.target);
        if (entry.isIntersecting) {
          active.add(state);
          addClass(state.node, 'sm-inview');
        } else {
          active.delete(state);
          state.node.classList.remove('sm-inview');
          state.targetX = 0;
          state.targetY = 0;
          state.targetHover = 0;
          state.touchUntil = 0;
        }
      });
      requestFrame();
    }, {rootMargin: '80px 0px 80px 0px', threshold: 0});
    states.forEach(state => observer.observe(state.node));
  } else states.forEach(state => active.add(state));

  let resizeObserver;
  if ('ResizeObserver' in window) {
    resizeObserver = new ResizeObserver(() => { layoutDirty = true; requestFrame(); });
    states.forEach(state => resizeObserver.observe(state.node));
  }
  listen(window, 'scroll', requestFrame, {passive: true});
  listen(window, 'resize', () => { layoutDirty = true; requestFrame(); }, {passive: true});
  listen(window, 'load', () => { layoutDirty = true; requestFrame(); }, {once: true});
  listen(document, 'visibilitychange', () => {
    if (document.hidden) {
      cancelAnimationFrame(frame);
      frame = 0;
    } else {
      previousTime = 0;
      layoutDirty = true;
      requestFrame();
    }
  });
  function sync() {
    if (disposed) return;
    document.body.classList.toggle('section-motion-active', enabled());
    if (!enabled()) {
      cancelAnimationFrame(frame);
      frame = 0;
    } else {
      previousTime = 0;
      layoutDirty = true;
      requestFrame();
    }
  }
  removers.push(listenMediaQuery(reduced, sync));
  removers.push(listenMediaQuery(finePointer, () => {
    states.forEach(state => {
      state.targetX = 0;
      state.targetY = 0;
      state.targetHover = 0;
      state.touchUntil = 0;
    });
    requestFrame();
  }));
  addClass(document.body, 'section-motion-ready');
  remember(document.body).classes.add('section-motion-active');
  sync();

  return {
    setPaused(value) { userPaused = Boolean(value); sync(); },
    replay() {
      if (!enabled()) return;
      states.forEach(state => { state.entered = false; state.start = null; state.ambientTime = 0; });
      previousTime = 0;
      requestFrame();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      cancelAnimationFrame(frame);
      observer?.disconnect();
      resizeObserver?.disconnect();
      removers.forEach(remove => remove());
      changes.forEach((saved, node) => {
        saved.classes.forEach(name => node.classList.remove(name));
        saved.properties.forEach(([value, priority], name) => {
          if (value) node.style.setProperty(name, value, priority);
          else node.style.removeProperty(name);
        });
      });
      active.clear();
    }
  };
}
