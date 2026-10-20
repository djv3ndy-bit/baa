const DISMISSED_KEY = 'baristamatch_app_strip_dismissed';
const ANDROID_URL = 'https://play.google.com/store/apps/details?id=com.baristajobmatch.app';

/** Offer the Android app without interrupting website navigation. */
export function getAppDownloadOffer(view) {
  const navigator = view.navigator || {};
  if (navigator.standalone === true ||
      view.matchMedia?.('(display-mode:standalone)')?.matches) return null;
  try {
    if (view.localStorage?.getItem(DISMISSED_KEY) === '1') return null;
  } catch {}

  if (/Android/i.test(navigator.userAgent || '')) {
    return {platform: 'android', href: ANDROID_URL, label: 'Get BaristaMatch on Google Play'};
  }
  return null;
}

export function initAppDownload(view = window) {
  const offer = getAppDownloadOffer(view);
  const document = view.document;
  if (!offer || !document?.body || document.getElementById('app-download-strip')) return null;

  const style = document.createElement('style');
  style.id = 'app-download-style';
  style.textContent = `
    .app-download-strip{min-height:58px;padding:8px max(12px,env(safe-area-inset-right)) 8px max(12px,env(safe-area-inset-left));display:flex;align-items:center;gap:8px;background:#fffaf5;border-bottom:1px solid var(--line);color:var(--brown)}
    .app-download-icon{width:38px;height:38px;flex:0 0 38px;border-radius:10px;background:#fff;border:1px solid var(--line);object-fit:contain;padding:3px}
    .app-download-copy{min-width:0;flex:1;font-size:12px;font-weight:850;line-height:1.2}
    .app-download-button{display:inline-flex;align-items:center;justify-content:center;min-height:44px;flex:0 0 auto;border-radius:11px;padding:10px 12px;background:var(--orange);color:#fff;font-size:12px;font-weight:900;box-shadow:0 6px 16px #b7602226}
    .app-download-close{width:44px;height:44px;flex:0 0 44px;border:0;background:transparent;color:#6e5b50;font-size:23px;line-height:1;cursor:pointer}
  `;
  document.head.append(style);

  const strip = document.createElement('aside');
  strip.id = 'app-download-strip';
  strip.className = 'app-download-strip';
  strip.setAttribute('data-platform', offer.platform);
  strip.setAttribute('aria-label', 'Get the BaristaMatch app');
  const icon = document.createElement('img');
  icon.className = 'app-download-icon';
  icon.src = '/assets/favicon-transparent-v2.png';
  icon.alt = '';
  const copy = document.createElement('span');
  copy.className = 'app-download-copy';
  copy.textContent = 'Get the BaristaMatch app';
  const link = document.createElement('a');
  link.className = 'app-download-button';
  link.href = offer.href;
  link.target = '_blank';
  link.rel = 'noopener';
  link.setAttribute('aria-label', offer.label);
  link.textContent = 'Google Play';
  const close = document.createElement('button');
  close.className = 'app-download-close';
  close.type = 'button';
  close.setAttribute('aria-label', 'Dismiss app suggestion');
  close.textContent = '×';
  close.addEventListener('click', () => {
    strip.remove();
    try { view.localStorage?.setItem(DISMISSED_KEY, '1'); } catch {}
  });
  strip.append(icon, copy, link, close);
  document.body.prepend(strip);
  return strip;
}

if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  initAppDownload(window);
}
