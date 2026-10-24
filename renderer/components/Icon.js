/**
 * Icon — monochrome SVG icon helper.
 *
 * Icons live in a `<symbol>` sprite injected once at boot by `ensureSpriteInstalled()`.
 * Strokes inherit `currentColor`, sizing via `--icon-size` CSS var (default 16).
 *
 * Usage:
 *   const el = icon('back');          // returns HTMLElement
 *   container.appendChild(el);
 *   icon('back', { size: 20 });       // explicit pixel size
 *   icon('back', { label: 'Go back' }); // aria-label for icon-only buttons
 *
 * Adding a new icon: add an entry to `ICON_PATHS` below. Keep paths at 16x16
 * viewBox with 1.5px stroke where applicable; fill-none stroke-based preferred.
 */

const SPRITE_ID = 'ic-icon-sprite';

// All icons render at 16x16 viewBox. Most are stroke-based at 1.5px.
// Path data uses `fill="none" stroke="currentColor" stroke-width="1.5"
// stroke-linecap="round" stroke-linejoin="round"` on each symbol.
const ICON_PATHS = {
  back:       '<path d="M10 3 L4 8 L10 13 M4 8 H14"/>',
  forward:    '<path d="M6 3 L12 8 L6 13 M12 8 H2"/>',
  up:         '<path d="M3 10 L8 5 L13 10"/>',
  down:       '<path d="M3 6 L8 11 L13 6"/>',
  refresh:    '<path d="M13.5 4 V8 H9.5 M13 8 A5 5 0 1 1 11.5 4.5"/>',
  home:       '<path d="M2.5 8 L8 3 L13.5 8 V13 H10 V10 H6 V13 H2.5 Z"/>',
  close:      '<path d="M4 4 L12 12 M12 4 L4 12"/>',
  check:      '<path d="M3 8.5 L6.5 12 L13 4.5"/>',
  plus:       '<path d="M8 3 V13 M3 8 H13"/>',
  minus:      '<path d="M3 8 H13"/>',
  search:     '<circle cx="7" cy="7" r="4"/><path d="M10 10 L13.5 13.5"/>',
  settings:   '<circle cx="8" cy="8" r="2.5"/><path d="M8 1.5 V3 M8 13 V14.5 M1.5 8 H3 M13 8 H14.5 M3.3 3.3 L4.4 4.4 M11.6 11.6 L12.7 12.7 M3.3 12.7 L4.4 11.6 M11.6 4.4 L12.7 3.3"/>',
  sliders:    '<path d="M3 4 H7 M9 4 H13 M3 8 H4.5 M6.5 8 H13 M3 12 H9 M11 12 H13"/><circle cx="8" cy="4" r="1.3"/><circle cx="5.5" cy="8" r="1.3"/><circle cx="10" cy="12" r="1.3"/>',
  palette:    '<path d="M8 2.2 A5.8 5.8 0 0 0 8 13.8 H9.2 A1.3 1.3 0 0 0 10.5 12.5 C10.5 11.8 10.1 11.4 10.1 10.9 C10.1 10.2 10.8 9.8 11.6 9.8 H12 A3.4 3.4 0 0 0 15 6.5 C15 4.1 12.1 2.2 8 2.2 Z"/><circle cx="5.5" cy="6.2" r=".5"/><circle cx="7.8" cy="4.8" r=".5"/><circle cx="10.2" cy="5.4" r=".5"/><circle cx="6.4" cy="9" r=".5"/>',
  power:      '<path d="M8 2 V8"/><path d="M5.1 4.1 A5 5 0 1 0 10.9 4.1"/>',
  shield:     '<path d="M8 2.2 L13 4 V7.5 C13 10.7 10.9 12.8 8 14 C5.1 12.8 3 10.7 3 7.5 V4 Z"/>',
  grid:       '<rect x="2.5" y="2.5" width="4.5" height="4.5" rx="1"/><rect x="9" y="2.5" width="4.5" height="4.5" rx="1"/><rect x="2.5" y="9" width="4.5" height="4.5" rx="1"/><rect x="9" y="9" width="4.5" height="4.5" rx="1"/>',
  globe:      '<circle cx="8" cy="8" r="5.5"/><path d="M2.8 8 H13.2 M8 2.5 C9.6 4 10.4 5.9 10.4 8 C10.4 10.1 9.6 12 8 13.5 M8 2.5 C6.4 4 5.6 5.9 5.6 8 C5.6 10.1 6.4 12 8 13.5"/>',
  cpu:        '<rect x="4.5" y="4.5" width="7" height="7" rx="1.2"/><path d="M6.5 1.8 V4.5 M9.5 1.8 V4.5 M6.5 11.5 V14.2 M9.5 11.5 V14.2 M1.8 6.5 H4.5 M1.8 9.5 H4.5 M11.5 6.5 H14.2 M11.5 9.5 H14.2"/><rect x="6.7" y="6.7" width="2.6" height="2.6" rx=".5"/>',
  user:       '<circle cx="8" cy="5.2" r="2.4"/><path d="M3.5 13.5 C4.2 10.9 5.7 9.7 8 9.7 C10.3 9.7 11.8 10.9 12.5 13.5"/>',
  sparkles:   '<path d="M6.2 2.2 L7.1 5 L9.8 5.8 L7.1 6.7 L6.2 9.5 L5.3 6.7 L2.6 5.8 L5.3 5 Z"/><path d="M11.4 7 L12 8.8 L13.8 9.4 L12 10 L11.4 11.8 L10.8 10 L9 9.4 L10.8 8.8 Z"/><path d="M5.2 11 L5.6 12.2 L6.8 12.6 L5.6 13 L5.2 14.2 L4.8 13 L3.6 12.6 L4.8 12.2 Z"/>',
  keyboard:   '<rect x="2" y="4" width="12" height="8" rx="1.5"/><path d="M4 6.5 H4.1 M6.2 6.5 H6.3 M8.4 6.5 H8.5 M10.6 6.5 H10.7 M12.5 6.5 H12.6 M4 9.5 H8.5 M10.5 9.5 H12.5"/>',
  tools:      '<path d="M10.8 2.5 L13.5 5.2 L10.9 7.8 L9.6 6.5 L5 11.1 L3.7 9.8 L8.3 5.2 L7 3.9 Z"/><path d="M4 12 L2.8 13.2 M11.2 10.2 L13.5 12.5"/>',
  library:    '<path d="M2.5 3 H13.5 M2.5 8 H13.5 M2.5 13 H13.5"/>',
  layout:     '<rect x="2.5" y="2.5" width="11" height="11" rx="1.5"/><path d="M8 2.5 V13.5 M2.5 8 H13.5"/>',
  multi:      '<rect x="2" y="3" width="5" height="4" rx="1"/><rect x="9" y="3" width="5" height="4" rx="1"/><rect x="2" y="9" width="5" height="4" rx="1"/><rect x="9" y="9" width="5" height="4" rx="1"/>',
  agent:      '<path d="M8 2 L13 5 V11 L8 14 L3 11 V5 Z"/><path d="M8 2 V14 M3 5 L13 11 M13 5 L3 11"/>',
  extensions: '<path d="M4 3 H8 V6 H11 V10 H8 V13 H4 V10 H7 V6 H4 Z"/>',
  broadcast:  '<circle cx="8" cy="8" r="1.5"/><path d="M5 5 Q3.5 8 5 11 M11 5 Q12.5 8 11 11 M3 3 Q1 8 3 13 M13 3 Q15 8 13 13"/>',
  compare:    '<rect x="2.5" y="3" width="4.8" height="10" rx="1"/><rect x="8.7" y="3" width="4.8" height="10" rx="1"/><path d="M4 6 H5.8 M4 8 H5.8 M10.2 6 H12 M10.2 8 H12 M10.2 10 H12"/>',
  dot:        '<circle cx="8" cy="8" r="3"/>',
  warn:       '<path d="M8 2 L14 13 H2 Z"/><path d="M8 6 V9 M8 11 V11.5"/>',
  pin:        '<path d="M6 1.5 H10 V6 L12 8 V9 H9 V14 H7 V9 H4 V8 L6 6 Z"/>',
  external:   '<path d="M6 3 H3 V13 H13 V10 M9 3 H13 V7 M7 9 L13 3"/>',
  copy:       '<rect x="5" y="5" width="8" height="8" rx="1"/><path d="M3 10 V3 H10"/>',
  edit:       '<path d="M3 11.5 V13 H4.5 L12 5.5 L10.5 4 Z"/><path d="M9.5 5 L11 6.5"/>',
  trash:      '<path d="M3 4.5 H13 M6 4.5 V3 H10 V4.5 M5 6 V13 H11 V6"/>',
  download:   '<path d="M8 2 V10 M4 7 L8 11 L12 7 M3 13 H13"/>',
  history:    '<path d="M3 8 A5 5 0 1 0 5 4"/><path d="M5 2 V4 H7"/><path d="M8 5 V8 L10.5 9.5"/>',
  bookmark:   '<path d="M4 2 H12 V14 L8 11 L4 14 Z"/>',
  tab:        '<path d="M2 5 H6 L7.5 3 H14 V13 H2 Z"/>',
  commandK:   '<rect x="2.5" y="2.5" width="11" height="11" rx="2"/><path d="M6 6 L8 8 L6 10 M10 6 L8 8 L10 10"/>',
  private:    '<path d="M3 7 L8 3 L13 7 V12 H3 Z"/><circle cx="8" cy="9" r="1.5"/>',
  bell:       '<path d="M4.5 11 V7.5 A3.5 3.5 0 0 1 11.5 7.5 V11 L12.5 12 H3.5 Z"/><path d="M6.5 12.5 A1.5 1.5 0 0 0 9.5 12.5"/>',
  camera:     '<path d="M2.5 5.5 H6 L7 4 H9 L10 5.5 H13.5 V12.5 H2.5 Z"/><circle cx="8" cy="9" r="2.2"/>',
  mic:        '<rect x="6" y="2.5" width="4" height="7" rx="2"/><path d="M4 8.5 A4 4 0 0 0 12 8.5 M8 12.5 V14 M6 14 H10"/>',
  location:   '<path d="M8 1.8 C5.2 1.8 3 4 3 6.8 C3 10 8 14 8 14 C8 14 13 10 13 6.8 C13 4 10.8 1.8 8 1.8 Z"/><circle cx="8" cy="6.8" r="1.8"/>',
  screen:     '<rect x="2" y="3" width="12" height="8" rx="1"/><path d="M6 13.5 H10 M8 11 V13.5"/>',
  speaker:    '<path d="M3 6 H5 L9 3 V13 L5 10 H3 Z"/><path d="M11 6 Q13 8 11 10 M12.5 4.5 Q15 8 12.5 11.5"/>',
  speakerMute:'<path d="M3 6 H5 L9 3 V13 L5 10 H3 Z"/><path d="M11 6 L14 10 M14 6 L11 10"/>',
  more:       '<circle cx="3.5" cy="8" r=".9"/><circle cx="8" cy="8" r=".9"/><circle cx="12.5" cy="8" r=".9"/>',
  panelLeft:  '<rect x="2" y="2.5" width="12" height="11" rx="1.5"/><path d="M6 2.5 V13.5"/>',
  folder:     '<path d="M2 4.5 C2 3.7 2.6 3 3.4 3 H6.2 L7.6 4.6 H12.6 C13.4 4.6 14 5.3 14 6.1 V11.6 C14 12.4 13.4 13 12.6 13 H3.4 C2.6 13 2 12.4 2 11.6 Z"/>',
  file:       '<path d="M4 2 H9.5 L12.5 5 V14 H4 Z"/><path d="M9.5 2 V5 H12.5"/>',
  image:      '<rect x="2" y="3" width="12" height="10" rx="1.5"/><circle cx="5.8" cy="6.5" r="1.2"/><path d="M2.5 12 L6.5 8.5 L9 10.5 L11 9 L13.5 11.5"/>',
  chat:       '<path d="M2.5 4 C2.5 3.2 3.2 2.5 4 2.5 H12 C12.8 2.5 13.5 3.2 13.5 4 V9.5 C13.5 10.3 12.8 11 12 11 H7 L4 13.5 V11 H4 C3.2 11 2.5 10.3 2.5 9.5 Z"/>',
  stop:       '<rect x="4" y="4" width="8" height="8" rx="1.5"/>',
  pause:      '<path d="M5.5 3.5 V12.5 M10.5 3.5 V12.5"/>',
  send:       '<path d="M2.5 8 L13.5 2.5 L10 13.5 L7.5 8.5 Z M7.5 8.5 L13.5 2.5"/>',
  play:       '<path d="M5 3 L12.5 8 L5 13 Z"/>',
  server:     '<rect x="2.5" y="2.5" width="11" height="4.5" rx="1.2"/><rect x="2.5" y="9" width="11" height="4.5" rx="1.2"/><path d="M5 4.75 H5.1 M5 11.25 H5.1"/>',
  key:        '<circle cx="5.5" cy="10.5" r="2.8"/><path d="M7.5 8.5 L13 3 M11 5 L12.8 6.8 M9.6 6.4 L11 7.8"/>',
  link:       '<path d="M6.8 9.2 A2.6 2.6 0 0 0 10.5 9.2 L12.6 7.1 A2.6 2.6 0 0 0 8.9 3.4 L8 4.3"/><path d="M9.2 6.8 A2.6 2.6 0 0 0 5.5 6.8 L3.4 8.9 A2.6 2.6 0 0 0 7.1 12.6 L8 11.7"/>',
  eye:        '<path d="M1.8 8 C3.3 5 5.4 3.5 8 3.5 C10.6 3.5 12.7 5 14.2 8 C12.7 11 10.6 12.5 8 12.5 C5.4 12.5 3.3 11 1.8 8 Z"/><circle cx="8" cy="8" r="2"/>',
  info:       '<circle cx="8" cy="8" r="5.8"/><path d="M8 7.2 V11 M8 5 V5.1"/>',
  clock:      '<circle cx="8" cy="8" r="5.8"/><path d="M8 4.8 V8 L10.2 9.4"/>',
  sun:        '<circle cx="8" cy="8" r="2.6"/><path d="M8 1.8 V3 M8 13 V14.2 M1.8 8 H3 M13 8 H14.2 M3.6 3.6 L4.5 4.5 M11.5 11.5 L12.4 12.4 M3.6 12.4 L4.5 11.5 M11.5 4.5 L12.4 3.6"/>',
  moon:       '<path d="M12.8 9.6 A5.2 5.2 0 0 1 6.4 3.2 A5.2 5.2 0 1 0 12.8 9.6 Z"/>',
  zap:        '<path d="M9 1.8 L3.5 9 H8 L7 14.2 L12.5 7 H8 Z"/>',
  database:   '<ellipse cx="8" cy="3.8" rx="5" ry="1.8"/><path d="M3 3.8 V12.2 C3 13.2 5.2 14 8 14 C10.8 14 13 13.2 13 12.2 V3.8 M3 8 C3 9 5.2 9.8 8 9.8 C10.8 9.8 13 9 13 8"/>',
  filter:     '<path d="M2.5 3.5 H13.5 L9.3 8.6 V12.8 L6.7 11.6 V8.6 Z"/>',
  calendar:   '<rect x="2.5" y="3.5" width="11" height="10" rx="1.5"/><path d="M2.5 6.8 H13.5 M5.5 2 V4.5 M10.5 2 V4.5"/>',
  chevronRight: '<path d="M6 3 L11 8 L6 13"/>',
  lock:       '<rect x="3.5" y="7" width="9" height="6.5" rx="1.3"/><path d="M5.5 7 V5 A2.5 2.5 0 0 1 10.5 5 V7"/>',
  reader:     '<path d="M2 3.5 C3.8 3 5.9 3.2 8 4.5 C10.1 3.2 12.2 3 14 3.5 V12.5 C12.2 12 10.1 12.2 8 13.5 C5.9 12.2 3.8 12 2 12.5 Z"/><path d="M8 4.5 V13.5"/>',
};

