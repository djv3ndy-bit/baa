document.addEventListener('DOMContentLoaded', () => {
  const heroImage = document.querySelector('.hero-photo');
  if (heroImage) {
    heroImage.src = '/assets/warm-editorial-cafe-v2.jpg';
    heroImage.alt = 'Anonymous barista seen from behind in a warm neighborhood café';
    heroImage.loading = 'eager';
    heroImage.setAttribute('fetchpriority', 'high');
  }

  const finalImage = document.querySelector('.final-image img');
  if (finalImage) {
    finalImage.src = '/assets/warm-editorial-cafe-v2.jpg';
    finalImage.alt = 'Warm neighborhood café with an anonymous barista at the espresso machine';
  }

  document.querySelectorAll('.audience-card img').forEach((image) => {
    image.src = '/assets/warm-editorial-cafe-v2.jpg';
    image.alt = 'Warm neighborhood café with a barista seen only from behind';
  });

  const featured = document.querySelector('.phone');
  if (featured) featured.setAttribute('aria-label', 'Featured Café Feliz job');

  const featuredLabel = document.querySelector('.phone-bar');
  if (featuredLabel) featuredLabel.textContent = 'FEATURED OPPORTUNITY';

  const featuredCard = document.querySelector('.phone-card');
  if (featuredCard) {
    featuredCard.innerHTML = `
      <h3>Senior Barista</h3>
      <p>Café Feliz · Wynwood, Miami</p>
      <div class="pills"><span>Full-time</span><span>Day shifts</span><span>Tips</span></div>
      <p class="featured-link">View job →</p>`;
  }

  const labels = ['☕ Coffee-focused profiles', '▣ Clear pay & schedules', '◯ Direct connections'];
  document.querySelectorAll('.trust span').forEach((item, index) => {
    if (index < labels.length) item.textContent = labels[index];
    else item.hidden = true;
  });
});
