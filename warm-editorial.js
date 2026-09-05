document.addEventListener('DOMContentLoaded', () => {
  const paths = {
    user: '<circle cx="12" cy="7" r="4"/><path d="M4 22v-3a8 8 0 0 1 16 0v3Z"/>',
    shop: '<path d="M3 10V5l2-3h14l2 3v5M3 10c0 3 4 3 4 0 0 3 5 3 5 0 0 3 5 3 5 0 0 3 4 3 4 0M5 13v9h14v-9M9 22v-7h6v7M8 2l-1 8M16 2l1 8"/>',
    coffee: '<path d="M3 6h14v7a7 7 0 0 1-14 0V6ZM17 7h2a3 3 0 0 1 0 6h-2M2 21h17M7 1v2M12 1v2"/>',
    calendar: '<rect x="3" y="5" width="18" height="17" rx="2"/><path d="M7 2v6M17 2v6M3 11h18M7 15h1m3 0h1m3 0h1M7 18h1m3 0h1m3 0h1"/>',
    message: '<path d="M21 11a9 9 0 0 1-9 9c-1 0-3-.3-4-1l-6 3 2-6a9 9 0 1 1 17-5Z"/>',
    search: '<circle cx="10" cy="10" r="7"/><path d="m15 15 7 7"/>',
    document: '<path d="M5 2h9l5 5v15H5ZM14 2v6h5M8 12h8M8 16h8"/>',
    people: '<circle cx="8" cy="7" r="3"/><circle cx="17" cy="7" r="3"/><path d="M2 21v-3a6 6 0 0 1 12 0v3ZM16 12a6 6 0 0 1 6 6v3h-5"/>'
  };
  const icon = name => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name]}</svg>`;
  const heroImage = document.querySelector('.hero-photo');
  if (heroImage) {
    heroImage.src = '/assets/editorial-hero-v3.jpg';
    heroImage.alt = 'Barista seen from behind working at the Café Feliz espresso bar';
    heroImage.loading = 'eager';
    heroImage.setAttribute('fetchpriority', 'high');
  }
  const finalImage = document.querySelector('.final-image img');
  if (finalImage) {
    finalImage.src = '/assets/editorial-hero-v3.jpg';
    finalImage.alt = 'Warm café scene with a barista seen from behind';
  }
  document.querySelectorAll('.audience-card img').forEach(image => {
    image.src = '/assets/editorial-hero-v3.jpg';
    image.alt = 'Warm neighborhood café with a barista seen from behind';
  });
  document.querySelectorAll('.role-card .role-icon').forEach((node,index) => { node.innerHTML = icon(index ? 'shop' : 'user'); });
  const featured = document.querySelector('.phone');
  if (featured) featured.setAttribute('aria-label', 'Illustrative Café Feliz job card');
  const featuredCard = document.querySelector('.phone-card');
  if (featuredCard) featuredCard.innerHTML = `
    <img class="featured-photo" src="/assets/editorial-cafe-v3.jpg" alt="Café Feliz interior illustration">
    <div class="featured-title"><h3>Senior Barista</h3><strong>$22/hr</strong></div>
    <p>Café Feliz · Wynwood, Miami</p>
    <div class="pills"><span>Full-time</span><span>Day shifts</span><span>Latte art</span></div>
    <a class="featured-link" href="/dashboard.html">View jobs →</a>
    <small class="featured-example">Example listing · illustrative photo</small>`;
  const trust = document.querySelector('.trust');
  if (trust) {
    trust.innerHTML = `<span>${icon('coffee')}<span>Coffee-focused profiles</span></span><span>${icon('calendar')}<span>Clear pay & schedules</span></span><span>${icon('message')}<span>Direct connections</span></span>`;
    const inner = document.querySelector('.hero-inner');
    inner.append(trust);
    const signoff = document.createElement('p');
    signoff.className = 'editorial-script editorial-mobile-signoff';
    signoff.textContent = 'People. Cafés. Opportunities. Together.';
    inner.append(signoff);
  }
  const steps = [
    ['document', '1. Create a profile', 'Tell us who you are and what you’re looking for.'],
    ['search', '2. Discover', 'Find cafés or baristas that match your goals.'],
    ['people', '3. Connect', 'Match, then reach out and start the conversation.']
  ];
  document.querySelectorAll('#how .step').forEach((node,index) => {
    const [name,title,copy] = steps[index];
    node.innerHTML = `<div class="step-icon">${icon(name)}</div><div><h3>${title}</h3><p>${copy}</p></div>`;
  });
  const how = document.querySelector('.how-grid');
  if(how) {
    const signoff = document.createElement('div');
    signoff.className = 'editorial-script how-signoff';
    signoff.innerHTML = 'People.<br>Cafés.<br>Opportunities.<br>Together.';
    how.append(signoff);
  }
  // Illustrative product screenshots must never imply real platform totals.
  const previews = document.querySelector('.preview-section');
  if(previews) {
    const note = document.createElement('p');
    note.textContent = 'Product examples — sample profiles and activity, not platform statistics.';
    note.style.cssText = 'text-align:center;color:#71665f;font-size:12px';
    previews.prepend(note);
  }
});