function ensureSpriteInstalled() {
  if (typeof document === 'undefined') return;
  if (document.getElementById(SPRITE_ID)) return;

  const svgNS = 'http://www.w3.org/2000/svg';
  const sprite = document.createElementNS(svgNS, 'svg');
  sprite.id = SPRITE_ID;
  sprite.setAttribute('aria-hidden', 'true');
  sprite.setAttribute('style', 'position:absolute;width:0;height:0;overflow:hidden');

  for (const [name, inner] of Object.entries(ICON_PATHS)) {
    const symbol = document.createElementNS(svgNS, 'symbol');
    symbol.setAttribute('id', `icon-${name}`);
    symbol.setAttribute('viewBox', '0 0 16 16');
    symbol.setAttribute('fill', 'none');
    symbol.setAttribute('stroke', 'currentColor');
    symbol.setAttribute('stroke-width', '1.5');
    symbol.setAttribute('stroke-linecap', 'round');
    symbol.setAttribute('stroke-linejoin', 'round');
    symbol.innerHTML = inner;
    sprite.appendChild(symbol);
  }

  if (document.body) {
    document.body.insertBefore(sprite, document.body.firstChild);
  } else {
    document.addEventListener('DOMContentLoaded', () => {
      if (!document.getElementById(SPRITE_ID) && document.body) {
        document.body.insertBefore(sprite, document.body.firstChild);
      }
    }, { once: true });
  }
}

