// accentColor — derive the full set of --accent-* theme custom properties from
// a single user-chosen hex color. Pure (no DOM) so it is unit-testable; the
// renderer applies the returned map as inline styles on <body>.
//
// The theme defines seven accent tokens (see styles/themes + base/tokens.css):
// --accent, --accent-hover, --accent-active, --accent-subtle, --accent-muted,
// --accent-on, and --accent-rgb (bare channels for rgba() washes). We derive hover/active by darkening, subtle/muted as low-alpha
// fills, and pick a readable on-color from the accent's luminance.

const ACCENT_KEYS = ['--accent', '--accent-hover', '--accent-active', '--accent-subtle', '--accent-muted', '--accent-on', '--accent-rgb'];

function parseHexColor(hex) {
  const m = /^#?([0-9a-fA-F]{6})$/.exec(String(hex == null ? '' : hex).trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

// Mix toward black by `amt` (0..1) — used for hover/active shades.
function darken(rgb, amt) {
  return {
    r: Math.round(rgb.r * (1 - amt)),
    g: Math.round(rgb.g * (1 - amt)),
    b: Math.round(rgb.b * (1 - amt)),
  };
}

const rgbStr = ({ r, g, b }) => `rgb(${r}, ${g}, ${b})`;
const rgbaStr = ({ r, g, b }, a) => `rgba(${r}, ${g}, ${b}, ${a})`;

// Perceived luminance (0..1) via the Rec. 601 coefficients.
function luminance({ r, g, b }) {
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255;
}

// Returns the inline-style map for a valid hex accent, or null when the input
// is empty/invalid (caller should then clear the overrides to fall back to the
// theme default).
function deriveAccentVars(hex) {
  const rgb = parseHexColor(hex);
  if (!rgb) return null;
  return {
    '--accent': rgbStr(rgb),
    '--accent-hover': rgbStr(darken(rgb, 0.15)),
    '--accent-active': rgbStr(darken(rgb, 0.30)),
    '--accent-subtle': rgbaStr(rgb, 0.13),
    '--accent-muted': rgbaStr(rgb, 0.07),
    '--accent-on': luminance(rgb) > 0.6 ? '#1a1c20' : '#ffffff',
    '--accent-rgb': `${rgb.r}, ${rgb.g}, ${rgb.b}`,
  };
}

module.exports = { deriveAccentVars, parseHexColor, ACCENT_KEYS };
