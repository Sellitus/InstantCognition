// Colour helpers shared by the ambient scenes. A palette is { colors: [[r,g,b], …] }
// that the ambient controller refreshes in place when the theme or accent
// changes, so scenes hold palette indices rather than resolved colours.

const TAU = Math.PI * 2;

function pick(palette, i) {
  const list = palette.colors;
  return list[((i % list.length) + list.length) % list.length];
}

// rgba() string for `rgb` lifted toward white by `lift` (0..1).
function rgba(rgb, a, lift = 0) {
  const ch = (c) => Math.round(c + (255 - c) * lift);
  const alpha = Math.max(0, Math.min(1, a));
  return `rgba(${ch(rgb[0])}, ${ch(rgb[1])}, ${ch(rgb[2])}, ${alpha.toFixed(3)})`;
}

function between(rng, lo, hi) { return lo + rng() * (hi - lo); }

function sign(rng) { return rng() < 0.5 ? -1 : 1; }

module.exports = { TAU, pick, rgba, between, sign };
