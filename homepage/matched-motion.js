/** Motion confined to the existing homepage media; no layout or scroll ownership. */
export async function createHomepageMotion({ media, photo, card, latteContainer, photoLayers = [] }) {
  if (!media?.style || !photo?.style) {
    throw new TypeError('createHomepageMotion requires media and photo elements.');
  }

  const variants = new Set(['depth', 'latte', 'cinema']);
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)');
  const fine = window.matchMedia('(hover: hover) and (pointer: fine)');
  const hero = media.closest('.hero') || media;
  const properties = ['transform', 'transform-origin', 'transition', 'animation',
    'opacity', 'filter', 'clip-path', 'will-change', 'perspective', 'transform-style'];
  const snapshots = [media, photo, card, latteContainer, ...photoLayers].filter(Boolean).map(element => ({
    element,
    styles: properties.map(property => [property, element.style.getPropertyValue(property), element.style.getPropertyPriority(property)]),
  }));
  const originalVariant = media.getAttribute('data-motion-variant');
  const originalHidden = latteContainer?.hidden;
  const originalAria = latteContainer?.getAttribute('aria-hidden');

  // Keep the website's intentional photo/card rotation beneath our small motion.
  for (const element of [photo, card].filter(Boolean)) {
    element.style.animation = 'none';
    element.style.transition = 'none';
  }
  const photoStyle = getComputedStyle(photo);
  const cardStyle = card ? getComputedStyle(card) : null;
  let basePhoto = photoStyle.transform === 'none' ? '' : photoStyle.transform;
  let baseCard = !cardStyle || cardStyle.transform === 'none' ? '' : cardStyle.transform;
  const baseFilter = photoStyle.filter === 'none' ? '' : photoStyle.filter;
  const baseClip = photoStyle.clipPath || 'none';
  const borderRadius = photoStyle.borderRadius || '14px';
  const layerBases = photoLayers.map(element => {
    const transform = getComputedStyle(element).transform;
    return transform === 'none' ? '' : transform;
  });
  media.style.perspective = '1400px';
  media.style.transformStyle = 'preserve-3d';
  photo.style.transformOrigin = '50% 50%';
  photo.style.willChange = 'transform, opacity, clip-path';
  if (card) card.style.willChange = 'transform';

  let variant = 'depth';
  let userPaused = false;
  let disposed = false;
  let inView = true;
  let raf = 0;
  let previousTime = 0;
  let time = 0;
  let entryAge = 0;
  let progress = 0;
  let targetProgress = 0;
  let cup = null;
  let cupPromise = null;
  let cupUnavailable = false;
  let foregroundStrength = innerWidth <= 680 ? 0.62 : innerWidth <= 1050 ? 0.84 : 1;
  const pointer = { x: 0, y: 0, targetX: 0, targetY: 0 };
  const drag = { active: false, horizontal: false, id: null, startX: 0, startY: 0 };
  const interaction = element => ({ element, x: 0, y: 0, targetX: 0, targetY: 0, lift: 0, targetLift: 0, focused: false });
  const layerInteractions = photoLayers.map(interaction);
  const cardInteraction = card ? interaction(card) : null;
  const interactions = [...layerInteractions, cardInteraction].filter(Boolean);
  const layerTravel = photoLayers.map(() => ({ minY: -4, maxY: 120 }));
  const clamp = (value, min = 0, max = 1) => Math.min(max, Math.max(min, value));
  const paused = () => userPaused || reduce.matches;
  const canRun = () => !disposed && inView && !document.hidden;
  const duration = () => variant === 'cinema' ? 1.6 : 1.35;
  const damp = (from, to, dt) => from + (to - from) * (1 - Math.exp(-6 * dt));
  const fmt = value => Number(value.toFixed(4));

  function measureForeground() {
    // Reserve room for rotated borders on phones; no layout reads in the frame loop.
    const height = media.offsetHeight || 305;
    photoLayers.forEach((layer, index) => {
      const top = layer.offsetTop || 0;
      const width = layer.offsetWidth || 128;
      const layerHeight = layer.offsetHeight || 104;
      const borderRoom = width * .11 + layerHeight * .02;
      const projectedRoom = Math.max(0, height * .5 - top) * (51 + index * 10) / (1049 - index * 10);
      const minY = Math.max(-4, 6 - top + borderRoom + projectedRoom);
      layerTravel[index] = { minY, maxY: Math.max(minY, height - 6 - top - layerHeight - borderRoom) };
    });
  }
  measureForeground();

  function syncCup() {
    if (latteContainer) {
      const show = !cupUnavailable;
      latteContainer.hidden = !show;
      latteContainer.setAttribute('aria-hidden', String(!show));
    }
    cup?.setPaused(paused() || !canRun());
  }

  function staticComposition() {
    photo.style.transform = basePhoto || 'none';
    photo.style.opacity = '1';
    photo.style.clipPath = baseClip;
    photo.style.filter = baseFilter || 'none';
    if (card) {
      card.style.transform = baseCard || 'none';
      card.style.opacity = '1';
    }
    if (latteContainer) {latteContainer.style.opacity = '1';latteContainer.style.transform = 'none';}
    photoLayers.forEach((layer,index) => {layer.style.opacity='1';layer.style.transform=layerBases[index]||'none';});
  }

  function paint() {
    if (paused()) { staticComposition(); return; }
    const entry = 1 - Math.pow(1 - clamp(entryAge / duration()), 3);
    const incoming = 1 - entry;
    const orbit = Math.sin(time * Math.PI * 2 / 7.8);
    const breath = Math.cos(time * Math.PI * 2 / 9.6);
    const px = pointer.x;
    const py = pointer.y;
    let x = 0, y = 0, rx = 0, ry = 0, z = 0, scale = 1;
    let cardX = 0, cardY = 0, cardRY = 0;

    if (variant === 'depth') {
      x = px * 11 + orbit * 6;
      y = py * 7 + breath * 3 + incoming * 28 - progress * 18;
      rx = -py * 1.4 + incoming * 4;
      ry = px * 3.6 + orbit * 1.4 - incoming * 8;
      z = -55 + progress * 35;
      scale = 1.16 - progress * 0.05 + incoming * 0.025;
      cardX = px * -12 - orbit * 5;
      cardY = py * -7 - breath * 5 + incoming * 48 - progress * 12;
      cardRY = px * -4.5 + orbit * 1.7 - incoming * 12;
      photo.style.clipPath = baseClip;
      photo.style.filter = baseFilter || 'none';
      photo.style.opacity = String(fmt(0.88 + entry * 0.12));
    } else if (variant === 'latte') {
      x = px * 8 + orbit * 3;
      y = breath * 2 + incoming * 24 - progress * 12;
      ry = px * 2.7 - incoming * 6;
      scale = 1.12 - progress * 0.025 + incoming * 0.03;
      cardX = px * -9 + orbit * 3;
      cardY = incoming * 40 + breath * 4;
      cardRY = px * -3.5 - incoming * 8;
      photo.style.clipPath = baseClip;
      photo.style.filter = baseFilter || 'none';
      photo.style.opacity = String(fmt(0.94 + entry * 0.06));
      if (latteContainer) latteContainer.style.opacity = String(fmt(0.9 + entry * 0.1));
    } else {
      // Uniform camera movement preserves faces; the single opening has no flash.
      const cameraDrift = (1 - breath) * 0.5;
      x = px * 9 + orbit * 5;
      y = py * 5 + incoming * 28 - progress * 20;
      rx = -py * 1.4 + incoming * 4;
      ry = px * 3 + orbit * 1.8 - incoming * 7;
      scale = 1.12 + cameraDrift * 0.025 + incoming * 0.13 - progress * 0.035;
      cardX = px * -10;
      cardY = incoming * 44 + breath * 4;
      cardRY = px * -4 - incoming * 9;
      photo.style.opacity = '1';
      photo.style.filter = `${baseFilter} brightness(${fmt(0.95 + entry * 0.05)})`.trim();
      photo.style.clipPath = baseClip === 'none' && incoming > 0.0001
        ? `inset(${fmt(incoming * 16)}% ${fmt(incoming * 10)}% round ${borderRadius})`
        : baseClip;
    }

    photo.style.transform = `${basePhoto} translate3d(${fmt(x)}px,${fmt(y)}px,${fmt(z)}px) rotateX(${fmt(rx)}deg) rotateY(${fmt(ry)}deg) scale(${fmt(scale)})`.trim();
    if (card) {
      // A small independent lift gives the existing job card a tangible front plane.
      const hover = cardInteraction.lift;
      const lift = (Math.sin(time * .78 + .65) * 2 - hover * 6) * foregroundStrength;
      const depth = 75 + (Math.sin(time * .58) * 4 + hover * 12) * foregroundStrength;
      const pitch = clamp(-py * 2 - cardInteraction.y * hover * 2 * foregroundStrength, -3, 3);
      const yaw = clamp(cardRY + cardInteraction.x * hover * 4 * foregroundStrength, -5 - incoming * 12, 5 + incoming * 12);
      card.style.transform = `${baseCard} translate3d(${fmt(cardX)}px,${fmt(cardY + lift)}px,${fmt(depth)}px) rotateY(${fmt(yaw)}deg) rotateX(${fmt(pitch)}deg)`.trim();
      card.style.opacity = '1';
    }
    photoLayers.forEach((layer,index) => {
      const direction=index ? -1 : 1;
      const local = layerInteractions[index];
      const compact = foregroundStrength === .62;
      const phase = time * Math.PI * 2 / (10 + index * 3) + index * 1.4;
      const sway = Math.sin(phase);
      const float = Math.cos(phase * .85);
      const delayed=1-Math.pow(1-clamp((entryAge-index*.12)/1.5),3);
      const arrival=1-delayed;
      let lx=(px*-17*direction+sway*9*direction)*foregroundStrength;
      let ly=(py*-10+float*10*direction-local.lift*7)*foregroundStrength+arrival*(70+index*25)-progress*22*direction;
      let depth=65+index*20+(sway*(14+index*4)+local.lift*22)*foregroundStrength;
      const yaw=clamp((px*-8+sway*6+local.x*local.lift*9)*foregroundStrength, compact ? -6 : -12, compact ? 6 : 12)+arrival*25*direction;
      const pitch=clamp((-py*5-local.y*local.lift*7)*foregroundStrength, compact ? -4 : -6, compact ? 4 : 6)+arrival*12;
      const roll=sway*(compact ? .8 : 1.5)*direction;
      if (compact) {
        lx=clamp(lx,-4,4);
        ly=clamp(py*-3+float*3*direction-local.lift*3+arrival*(70+index*25)-progress*4*direction,layerTravel[index].minY,layerTravel[index].maxY);
        depth=18+index*10+clamp(sway*4+local.lift*6,-8,8);
      }
      layer.style.transform=`${layerBases[index]} translate3d(${fmt(lx)}px,${fmt(ly)}px,${fmt(depth)}px) rotateY(${fmt(yaw)}deg) rotateX(${fmt(pitch)}deg) rotateZ(${fmt(roll)}deg) scale(${fmt(.87+delayed*.13)})`;
      layer.style.opacity=String(fmt(.8+delayed*.2));
    });
    if(latteContainer){
      latteContainer.style.opacity='1';
      latteContainer.style.transform=`translate3d(${fmt((px*-7+orbit*7)*foregroundStrength)}px,${fmt(breath*8*foregroundStrength+incoming*45-progress*16)}px,0) rotateZ(${fmt(orbit*2.2*foregroundStrength)}deg)`;
    }
    cup?.setProgress(clamp(progress*.77+.1+px*.32));
  }

  function tick(now) {
    raf = 0;
    if (!canRun()) return;
    const dt = previousTime ? Math.min((now - previousTime) / 1000, 0.04) : 1 / 60;
    previousTime = now;
    if (!paused()) {
      time += dt;
      entryAge += dt;
      progress = damp(progress, targetProgress, dt);
      pointer.x = damp(pointer.x, pointer.targetX, dt);
      pointer.y = damp(pointer.y, pointer.targetY, dt);
      interactions.forEach(local => {
        local.x = damp(local.x, local.targetX, dt);
        local.y = damp(local.y, local.targetY, dt);
        local.lift = damp(local.lift, local.targetLift, dt);
      });
    }
    paint();
    if (!paused()) raf = requestAnimationFrame(tick);
  }

  function start() {
    if (!raf && canRun()) raf = requestAnimationFrame(tick);
  }

  function stop() {
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
    previousTime = 0;
  }

  function readScroll() {
    const rect = hero.getBoundingClientRect();
    targetProgress = clamp(-rect.top / Math.max(hero.offsetHeight * 0.9, 1));
    if (!paused()) start();
  }

  function onPointer(event) {
    if(paused())return;
    const rect = media.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    if(event.pointerType==='touch' && drag.active){
      const dx=event.clientX-drag.startX,dy=event.clientY-drag.startY;
      if(!drag.horizontal && Math.abs(dx)>9 && Math.abs(dx)>Math.abs(dy)*1.3)drag.horizontal=true;
      if(!drag.horizontal)return;
      pointer.targetX=clamp(dx/(rect.width*.34),-1,1);
      pointer.targetY=clamp(dy/(rect.height*.6),-.5,.5);
      start();return;
    }
    if (event.pointerType !== 'mouse' || !fine.matches) return;
    pointer.targetX = clamp(((event.clientX - rect.left) / rect.width - 0.5) * 2, -1, 1);
    pointer.targetY = clamp(((event.clientY - rect.top) / rect.height - 0.5) * 2, -1, 1);
    interactions.forEach(local => {
      const hovered = local.element.contains(event.target);
      local.targetLift = hovered || local.focused ? 1 : 0;
      if (hovered) {
        const bounds = local.element.getBoundingClientRect();
        local.targetX = clamp((event.clientX - bounds.left) / Math.max(bounds.width, 1) * 2 - 1, -1, 1);
        local.targetY = clamp((event.clientY - bounds.top) / Math.max(bounds.height, 1) * 2 - 1, -1, 1);
      } else local.targetX = local.targetY = 0;
    });
    start();
  }

  function resetPointer() {
    pointer.targetX = 0; pointer.targetY = 0;
    interactions.forEach(local => {
      local.targetX = local.targetY = 0;
      local.targetLift = local.focused ? 1 : 0;
    });
  }
  function cardFocus() {
    if (paused() || !cardInteraction) return;
    cardInteraction.focused = true;
    cardInteraction.targetLift = 1;
    start();
  }
  function cardBlur(event) {
    if (!cardInteraction || card.contains(event.relatedTarget)) return;
    cardInteraction.focused = false;
    cardInteraction.targetLift = 0;
    cardInteraction.targetX = cardInteraction.targetY = 0;
    start();
  }
  function pointerDown(event){
    if(paused()||drag.active||event.pointerType!=='touch'||event.target.closest('a,button'))return;
    resetPointer();
    drag.active=true;drag.horizontal=false;drag.id=event.pointerId;drag.startX=event.clientX;drag.startY=event.clientY;
    try{media.setPointerCapture(event.pointerId);}catch{}
  }
  function pointerEnd(event){
    if(drag.id!==event.pointerId)return;
    releaseDrag();
    resetPointer();start();
  }
  function pointerCancel(event) { pointerEnd(event); resetPointer(); }

  function releaseDrag() {
    const id = drag.id;
    drag.active = false; drag.horizontal = false; drag.id = null;
    if (id !== null) {
      try { media.releasePointerCapture(id); } catch {}
    }
  }

  function clearInteractions() {
    interactions.forEach(local => {
      local.focused = false;
      local.x = local.y = local.lift = local.targetX = local.targetY = local.targetLift = 0;
    });
  }

  function replay() {
    if (disposed) return;
    releaseDrag();
    entryAge = paused() ? duration() : 0;
    time = 0;
    resetPointer();
    paint(); // Content is always visible, even before the first animation frame.
    start();
  }

  function reportCupError(error) {
    cupUnavailable = true;
    cup?.dispose();
    cup = null;
    syncCup();
    media.dispatchEvent(new CustomEvent('homepage-motion-error', {
      detail: { variant: 'latte', message: error?.message || 'The 3D latte is unavailable.' },
    }));
  }

  async function ensureCup() {
    if (cup || cupPromise || !latteContainer || disposed) return cupPromise;
    cupUnavailable = false;
    syncCup();
    cupPromise = (async () => {
      try {
        const module = await import('./coffee-scene.js');
        if (disposed) return;
        cup = module.initCoffeeScene(latteContainer);
        cup.setProgress(targetProgress);
        syncCup();
        cup.resize();
      } catch (error) {
        if (!disposed) reportCupError(error);
      } finally { cupPromise = null; }
    })();
    return cupPromise;
  }

  function setVariant(id) {
    if (disposed || !variants.has(id)) return;
    variant = id;
    media.setAttribute('data-motion-variant', id);
    measureForeground();
    cupUnavailable = false;
    syncCup();
    if (cup) cup.resize(); else ensureCup();
    readScroll();
    replay();
  }

  function setPaused(value) {
    if (disposed) return;
    const unchanged = userPaused === Boolean(value);
    userPaused = Boolean(value);
    if (unchanged && !paused()) { syncCup(); start(); return; }
    stop();
    releaseDrag();
    resetPointer();
    pointer.x = pointer.y = 0;
    clearInteractions();
    entryAge = duration();
    if (paused()) staticComposition();
    syncCup();
    start();
  }

  function visibilityChange() {
    if (!canRun()) { stop(); releaseDrag(); resetPointer(); clearInteractions(); } else start();
    syncCup();
  }

  function resize() {
    foregroundStrength = innerWidth <= 680 ? 0.62 : innerWidth <= 1050 ? 0.84 : 1;
    measureForeground();
    // Responsive CSS may deliberately give the original job card a new angle.
    for (const element of [photo, card].filter(Boolean)) {
      const current = element.style.transform;
      const original = snapshots.find(item => item.element === element).styles.find(item => item[0] === 'transform');
      if (original[1]) element.style.setProperty('transform', original[1], original[2]);
      else element.style.removeProperty('transform');
      const cssTransform = getComputedStyle(element).transform;
      if (element === photo) basePhoto = cssTransform === 'none' ? '' : cssTransform;
      else baseCard = cssTransform === 'none' ? '' : cssTransform;
      element.style.transform = current;
    }
    readScroll();
    cup?.resize();
    if (paused()) staticComposition();
  }

  const onReduce = () => setPaused(userPaused);
  const onCupLost = event => reportCupError(new Error(event.detail?.message || 'The 3D graphics context is unavailable.'));
  media.addEventListener('pointermove', onPointer, { passive: true });
  media.addEventListener('pointerdown', pointerDown, { passive: true });
  media.addEventListener('pointerup', pointerEnd, { passive: true });
  media.addEventListener('pointercancel', pointerCancel, { passive: true });
  media.addEventListener('pointerleave', resetPointer, { passive: true });
  card?.addEventListener('focusin', cardFocus);
  card?.addEventListener('focusout', cardBlur);
  window.addEventListener('scroll', readScroll, { passive: true });
  window.addEventListener('resize', resize, { passive: true });
  document.addEventListener('visibilitychange', visibilityChange);
  reduce.addEventListener('change', onReduce);
  photo.addEventListener('load', replay);
  latteContainer?.addEventListener('coffee-scene-error', onCupLost);
  const intersection = typeof IntersectionObserver === 'undefined' ? null : new IntersectionObserver(([entry]) => {
    inView = entry.isIntersecting;
    visibilityChange();
  }, { rootMargin: '80px', threshold: 0 });
  intersection?.observe(media);
  const sizeObserver = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(resize);
  sizeObserver?.observe(media);
  setVariant('depth');

  return {
    setVariant, setPaused, replay,
    dispose() {
      if (disposed) return;
      disposed = true;
      stop();
      releaseDrag();
      cup?.dispose();
      cup = null;
      intersection?.disconnect();
      sizeObserver?.disconnect();
      media.removeEventListener('pointermove', onPointer);
      media.removeEventListener('pointerdown', pointerDown);
      media.removeEventListener('pointerup', pointerEnd);
      media.removeEventListener('pointercancel', pointerCancel);
      media.removeEventListener('pointerleave', resetPointer);
      card?.removeEventListener('focusin', cardFocus);
      card?.removeEventListener('focusout', cardBlur);
      window.removeEventListener('scroll', readScroll);
      window.removeEventListener('resize', resize);
      document.removeEventListener('visibilitychange', visibilityChange);
      reduce.removeEventListener('change', onReduce);
      photo.removeEventListener('load', replay);
      latteContainer?.removeEventListener('coffee-scene-error', onCupLost);
      snapshots.forEach(({ element, styles }) => styles.forEach(([property, value, priority]) => {
        if (value) element.style.setProperty(property, value, priority);
        else element.style.removeProperty(property);
      }));
      if (originalVariant === null) media.removeAttribute('data-motion-variant');
      else media.setAttribute('data-motion-variant', originalVariant);
      if (latteContainer) {
        latteContainer.hidden = originalHidden;
        if (originalAria === null) latteContainer.removeAttribute('aria-hidden');
        else latteContainer.setAttribute('aria-hidden', originalAria);
      }
    },
  };
}
