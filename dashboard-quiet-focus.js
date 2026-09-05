(function () {
  'use strict';

  const escapeHtml = (value) =>
    String(value ?? '')
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#039;');

  function timeGreeting(date = new Date()) {
    const hour = date.getHours();
    if (hour >= 5 && hour < 12) return 'Good morning';
    if (hour >= 12 && hour < 17) return 'Good afternoon';
    if (hour >= 17) return 'Good evening';
    return 'Welcome back';
  }

  function money(job) {
    const low = Number(job?.pay_min || 0);
    const high = Number(job?.pay_max || 0);
    if (low && high && low !== high) return `$${low.toFixed(low % 1 ? 2 : 0)}–$${high.toFixed(high % 1 ? 2 : 0)}/hr`;
    if (low || high) {
      const value = low || high;
      return `$${value.toFixed(value % 1 ? 2 : 0)}/hr`;
    }
    return 'Pay shared in listing';
  }

  function tagList(schedule) {
    const tags = String(schedule || 'Schedule in listing')
      .split('·')
      .map((tag) => tag.trim())
      .filter(Boolean)
      .slice(0, 3);
    return tags.map((tag) => `<span>${escapeHtml(tag)}</span>`).join('');
  }

  function featureImage(job) {
    const candidate = String(job?.owner?.avatar_url || '');
    const source = /^(https?:\/\/|\/(?!\/))/.test(candidate) ? candidate : '/assets/editorial-latte-v3.jpg';
    return `<div class="quiet-feature-image"><img src="${escapeHtml(source)}" alt="${candidate ? escapeHtml(job?.owner?.cafe_name || 'Café') : 'Coffee illustration'}" loading="lazy"></div>`;
  }

  function iconSvg(icon) {
    const paths = {
      '⌂': '<path d="m3 10 9-7 9 7v10H3z"/><path d="M9 20v-7h6v7"/>',
      '⌕': '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/>',
      '⌖': '<path d="M19 10c0 5-7 11-7 11S5 15 5 10a7 7 0 1 1 14 0Z"/><circle cx="12" cy="10" r="2"/>',
      '♡': '<path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1.1-1.1a5.5 5.5 0 0 0-7.8 7.8L12 21l8.8-8.6a5.5 5.5 0 0 0 0-7.8Z"/>',
      '◌': '<path d="M21 11.5a8.5 8.5 0 0 1-8.5 8.5H4l-2 2V11.5a9.5 9.5 0 0 1 19 0Z"/>',
      '◎': '<circle cx="12" cy="7" r="4"/><path d="M4 21v-2a8 8 0 0 1 16 0v2Z"/>',
      '♙': '<circle cx="12" cy="7" r="4"/><path d="M4 21v-2a8 8 0 0 1 16 0v2Z"/>',
      '▣': '<rect x="3" y="7" width="18" height="14" rx="2"/><path d="M8 7V3h8v4M3 12h18M10 12v3h4v-3"/>',
      '↗': '<rect x="5" y="3" width="14" height="18" rx="2"/><path d="M9 8h6M9 12h6M9 16h4"/>',
      '◷': '<circle cx="12" cy="12" r="9"/><path d="M12 6v6l4 2"/>'
    };
    return `<svg class="quiet-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[icon] || paths['◎']}</svg>`;
  }

  function activityTile({ icon, value, label, copy, section }) {
    return `<button class="quiet-activity-tile" type="button" data-go="${section}">
      <span class="quiet-activity-icon" aria-hidden="true">${iconSvg(icon)}</span>
      <span><strong>${escapeHtml(value)}</strong><b>${escapeHtml(label)}</b><small>${escapeHtml(copy)}</small></span>
      <span class="quiet-chevron" aria-hidden="true">›</span>
    </button>`;
  }

  function mobileHeader() {
    return `<div class="quiet-mobile-header">
      <a class="quiet-mobile-brand" href="/" aria-label="BaristaMatch home"><img src="/assets/favicon-transparent-v2.png" alt=""><span>Barista<b>Match</b></span></a>
    </div>`;
  }

  function mobileNav(isCafe) {
    const items = isCafe
      ? [['⌂', 'Home', 'Overview'], ['▣', 'Jobs', 'Job Posts'], ['⌕', 'Discover', 'Discover'], ['♡', 'Matches', 'Matches'], ['◎', 'Profile', 'Café Profile']]
      : [['⌂', 'Home', 'Overview'], ['⌕', 'Find Jobs', 'Discover'], ['♡', 'Matches', 'Matches'], ['◌', 'Messages', 'Messages'], ['◎', 'Profile', 'My Profile']];
    return `<nav class="quiet-mobile-nav" aria-label="Dashboard navigation">${items
      .map(([icon, label, section], index) => `<button class="${index === 0 ? 'active' : ''}" type="button" data-go="${section}"><span aria-hidden="true">${iconSvg(icon)}</span><small>${label}</small></button>`)
      .join('')}</nav>`;
  }

  function hero({ name, location, isCafe }) {
    const prompt = isCafe ? 'Find your next great barista' : 'Find your next shift';
    const destination = 'Discover';
    return `<section class="quiet-hero">
      <div class="quiet-hero-copy">
        <span class="quiet-kicker">GOOD TO SEE YOU</span>
        <h2>${timeGreeting()}, ${escapeHtml(name)}.</h2>
        <p>${isCafe ? 'Build your next great team.' : 'Find your next shift.'}</p>
      </div>
      <div class="quiet-handwritten" aria-hidden="true">Great coffee,<br>brighter days.</div>
      <div class="quiet-search-bar" aria-label="Quick search">
        <button type="button" data-go="${destination}"><span aria-hidden="true">${iconSvg('⌕')}</span><span>${prompt}</span></button>
        <button type="button" data-go="${destination}"><span aria-hidden="true">${iconSvg('⌖')}</span><span>${escapeHtml(location)}</span></button>
        <button class="quiet-search-action" type="button" data-go="${destination}">Search ${isCafe ? 'baristas' : 'jobs'} <span aria-hidden="true">→</span></button>
      </div>
    </section>`;
  }

  function baristaFeature(context) {
    const job = context.marketJobs.find((item) => item.active !== false) || context.marketJobs[0];
    if (!job) {
      return `<article class="quiet-feature-card quiet-empty-feature">
        ${featureImage(job)}
        <div class="quiet-feature-body"><span class="quiet-card-kicker">LOCAL OPPORTUNITIES</span><h3>Your next café starts here.</h3><p>New roles matching your saved Florida work area will appear here as cafés post them.</p><button class="quiet-primary" type="button" data-go="Discover">Explore jobs <span aria-hidden="true">→</span></button></div>
      </article>`;
    }
    const cafe = job.owner?.cafe_name || 'Local café';
    const location = job.location || context.profile.location || 'Florida';
    return `<article class="quiet-feature-card">
      ${featureImage(job)}
      <div class="quiet-feature-body">
        <span class="quiet-card-kicker">FEATURED JOB</span>
        <div class="quiet-title-row"><h3>${escapeHtml(job.title || 'Barista role')}</h3><strong>${escapeHtml(money(job))}</strong></div>
        <p class="quiet-meta">⌖ ${escapeHtml(cafe)} · ${escapeHtml(location)}</p>
        <div class="quiet-tags">${tagList(job.schedule)}</div>
        <p>${escapeHtml(job.description || 'Open the listing to learn more about this local café opportunity.')}</p>
        <button class="quiet-primary" type="button" data-go="Discover">View job <span aria-hidden="true">→</span></button>
      </div>
    </article>`;
  }

  function cafeFeature(context) {
    const job = context.marketJobs.find((item) => item.active !== false) || context.marketJobs[0];
    if (!job) {
      return `<article class="quiet-feature-card quiet-empty-feature">
        ${featureImage(job)}
        <div class="quiet-feature-body"><span class="quiet-card-kicker">START HIRING</span><h3>Post your first barista role.</h3><p>Add clear pay, schedule, location, and skills so nearby baristas know what to expect.</p><button class="quiet-primary" type="button" data-go="Job Posts">Post a job <span aria-hidden="true">→</span></button></div>
      </article>`;
    }
    return `<article class="quiet-feature-card">
      ${featureImage(job)}
      <div class="quiet-feature-body">
        <span class="quiet-card-kicker">YOUR JOB POST</span>
        <div class="quiet-title-row"><h3>${escapeHtml(job.title || 'Barista role')}</h3><span class="quiet-live">${job.active === false ? 'PAUSED' : 'LIVE'}</span></div>
        <p class="quiet-meta">⌖ ${escapeHtml(job.location || context.profile.location || 'Florida')}</p>
        <div class="quiet-tags">${tagList(job.schedule)}</div>
        <p>${escapeHtml(job.description || 'Keep this role current so nearby baristas can understand the opportunity.')}</p>
        <button class="quiet-primary" type="button" data-go="Job Posts">Manage job <span aria-hidden="true">→</span></button>
      </div>
    </article>`;
  }

  function moreJobs(context, isCafe) {
    const rows = context.marketJobs.slice(1, 3);
    if (!rows.length) return '';
    return `<section class="quiet-more"><div class="quiet-section-heading"><h3>${isCafe ? 'More job posts' : 'More jobs for you'}</h3><button type="button" data-go="${isCafe ? 'Job Posts' : 'Discover'}">See all <span aria-hidden="true">→</span></button></div><div class="quiet-more-grid">${rows
      .map((job) => `<button class="quiet-mini-job" type="button" data-go="${isCafe ? 'Job Posts' : 'Discover'}"><span class="quiet-mini-photo" aria-hidden="true"></span><span><strong>${escapeHtml(job.title || 'Barista role')}</strong><small>${escapeHtml(isCafe ? (job.location || 'Florida') : (job.owner?.cafe_name || 'Local café'))}</small></span><b>${escapeHtml(money(job))}</b></button>`)
      .join('')}</div></section>`;
  }

  function render(context) {
    const isCafe = context.role === 'cafe_owner_manager';
    const profile = context.profile || {};
    const displayName = context.profileName || (isCafe ? 'Your café' : 'there');
    const firstName = isCafe ? displayName : String(displayName).trim().split(/\s+/)[0] || 'there';
    const location = profile.location || (isCafe ? 'Add your café location' : 'Set your work area');
    const legacyMatches = context.applications.filter((item) => item.status === 'matched').length;
    const matches = legacyMatches + context.discoveryMatches.length;
    const unreadMessages = context.notificationRows.filter((item) => item.type === 'message' && !item.read_at).length;
    const feature = isCafe ? cafeFeature(context) : baristaFeature(context);
    const activeJobs = context.marketJobs.filter((item) => item.active !== false).length;
    const interested = context.applications.filter((item) => item.status === 'interested').length;
    const activity = isCafe
      ? [
          activityTile({ icon: '▣', value: activeJobs, label: 'Job posts', copy: 'Manage active roles', section: 'Job Posts' }),
          activityTile({ icon: '♙', value: interested, label: 'Candidates', copy: 'Review interest', section: 'Candidates' }),
          activityTile({ icon: '♡', value: matches, label: 'Matches', copy: 'See connections', section: 'Matches' }),
          activityTile({ icon: '◌', value: unreadMessages, label: 'Messages', copy: 'Open conversations', section: 'Messages' }),
        ]
      : [
          activityTile({ icon: '▣', value: context.marketJobs.length, label: 'Open jobs', copy: 'Browse nearby cafés', section: 'Discover' }),
          activityTile({ icon: '↗', value: context.applications.length, label: 'Applications', copy: 'Track your progress', section: 'Applications' }),
          activityTile({ icon: '◷', value: `${context.profileStrength}%`, label: 'Profile', copy: 'Profile completeness', section: 'My Profile' }),
        ];

    return `<section class="quiet-dashboard">
      ${mobileHeader()}
      ${hero({ name: firstName, location, isCafe })}
      <div class="quiet-layout">
        <div class="quiet-primary-column">
          <div class="quiet-section-heading"><h3>${isCafe ? 'Your hiring focus' : 'Best match for you'}</h3><button type="button" data-go="${isCafe ? 'Job Posts' : 'Discover'}">${isCafe ? 'Manage jobs' : 'See all jobs'} <span aria-hidden="true">→</span></button></div>
          ${feature}
          ${moreJobs(context, isCafe)}
        </div>
        <aside class="quiet-activity-panel">
          <h3>Your activity</h3>
          <div class="quiet-activity-grid">${activity.join('')}</div>
          <button class="quiet-note" type="button" data-go="${isCafe ? 'Café Profile' : 'My Profile'}"><span aria-hidden="true">⌁</span><span><strong>Good people.<br>Better opportunities.</strong><small>${isCafe ? 'Keep your café profile current.' : 'Keep your profile ready.'}</small></span><span aria-hidden="true">→</span></button>
        </aside>
      </div>
      ${mobileNav(isCafe)}
    </section>`;
  }

  window.BaristaMatchQuietFocus = { render, timeGreeting };
})();
