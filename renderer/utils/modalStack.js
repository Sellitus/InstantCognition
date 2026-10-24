/**
 * modalStack — ordered registry of the open modal layers.
 *
 * Escape belongs to the topmost layer only. Every modal in this app listens for
 * keydown on `document` in the capture phase, and capture-phase listeners on the
 * same target all run in registration order, so without this a confirm opened
 * over Settings resolves the confirm AND closes Settings behind it — and the
 * older listener (Settings) even runs first, so stopPropagation from the newer
 * one cannot prevent it.
 *
 * Usage:
 *   const layer = modalStack.push();   // opaque token
 *   ...
 *   if (!modalStack.isTop(layer)) return;   // inside the Escape handler
 *   ...
 *   modalStack.pop(layer);             // on close, in any order
 */

const stack = [];

/** Register a newly opened layer. Returns the token to pass back to pop/isTop. */
function push() {
  const token = Symbol('modal-layer');
  stack.push(token);
  return token;
}

/** Remove a layer. Safe to call twice, and safe out of order. */
function pop(token) {
  const i = stack.lastIndexOf(token);
  if (i !== -1) stack.splice(i, 1);
}

/** True when `token` is the frontmost open layer — i.e. it owns Escape. */
function isTop(token) {
  return stack.length > 0 && stack[stack.length - 1] === token;
}

/** Number of open layers. */
function depth() {
  return stack.length;
}

module.exports = { push, pop, isTop, depth };
