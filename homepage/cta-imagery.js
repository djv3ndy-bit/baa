/* Add real photographs to the existing final choices without replacing their copy or links. */
export function initCtaImagery({barista = {}, hiring = {}} = {}) {
  const panel = document.querySelector('.final-panel');
  if (!panel) return {dispose() {}};
  const added = [];
  const classChanges = [];
  const addClass = (node, name) => {
    if (!node.classList.contains(name)) {
      node.classList.add(name);
      classChanges.push([node, name]);
    }
  };
  addClass(panel, 'cta-photo-panel');

  const choices = [
    {node: panel.querySelector('.choice:not(.hiring)'), defaults: {src: 'assets/cta-barista.webp', alt: 'A real barista preparing coffee at a busy café', position: '50% 50%'}, options: barista},
    {node: panel.querySelector('.choice.hiring'), defaults: {src: 'assets/cta-hiring.webp', alt: 'A real café team working together behind the coffee bar', position: '50% 50%'}, options: hiring}
  ];
  choices.forEach(({node, defaults, options}) => {
    if (!node || node.querySelector(':scope > .cta-photo-window')) return;
    const settings = {...defaults, ...options};
    const frame = document.createElement('figure');
    frame.className = 'cta-photo-window';
    const image = document.createElement('img');
    image.className = 'cta-photo sm-photo';
    image.src = settings.src;
    image.alt = settings.alt;
    image.loading = 'lazy';
    image.decoding = 'async';
    image.draggable = false;
    image.style.objectPosition = settings.position;
    if (settings.width) image.width = settings.width;
    if (settings.height) image.height = settings.height;
    frame.append(image);
    node.insertBefore(frame, node.firstChild);
    addClass(node, 'cta-photo-card');
    added.push(frame);
  });

  return {
    dispose() {
      added.forEach(frame => frame.remove());
      classChanges.forEach(([node, name]) => node.classList.remove(name));
    }
  };
}