/**
 * Create an SVG icon element.
 * @param {string} name - icon name from ICON_PATHS
 * @param {{size?: number|string, label?: string, className?: string}} [opts] - size accepts a pixel number or any CSS length string (default: `var(--icon-size, 16px)`)
 * @returns {SVGSVGElement}
 */
function icon(name, opts = {}) {
  ensureSpriteInstalled();

  const svgNS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(svgNS, 'svg');
  const size = opts.size || 'var(--icon-size, 16px)';
  svg.setAttribute('width', typeof size === 'number' ? String(size) : '1em');
  svg.setAttribute('height', typeof size === 'number' ? String(size) : '1em');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('fill', 'none');
  svg.classList.add('icon', `icon-${name}`);
  if (opts.className) svg.classList.add(...opts.className.split(' ').filter(Boolean));

  if (opts.label) {
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', opts.label);
  } else {
    svg.setAttribute('aria-hidden', 'true');
  }

  if (typeof size !== 'number') {
    svg.style.width = size;
    svg.style.height = size;
  }

  const use = document.createElementNS(svgNS, 'use');
  use.setAttribute('href', `#icon-${name}`);
  svg.appendChild(use);

  return svg;
}

/**
 * Returns an HTML string for an icon — useful for innerHTML templates.
 * @param {string} name - icon name from ICON_PATHS
 * @param {{size?: number|string, label?: string, className?: string}} [opts] - size in pixels (number) or any CSS length string
 * @returns {string}
 */
function iconHTML(name, opts = {}) {
  const sizeAttr = opts.size
    ? `width="${opts.size}" height="${opts.size}"`
    : 'width="1em" height="1em"';
  const ariaAttr = opts.label
    ? `role="img" aria-label="${escapeAttr(opts.label)}"`
    : 'aria-hidden="true"';
  const classAttr = `class="icon icon-${name}${opts.className ? ' ' + opts.className : ''}"`;
  return `<svg ${classAttr} ${sizeAttr} ${ariaAttr} viewBox="0 0 16 16" fill="none"><use href="#icon-${name}"/></svg>`;
}

function escapeAttr(s) {
  return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

module.exports = { icon, iconHTML, ensureSpriteInstalled };
