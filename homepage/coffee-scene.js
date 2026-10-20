import * as THREE from './vendor/three.module.js';
import { listenMediaQuery } from './media-query.js';

/**
 * A self-contained, transparent product-photography scene.
 * The host owns layout and scroll; this module never intercepts scrolling.
 * const cup = initCoffeeScene(element);
 * cup.setProgress(normalizedScrollProgress); // 0…1
 * cup.setPaused(true);                      // freezes the current composition
 */
export function initCoffeeScene(container) {
  if (!container || typeof container.appendChild !== 'function') {
    throw new TypeError('initCoffeeScene requires a DOM container.');
  }

  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({
      antialias: true,
      alpha: true,
      powerPreference: 'high-performance',
      premultipliedAlpha: true,
    });
  } catch (error) {
    throw new Error('The 3D coffee scene requires WebGL2.', { cause: error });
  }

  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.7));
  renderer.setClearColor(0x000000, 0);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 0.95;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  const canvas = renderer.domElement;
  canvas.setAttribute('aria-hidden', 'true');
  canvas.className = 'coffee-scene-canvas';
  Object.assign(canvas.style, {
    display: 'block', width: '100%', height: '100%', pointerEvents: 'none',
  });
  container.appendChild(canvas);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(31, 1, 0.1, 40);
  const sculpture = new THREE.Group();
  scene.add(sculpture);
  const resources = new Set();
  const own = (resource) => { resources.add(resource); return resource; };
  const addMesh = (geometry, material, parent = sculpture) => {
    own(geometry);
    const mesh = new THREE.Mesh(geometry, material);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    parent.add(mesh);
    return mesh;
  };

  // Large luminous panels create broad, photographic ceramic reflections.
  // The room is captured once and never appears in the transparent background.
  try {
    const studio = new THREE.Scene();
    studio.background = new THREE.Color(0xb7afa4);
    const studioObjects = [];
    const panel = (width, height, position, color, intensity) => {
      const geometry = new THREE.PlaneGeometry(width, height);
      const material = new THREE.MeshBasicMaterial({
        color: new THREE.Color(color).multiplyScalar(intensity),
        side: THREE.DoubleSide,
      });
      const mesh = new THREE.Mesh(geometry, material);
      mesh.position.set(...position);
      mesh.lookAt(0, 0.5, 0);
      studio.add(mesh);
      studioObjects.push(geometry, material);
    };
    panel(5, 6, [-4, 3.5, 3.5], 0xfff4df, 3.3);
    panel(2, 5, [4, 2.2, 1], 0xe9f0ff, 2.0);
    panel(5, 4, [0, 6, -1], 0xffffff, 2.8);
    panel(6, 5, [0, 1, -5], 0x796c5e, 0.36);
    panel(12, 12, [0, -3, 0], 0x7d7061, 0.45);
    const pmrem = new THREE.PMREMGenerator(renderer);
    const environment = own(pmrem.fromScene(studio, 0.04, 0.1, 30));
    scene.environment = environment.texture;
    pmrem.dispose();
    studioObjects.forEach((resource) => resource.dispose());
  } catch (error) {
    renderer.dispose();
    canvas.remove();
    resources.forEach((resource) => resource.dispose());
    throw new Error('The 3D coffee scene could not initialize its lighting.', { cause: error });
  }

  const ceramicTooth = own(makeCeramicTexture());
  const ceramic = own(new THREE.MeshPhysicalMaterial({
    color: 0xeee4d3,
    metalness: 0,
    roughness: 0.28,
    clearcoat: 0.48,
    clearcoatRoughness: 0.19,
    ior: 1.46,
    envMapIntensity: 0.45,
    bumpMap: ceramicTooth,
    bumpScale: 0.0012,
  }));
  const accent = own(new THREE.MeshPhysicalMaterial({
    color: 0xc75b2b,
    roughness: 0.29,
    clearcoat: 0.55,
    clearcoatRoughness: 0.22,
    envMapIntensity: 0.65,
  }));

  // A closed, double-walled profile: the inner rim and cavity are actual geometry.
  const bowl = new THREE.Path();
  bowl.moveTo(0, 0.18);
  bowl.lineTo(0.29, 0.18);
  bowl.quadraticCurveTo(0.39, 0.177, 0.444, 0.238);
  bowl.bezierCurveTo(0.626, 0.302, 0.797, 0.652, 0.878, 0.982);
  bowl.quadraticCurveTo(0.897, 1.058, 0.890, 1.108);
  bowl.quadraticCurveTo(0.886, 1.134, 0.868, 1.135);
  bowl.quadraticCurveTo(0.850, 1.135, 0.844, 1.113);
  bowl.bezierCurveTo(0.837, 0.966, 0.733, 0.606, 0.585, 0.423);
  bowl.quadraticCurveTo(0.48, 0.294, 0.30, 0.294);
  bowl.lineTo(0, 0.294);
  bowl.lineTo(0, 0.18);
  addMesh(new THREE.LatheGeometry(bowl.getSpacedPoints(100), 144), ceramic);

  const foot = addMesh(new THREE.TorusGeometry(0.345, 0.013, 12, 96), ceramic);
  foot.rotation.x = Math.PI / 2;
  foot.position.y = 0.177;

  // A slim oval handle balances the fuller bowl without overshadowing the latte.
  const handleCurve = new THREE.CatmullRomCurve3([
    new THREE.Vector3(0.846, 1.018, 0),
    new THREE.Vector3(1.020, 1.018, 0),
    new THREE.Vector3(1.197, 0.927, 0),
    new THREE.Vector3(1.249, 0.774, 0),
    new THREE.Vector3(1.141, 0.594, 0),
    new THREE.Vector3(0.942, 0.525, 0),
    new THREE.Vector3(0.641, 0.452, 0),
  ], false, 'centripetal');
  const handle = addMesh(new THREE.TubeGeometry(handleCurve, 84, 0.068, 20, false), ceramic);
  handle.scale.z = 0.9;

  const saucer = new THREE.Path();
  saucer.moveTo(0, 0.025);
  saucer.lineTo(0.33, 0.025);
  saucer.quadraticCurveTo(0.34, 0.011, 0.376, 0.014);
  saucer.quadraticCurveTo(0.404, 0.017, 0.424, 0.045);
  saucer.bezierCurveTo(0.67, 0.049, 1.064, 0.085, 1.229, 0.165);
  saucer.quadraticCurveTo(1.269, 0.190, 1.232, 0.216);
  saucer.bezierCurveTo(1.110, 0.229, 0.812, 0.168, 0.534, 0.163);
  saucer.quadraticCurveTo(0.480, 0.157, 0.454, 0.148);
  saucer.quadraticCurveTo(0.425, 0.162, 0.36, 0.166);
  saucer.lineTo(0, 0.166);
  saucer.lineTo(0, 0.025);
  addMesh(new THREE.LatheGeometry(saucer.getSpacedPoints(88), 160), ceramic);

  // A fine burnt-orange glaze line, deliberately smaller than a graphic logo.
  const glazeLine = addMesh(new THREE.TorusGeometry(1.210, 0.0045, 8, 160), accent);
  glazeLine.rotation.x = Math.PI / 2;
  glazeLine.position.y = 0.220;
  glazeLine.castShadow = false;

  const latteTexture = own(makeLatteTexture());
  latteTexture.anisotropy = Math.min(renderer.capabilities.getMaxAnisotropy(), 8);
  // The photographic surface already contains its soft lighting. Preserve its
  // espresso/ivory contrast instead of applying the bright ceramic studio twice.
  const coffeeMaterial = own(new THREE.MeshBasicMaterial({
    map: latteTexture,
    color: 0xffffff,
    toneMapped: false,
  }));
  const coffee = addMesh(new THREE.CircleGeometry(0.841, 144), coffeeMaterial);
  coffee.rotation.x = -Math.PI / 2;
  coffee.position.y = 1.065;
  coffee.castShadow = coffee.receiveShadow = false;

  // Real, creased bean geometry; each small orbit sits clear of the cup itself.
  const roastTexture = own(makeRoastTexture());
  const roastMaterial = own(new THREE.MeshPhysicalMaterial({
    color: 0x744127, map: roastTexture, roughness: 0.62,
    clearcoat: 0.09, clearcoatRoughness: 0.5, envMapIntensity: 0.45,
    bumpMap: ceramicTooth, bumpScale: 0.003,
  }));
  const creaseMaterial = own(new THREE.MeshStandardMaterial({
    color: 0x2d170e, roughness: 0.9, envMapIntensity: 0.25,
  }));
  const beanGeometry = own(makeBeanGeometry());
  const creaseGeometry = own(makeBeanCreaseGeometry());
  const beans = [
    { radius: 1.59, height: 1.22, phase: 3.55, speed: 0.43, size: 1 },
    { radius: 1.40, height: 1.64, phase: 0.63, speed: -0.35, size: 0.86 },
    { radius: 1.55, height: 0.43, phase: 1.95, speed: 0.29, size: 0.93 },
  ].map((settings) => {
    const group = new THREE.Group();
    scene.add(group);
    addMesh(beanGeometry, roastMaterial, group);
    addMesh(creaseGeometry, creaseMaterial, group);
    group.scale.setScalar(settings.size);
    return { ...settings, group };
  });

  // Soft alpha ribbons curve through actual 3D space, with normal blending.
  // They are intentionally faint: no luminous wire, glow, or particle spray.
  const steamTexture = own(makeSteamTexture());
  const steam = [0, 1].map((index) => {
    const geometry = own(makeSteamGeometry());
    const material = own(new THREE.MeshBasicMaterial({
      map: steamTexture, color: 0xf3e8d8, transparent: true,
      opacity: index === 0 ? 0.14 : 0.09, depthWrite: false,
      side: THREE.DoubleSide, toneMapped: false,
    }));
    const mesh = addMesh(geometry, material);
    mesh.rotation.y = index * Math.PI / 2;
    mesh.castShadow = mesh.receiveShadow = false;
    mesh.frustumCulled = false;
    mesh.renderOrder = 2;
    return { geometry, material, mesh, phase: index * 2.6 };
  });

  scene.add(new THREE.HemisphereLight(0xfff5e8, 0x726154, 0.46));
  const key = new THREE.DirectionalLight(0xfff3df, 1.75);
  key.position.set(-3.5, 6, 4.3);
  key.castShadow = true;
  key.shadow.mapSize.set(1024, 1024);
  Object.assign(key.shadow.camera, { left: -3, right: 3, top: 3, bottom: -3, near: 0.2, far: 14 });
  key.shadow.bias = -0.00025;
  key.shadow.normalBias = 0.018;
  scene.add(key);
  const fill = new THREE.DirectionalLight(0xe6edff, 0.38);
  fill.position.set(4, 2.5, 3);
  scene.add(fill);
  const rim = new THREE.DirectionalLight(0xfff2d9, 0.85);
  rim.position.set(-1, 4, -4);
  scene.add(rim);

  const shadowTexture = own(makeShadowTexture());
  const contactMaterial = own(new THREE.MeshBasicMaterial({
    map: shadowTexture, transparent: true, opacity: 0.32,
    depthWrite: false, toneMapped: false,
  }));
  const contact = addMesh(new THREE.PlaneGeometry(4.1, 3.5), contactMaterial, scene);
  contact.rotation.x = -Math.PI / 2;
  contact.position.set(0.07, -0.13, 0.04);
  contact.castShadow = false;
  contact.receiveShadow = false;

  const groundMaterial = own(new THREE.ShadowMaterial({ opacity: 0.13, depthWrite: false }));
  const ground = addMesh(new THREE.PlaneGeometry(9, 9), groundMaterial, scene);
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -0.125;
  ground.castShadow = false;
  ground.receiveShadow = true;

  let disposed = false;
  let pendingLatteTexture = null;
  let contextLost = false;
  let inView = true;
  let userPaused = false;
  let frame = 0;
  let previousTime = 0;
  let elapsed = 0;
  let progress = 0;
  let targetProgress = 0;
  let cameraDistance = 7;
  const pointer = { x: 0, y: 0, targetX: 0, targetY: 0 };
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const finePointer = window.matchMedia('(hover: hover) and (pointer: fine)');
  const motionPaused = () => userPaused || reducedMotion.matches;

  function pose() {
    const p = progress * progress * (3 - 2 * progress);
    sculpture.rotation.set(
      0.025 + p * 0.045 + pointer.y * 0.13,
      -0.48 + p * Math.PI / 2 + pointer.x * 0.45 + Math.sin(elapsed * Math.PI / 5) * 0.38,
      -0.026 + p * 0.054 + Math.sin(elapsed * 0.42) * 0.018,
    );
    sculpture.position.set(
      -0.04 + p * 0.12 + pointer.x * 0.05,
      0.10 + Math.sin(p * Math.PI) * 0.08 + Math.sin(elapsed * 0.68) * 0.045,
      0,
    );
    sculpture.scale.setScalar(1 - p * 0.065);
    contact.scale.setScalar(1 + Math.sin(p * Math.PI) * 0.05);
    contactMaterial.opacity = 0.32 - Math.sin(p * Math.PI) * 0.045;
    beans.forEach((bean, index) => {
      const angle = bean.phase + elapsed * bean.speed + p * 0.4;
      bean.group.position.set(
        Math.cos(angle) * bean.radius,
        bean.height + Math.sin(elapsed * 0.8 + bean.phase) * 0.075,
        Math.sin(angle) * bean.radius,
      );
      bean.group.rotation.set(
        0.18 + Math.sin(elapsed * 0.55 + index) * 0.18,
        -angle + index * 0.7,
        -0.38 + index * 0.32 + Math.sin(elapsed * 0.42 + index) * 0.16,
      );
    });
    steam.forEach((wisp) => {
      updateSteamGeometry(wisp.geometry, elapsed, wisp.phase);
      wisp.material.opacity = 0.105 + Math.sin(elapsed * 0.55 + wisp.phase) * 0.025;
    });
    updateCamera();
  }

  function updateCamera() {
    const angle = 0.611 + progress * 0.105;
    camera.position.set(0, 0.60 + cameraDistance * Math.sin(angle), cameraDistance * Math.cos(angle));
    camera.lookAt(0, 0.60, 0);
  }

  function draw(time) {
    frame = 0;
    if (disposed || contextLost || !inView || document.hidden) return;
    const delta = previousTime ? Math.min((time - previousTime) / 1000, 0.04) : 1 / 60;
    previousTime = time;
    if (!motionPaused()) {
      elapsed += delta;
      progress = THREE.MathUtils.damp(progress, targetProgress, 5.6, delta);
      pointer.x = THREE.MathUtils.damp(pointer.x, pointer.targetX, 4.8, delta);
      pointer.y = THREE.MathUtils.damp(pointer.y, pointer.targetY, 4.8, delta);
      pose();
    }
    renderer.render(scene, camera);
    if (!motionPaused()) frame = requestAnimationFrame(draw);
  }

  function requestDraw() {
    if (!frame && !disposed && !contextLost && inView && !document.hidden) {
      frame = requestAnimationFrame(draw);
    }
  }

  function loadLattePhotography() {
    // Keep initialization synchronous and the procedural fallback visible while
    // this one local asset loads. A late callback must never revive a dead scene.
    try {
      pendingLatteTexture = own(new THREE.TextureLoader().load(
        new URL('./assets/latte-art-photographic.webp', import.meta.url).href,
        (texture) => {
          pendingLatteTexture = null;
          if (disposed || contextLost) {
            resources.delete(texture);
            texture.dispose();
            return;
          }
          texture.colorSpace = THREE.SRGBColorSpace;
          texture.anisotropy = Math.min(renderer.capabilities.getMaxAnisotropy(), 8);
          coffeeMaterial.map = texture;
          coffeeMaterial.needsUpdate = true;
          resources.delete(latteTexture);
          latteTexture.dispose();
          requestDraw();
        },
        undefined,
        () => {
          if (pendingLatteTexture) {
            resources.delete(pendingLatteTexture);
            pendingLatteTexture.dispose();
            pendingLatteTexture = null;
          }
          // No visual interruption: the already rendered fallback remains.
        },
      ));
    } catch {
      // Missing image support leaves a complete, usable procedural cup.
    }
  }

  function stop() {
    if (frame) cancelAnimationFrame(frame);
    frame = 0;
    previousTime = 0;
  }

  function resize() {
    if (disposed || contextLost) return;
    const width = Math.max(1, container.clientWidth);
    const height = Math.max(1, container.clientHeight);
    const aspect = width / height;
    camera.aspect = aspect;
    // This envelope includes the entire saucer, orbiting beans, and rising steam.
    const visibleHeight = aspect < 1 ? 3.85 / aspect : 3.85;
    cameraDistance = visibleHeight / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)));
    updateCamera();
    camera.updateProjectionMatrix();
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.7));
    renderer.setSize(width, height, false);
    requestDraw();
  }

  function onPointerMove(event) {
    if (event.pointerType !== 'mouse' || !finePointer.matches || motionPaused()) return;
    const rect = container.getBoundingClientRect();
    pointer.targetX = THREE.MathUtils.clamp(((event.clientX - rect.left) / rect.width - 0.5) * 2, -1, 1);
    pointer.targetY = THREE.MathUtils.clamp(((event.clientY - rect.top) / rect.height - 0.5) * 2, -1, 1);
    requestDraw();
  }

  function resetPointer() {
    pointer.targetX = 0;
    pointer.targetY = 0;
  }

  function onVisibilityChange() {
    if (document.hidden) stop(); else requestDraw();
  }

  function onMotionChange() {
    if (motionPaused()) stop();
    resetPointer();
    requestDraw();
  }

  function onContextLost(event) {
    event.preventDefault();
    contextLost = true;
    stop();
    canvas.style.visibility = 'hidden';
    container.dispatchEvent(new CustomEvent('coffee-scene-error', {
      detail: { message: 'The 3D graphics context became unavailable.' },
    }));
  }

  container.addEventListener('pointermove', onPointerMove, { passive: true });
  container.addEventListener('pointerleave', resetPointer, { passive: true });
  document.addEventListener('visibilitychange', onVisibilityChange);
  const stopReducedChanges = listenMediaQuery(reducedMotion, onMotionChange);
  canvas.addEventListener('webglcontextlost', onContextLost);
  const resizeObserver = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(resize) : null;
  resizeObserver?.observe(container);
  window.addEventListener('resize', resize, { passive: true });
  const intersectionObserver = typeof IntersectionObserver !== 'undefined'
    ? new IntersectionObserver(([entry]) => {
      inView = entry.isIntersecting;
      if (inView) requestDraw(); else stop();
    }, { rootMargin: '80px', threshold: 0 })
    : null;
  intersectionObserver?.observe(container);

  pose();
  resize();
  loadLattePhotography();

  return {
    setProgress(value) {
      if (!Number.isFinite(value) || disposed) return;
      targetProgress = THREE.MathUtils.clamp(value, 0, 1);
      requestDraw();
    },
    setPaused(value) {
      userPaused = Boolean(value);
      onMotionChange();
    },
    resize,
    dispose() {
      if (disposed) return;
      disposed = true;
      stop();
      resizeObserver?.disconnect();
      intersectionObserver?.disconnect();
      container.removeEventListener('pointermove', onPointerMove);
      container.removeEventListener('pointerleave', resetPointer);
      document.removeEventListener('visibilitychange', onVisibilityChange);
      window.removeEventListener('resize', resize);
      stopReducedChanges();
      canvas.removeEventListener('webglcontextlost', onContextLost);
      resources.forEach((resource) => resource.dispose());
      scene.clear();
      renderer.dispose();
      canvas.remove();
    },
  };
}

