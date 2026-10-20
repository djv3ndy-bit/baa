import { initHomepageActions } from './actions.js';
import { initCtaImagery } from './cta-imagery.js';
import { initSectionMotion } from './section-motion.js';
import { listenMediaQuery } from './media-query.js';

function initialize() {
  // Navigation and account controls stay independent of photos and WebGL.
  initHomepageActions();
  const media = document.getElementById('preview-hero-media');
  const photo = document.getElementById('preview-hero-photo');
  const card = document.getElementById('preview-job-card');
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  const pauseButton = document.querySelector('[data-pause-motion]');
  let paused = reduced.matches;
  let motion;
  let sectionMotion;

  initCtaImagery({
    barista: { src: '/homepage/assets/uploaded-barista.webp', alt: 'A barista with short dark hair working at an espresso machine in a warm café', position: '50% 55%', width: 1122, height: 1402 },
    hiring: { src: '/homepage/assets/uploaded-cafe-bar.webp', alt: 'A smiling man holding a latte cup and milk pitcher behind a café bar', position: '65% 0%', width: 1122, height: 1402 }
  });

  const latte = document.createElement('div');
  latte.className = 'matched-latte';
  latte.hidden = true;
  latte.setAttribute('role', 'img');
  latte.setAttribute('aria-label', 'An interactive three-dimensional latte cup on a ceramic saucer');
  media.append(latte);
  const stack = document.createElement('div');
  stack.className = 'hero-photo-stack';
  stack.innerHTML = '<figure class="hero-float-photo float-portrait"><div class="hero-float-crop"><img src="/homepage/assets/uploaded-team.webp" alt="Two coworkers preparing drinks behind a busy café counter" width="1122" height="1402" draggable="false"></div></figure><figure class="hero-float-photo float-detail"><div class="hero-float-crop"><img src="/homepage/assets/latte-pour.webp" alt="A close view of latte art being poured" width="1800" height="2250" draggable="false"></div></figure>';
  media.append(stack);
  photo.draggable = false;
  function crop() { photo.style.objectPosition = innerWidth <= 680 ? '57% 50%' : '50% 50%'; }
  crop();
  window.addEventListener('resize', crop, { passive: true });

  function updatePause() {
    const stopped = paused || reduced.matches;
    document.body.classList.toggle('motion-paused', stopped);
    document.body.classList.toggle('motion-enabled', !stopped);
    pauseButton.hidden = reduced.matches;
    pauseButton.setAttribute('aria-pressed', String(stopped));
    pauseButton.textContent = stopped ? 'Resume motion' : 'Pause motion';
    motion?.setPaused(stopped);
    sectionMotion?.setPaused(stopped);
  }
  pauseButton.addEventListener('click', () => { paused = !paused; updatePause(); });
  listenMediaQuery(reduced, () => { paused = reduced.matches; updatePause(); });
  updatePause();
  try { sectionMotion = initSectionMotion({ paused }); }
  catch (error) { console.warn('Section motion unavailable; the homepage remains usable.', error); }

  // Motion is progressive enhancement: its failure never blocks a button or hides copy.
  import('./matched-motion.js').then(async ({ createHomepageMotion }) => {
    motion = await createHomepageMotion({ media, photo, card, latteContainer: latte, photoLayers: [...stack.children] });
    motion.setVariant('depth');
    updatePause();
  }).catch(error => {
    latte.hidden = true;
    console.warn('Homepage motion unavailable; the café photo remains visible.', error);
  });
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initialize, { once: true });
else initialize();