function randomSequence(seed) {
  return () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 4294967296;
  };
}

function makeBeanGeometry() {
  const geometry = new THREE.SphereGeometry(1, 36, 24);
  const position = geometry.attributes.position;
  for (let i = 0; i < position.count; i++) {
    const x = position.getX(i);
    const y = position.getY(i);
    const z = position.getZ(i);
    const taper = Math.max(0, 1 - x * x);
    const groove = y > 0 ? Math.exp(-Math.pow(z / 0.13, 2)) * Math.pow(taper, 0.6) * 0.025 : 0;
    position.setXYZ(i,
      x * 0.185,
      y * 0.101 - groove,
      z * 0.129 + Math.sin(x * Math.PI * 0.9) * 0.018,
    );
  }
  position.needsUpdate = true;
  geometry.computeVertexNormals();
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return geometry;
}

function makeBeanCreaseGeometry() {
  const points = [];
  for (let i = 0; i <= 28; i++) {
    const x = -0.87 + i / 28 * 1.74;
    const taper = Math.max(0, 1 - x * x);
    points.push(new THREE.Vector3(
      x * 0.185,
      Math.sqrt(taper) * 0.101 - Math.pow(taper, 0.6) * 0.025 + 0.0005,
      Math.sin(x * Math.PI * 0.9) * 0.018,
    ));
  }
  return new THREE.TubeGeometry(new THREE.CatmullRomCurve3(points), 48, 0.0055, 8, false);
}

function makeRoastTexture() {
  const surface = document.createElement('canvas');
  surface.width = surface.height = 128;
  const context = surface.getContext('2d');
  const data = context.createImageData(128, 128);
  const random = randomSequence(43381);
  for (let i = 0; i < data.data.length; i += 4) {
    const texture = 0.77 + random() * 0.23;
    data.data[i] = Math.round(240 * texture);
    data.data[i + 1] = Math.round(214 * texture);
    data.data[i + 2] = Math.round(182 * texture);
    data.data[i + 3] = 255;
  }
  context.putImageData(data, 0, 0);
  const texture = new THREE.CanvasTexture(surface);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(2, 2);
  return texture;
}

function makeSteamTexture() {
  const surface = document.createElement('canvas');
  surface.width = 64;
  surface.height = 256;
  const context = surface.getContext('2d');
  const data = context.createImageData(64, 256);
  for (let y = 0; y < 256; y++) {
    for (let x = 0; x < 64; x++) {
      const i = (y * 64 + x) * 4;
      const softness = Math.exp(-Math.pow((x / 63 - 0.5) / 0.21, 2));
      const fade = Math.pow(Math.sin(y / 255 * Math.PI), 1.4);
      data.data[i] = data.data[i + 1] = data.data[i + 2] = 255;
      data.data[i + 3] = Math.round(255 * softness * fade);
    }
  }
  context.putImageData(data, 0, 0);
  const texture = new THREE.CanvasTexture(surface);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

function makeSteamGeometry() {
  const segments = 40;
  const geometry = new THREE.BufferGeometry();
  const positions = new Float32Array((segments + 1) * 2 * 3);
  const uvs = new Float32Array((segments + 1) * 2 * 2);
  const indices = [];
  for (let i = 0; i <= segments; i++) {
    uvs.set([0, i / segments, 1, i / segments], i * 4);
    if (i < segments) {
      const v = i * 2;
      indices.push(v, v + 1, v + 2, v + 1, v + 3, v + 2);
    }
  }
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3).setUsage(THREE.DynamicDrawUsage));
  geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  updateSteamGeometry(geometry, 0, 0);
  return geometry;
}

function updateSteamGeometry(geometry, time, phase) {
  const positions = geometry.attributes.position;
  const segments = positions.count / 2 - 1;
  for (let i = 0; i <= segments; i++) {
    const u = i / segments;
    const width = 0.026 + u * 0.11;
    const wave = u * 7.2 - time * 0.7 + phase;
    const x = Math.sin(wave) * (0.025 + u * 0.105) + (phase ? 0.07 : -0.04);
    const y = 1.075 + u * 0.96;
    const z = Math.cos(wave * 0.71) * u * 0.09;
    positions.setXYZ(i * 2, x - width, y, z - width * 0.28);
    positions.setXYZ(i * 2 + 1, x + width, y, z + width * 0.28);
  }
  positions.needsUpdate = true;
}

function makeCeramicTexture() {
  const surface = document.createElement('canvas');
  surface.width = surface.height = 128;
  const context = surface.getContext('2d');
  const pixels = context.createImageData(128, 128);
  const random = randomSequence(7159);
  for (let i = 0; i < pixels.data.length; i += 4) {
    const value = 229 + Math.floor(random() * 22);
    pixels.data[i] = pixels.data[i + 1] = pixels.data[i + 2] = value;
    pixels.data[i + 3] = 255;
  }
  context.putImageData(pixels, 0, 0);
  const texture = new THREE.CanvasTexture(surface);
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(10, 5);
  return texture;
}

function makeShadowTexture() {
  const surface = document.createElement('canvas');
  surface.width = surface.height = 256;
  const context = surface.getContext('2d');
  const gradient = context.createRadialGradient(128, 128, 12, 128, 128, 124);
  gradient.addColorStop(0, 'rgba(29,20,12,0.56)');
  gradient.addColorStop(0.28, 'rgba(29,20,12,0.4)');
  gradient.addColorStop(0.64, 'rgba(29,20,12,0.13)');
  gradient.addColorStop(1, 'rgba(29,20,12,0)');
  context.fillStyle = gradient;
  context.fillRect(0, 0, 256, 256);
  const texture = new THREE.CanvasTexture(surface);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

function makeLatteTexture() {
  const surface = document.createElement('canvas');
  surface.width = surface.height = 1536;
  const context = surface.getContext('2d');
  context.scale(1.5, 1.5);
  const random = randomSequence(31017);
  const crema = context.createRadialGradient(460, 443, 20, 510, 510, 525);
  crema.addColorStop(0, '#b88550');
  crema.addColorStop(0.48, '#b17b44');
  crema.addColorStop(0.81, '#a76f38');
  crema.addColorStop(0.954, '#9b622f');
  crema.addColorStop(0.986, '#80491f');
  crema.addColorStop(1, '#693919');
  context.fillStyle = crema;
  context.fillRect(0, 0, 1024, 1024);

  // Gentle crema mottling: irregular, low-contrast fluid variation rather than a flat fill.
  for (let i = 0; i < 105; i++) {
    const angle = random() * Math.PI * 2;
    const radius = Math.sqrt(random()) * 460;
    const x = 512 + Math.cos(angle) * radius;
    const y = 512 + Math.sin(angle) * radius;
    const r = 22 + random() * 94;
    const cloud = context.createRadialGradient(x, y, 0, x, y, r);
    const light = random() > 0.4;
    cloud.addColorStop(0, light ? 'rgba(245,207,150,0.072)' : 'rgba(105,52,21,0.045)');
    cloud.addColorStop(1, light ? 'rgba(245,207,150,0)' : 'rgba(105,52,21,0)');
    context.fillStyle = cloud;
    context.fillRect(x - r, y - r, r * 2, r * 2);
  }

  // The thin, imperfect crema ring remains restrained beneath the ceramic rim.
  for (let i = 0; i < 12; i++) {
    context.beginPath();
    context.ellipse(510 + random() * 4, 510 + random() * 4,
      474 + i * 1.7, 474 + i * 1.65, random() * 0.03,
      0.12 + random() * 0.16, Math.PI * (1.65 + random() * 0.25));
    context.lineWidth = 0.5 + random() * 0.9;
    context.strokeStyle = i % 3 ? 'rgba(243,210,163,0.08)' : 'rgba(89,47,21,0.10)';
    context.stroke();
  }

  for (let i = 0; i < 5200; i++) {
    const angle = random() * Math.PI * 2;
    const radius = Math.sqrt(random()) * 507;
    const size = 0.18 + random() * (radius > 466 ? 1.2 : 0.6);
    context.fillStyle = random() > 0.33
      ? `rgba(248,218,173,${0.05 + random() * 0.16})`
      : `rgba(96,48,21,${0.025 + random() * 0.07})`;
    context.beginPath();
    context.arc(512 + Math.cos(angle) * radius, 512 + Math.sin(angle) * radius, size, 0, Math.PI * 2);
    context.fill();
  }

  context.save();
  context.translate(512, 509);
  context.rotate(-0.17);
  context.scale(1.10, 1.10);
  const milk = context.createLinearGradient(-225, -285, 180, 275);
  milk.addColorStop(0, '#fff8e9');
  milk.addColorStop(0.52, '#fbf3e0');
  milk.addColorStop(1, '#eee1bf');
  context.fillStyle = milk;

  // A rosetta is a stack of curved pour ribbons. Open coffee channels separate
  // every ribbon; their taper and slight asymmetry avoid a graphic leaf silhouette.
  const widths = [148, 192, 224, 248, 263, 269, 267, 260, 250, 237, 221, 204,
    186, 168, 150, 133, 117, 103, 88, 75, 63, 52, 42, 32];
  widths.forEach((width, index) => {
    const y = 236 - index * 19;
    const center = Math.sin(index * 0.42) * 2.1;
    for (const side of [-1, 1]) {
      const w = width * (side < 0 ? 1.015 : 0.977) * (0.99 + random() * 0.02);
      const sweep = 27 + w * 0.18;
      const thickness = 10.6 + Math.sin(index * 0.7) * 1.2;
      const tipY = y - sweep;
      const x = value => center + side * value;
      const ribbonMilk = context.createLinearGradient(x(0), y, x(w), tipY);
      ribbonMilk.addColorStop(0, '#fff8ec');
      ribbonMilk.addColorStop(0.62, '#f8ecd3');
      ribbonMilk.addColorStop(1, 'rgba(252,241,219,0.84)');
      context.fillStyle = ribbonMilk;
      context.beginPath();
      context.moveTo(x(1.3), y + 7);
      context.bezierCurveTo(x(w * 0.28), y + 3, x(w * 0.88), tipY + 20, x(w), tipY);
      context.bezierCurveTo(x(w * 1.013), tipY - 7, x(w * 0.971), tipY - 8, x(w * 0.94), tipY - 3.5);
      context.bezierCurveTo(x(w * 0.69), tipY + 19, x(w * 0.26), y - thickness + 4, x(1.3), y - thickness);
      context.closePath();
      context.fill();
    }
  });

  // A modest, naturally rounded heart closes the fine upper feathers.
  context.fillStyle = milk;
  context.beginPath();
  context.moveTo(0, -204);
  context.bezierCurveTo(-25, -219, -71, -246, -66, -273);
  context.bezierCurveTo(-60, -302, -20, -305, -3, -279);
  context.bezierCurveTo(20, -308, 59, -294, 64, -270);
  context.bezierCurveTo(68, -245, 23, -219, 0, -204);
  context.fill();

  // One fine final pull-through joins the design without painting a broad stripe.
  context.beginPath();
  context.moveTo(-2.5, -221);
  context.bezierCurveTo(1, -120, -2, 105, -0.5, 239);
  context.bezierCurveTo(0, 263, 6.5, 281, 13, 295);
  context.bezierCurveTo(2, 280, -5, 266, -6, 242);
  context.bezierCurveTo(-6, 112, -4, -112, -2.5, -221);
  context.fill();
  context.restore();

  // Minute microfoam texture keeps the milk silky instead of looking like a decal.
  for (let i = 0; i < 6100; i++) {
    const x = 170 + random() * 685;
    const y = 155 + random() * 720;
    context.fillStyle = random() > 0.35 ? 'rgba(255,254,240,0.037)' : 'rgba(133,92,50,0.024)';
    context.fillRect(x, y, 0.45 + random() * 0.8, 0.45 + random() * 0.8);
  }
  const texture = new THREE.CanvasTexture(surface);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}
