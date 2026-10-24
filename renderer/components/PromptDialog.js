/**
 * PromptDialog — reusable single-line text-input modal, the prompt() counterpart
 * to ConfirmDialog.confirm. Replaces native window.prompt with a token-driven,
 * focus-trapped dialog that matches the rest of the app.
 *
 * Usage:
 *   const name = await prompt({
 *     title: 'New project',
 *     message: 'Give the project a name.',
 *     placeholder: 'Untitled',
 *     defaultValue: 'Untitled',
 *     confirmLabel: 'Create',
 *     confirmKind: 'primary',     // 'primary' (default) | 'danger'
 *     validate: (v) => v.trim() ? null : 'Name cannot be empty',
 *   });
 *   if (name == null) return;      // cancelled
 *
 * Returns Promise<string|null> — the trimmed value on confirm, null on cancel /
 * backdrop click / Escape. An invalid value keeps the dialog open with a hint;
 * only a valid submission (or cancellation) resolves.
 */

const { trap } = require('../utils/focusTrap');
const modalStack = require('../utils/modalStack');
const { escapeHtml } = require('../utils/html');
const { iconHTML } = require('./Icon');

function prompt(opts = {}) {
  return new Promise((resolve) => {
    if (typeof document === 'undefined' || !document.body) {
      resolve(null);
      return;
    }

    const title = opts.title || 'Enter a value';
    const message = opts.message || '';
    const placeholder = opts.placeholder || '';
    const defaultValue = opts.defaultValue != null ? String(opts.defaultValue) : '';
    const confirmLabel = opts.confirmLabel || 'OK';
    const cancelLabel = opts.cancelLabel || 'Cancel';
    const kind = opts.confirmKind === 'danger' ? 'danger' : 'primary';
    const validate = typeof opts.validate === 'function' ? opts.validate : null;

    const overlay = document.createElement('div');
    overlay.className = 'prompt-dialog-overlay';
    overlay.innerHTML = ''
      + '<div class="prompt-dialog" role="dialog" aria-modal="true" aria-labelledby="prompt-dialog-title">'
      + '  <div class="prompt-dialog-header">'
      + `    <div class="prompt-dialog-title" id="prompt-dialog-title">${escapeHtml(title)}</div>`
      + `    <button type="button" class="prompt-dialog-close" aria-label="Close" title="Close">${iconHTML('close')}</button>`
      + '  </div>'
      + (message ? `  <div class="prompt-dialog-message">${escapeHtml(message)}</div>` : '')
      + '  <input type="text" class="prompt-dialog-input" />'
      + '  <div class="prompt-dialog-hint" id="prompt-dialog-hint" role="alert" hidden></div>'
      + '  <div class="prompt-dialog-actions">'
      + `    <button type="button" class="prompt-dialog-cancel">${escapeHtml(cancelLabel)}</button>`
      + `    <button type="button" class="prompt-dialog-confirm prompt-dialog-${kind}">${escapeHtml(confirmLabel)}</button>`
      + '  </div>'
      + '</div>';

    document.body.appendChild(overlay);

    let releaseTrap = null;
    let settled = false;
    const layer = modalStack.push();
    const dialog = overlay.querySelector('.prompt-dialog');
    const input = /** @type {HTMLInputElement} */ (overlay.querySelector('.prompt-dialog-input'));
    const hintEl = /** @type {HTMLElement} */ (overlay.querySelector('.prompt-dialog-hint'));
    const confirmBtn = overlay.querySelector('.prompt-dialog-confirm');
    const cancelBtn = overlay.querySelector('.prompt-dialog-cancel');
    const closeBtn = overlay.querySelector('.prompt-dialog-close');

    input.value = defaultValue;
    input.placeholder = placeholder;
    input.setAttribute('aria-describedby', 'prompt-dialog-hint');

    function finish(result) {
      if (settled) return;
      settled = true;
      modalStack.pop(layer);
      if (releaseTrap) { try { releaseTrap(); } catch (err) { console.warn('[prompt] focus trap release failed:', (err instanceof Error && err.message) || err); } }
      document.removeEventListener('keydown', onKey, true);
      overlay.classList.add('prompt-dialog-leaving');
      setTimeout(() => { if (overlay.parentNode) overlay.parentNode.removeChild(overlay); }, 150);
      resolve(result);
    }

    function submit() {
      const value = input.value;
      if (validate) {
        const err = validate(value);
        if (err) {
          hintEl.textContent = err;
          hintEl.hidden = false;
          input.setAttribute('aria-invalid', 'true');
          return;
        }
      }
      finish(value.trim());
    }

    function onKey(e) {
      if (!modalStack.isTop(layer)) return;
      if (e.key === 'Escape') { e.preventDefault(); finish(null); }
      // Enter on Cancel or the close icon is left to the button's own click.
      else if (e.key === 'Enter' && document.activeElement !== cancelBtn && document.activeElement !== closeBtn) { e.preventDefault(); submit(); }
    }

    confirmBtn.addEventListener('click', submit);
    cancelBtn.addEventListener('click', () => finish(null));
    closeBtn.addEventListener('click', () => finish(null));
    overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) finish(null); });
    // Clear the validation hint as the user edits after a rejection.
    input.addEventListener('input', () => {
      if (!hintEl.hidden) { hintEl.hidden = true; input.removeAttribute('aria-invalid'); }
    });
    document.addEventListener('keydown', onKey, true);

    // The settled check is load-bearing: a dialog closed before this tick would
    // otherwise install a trap nobody can release, leaving every body child
    // inert and the window unclickable.
    setTimeout(() => {
      if (settled) return;
      releaseTrap = trap(dialog, { initialFocus: input });
      // Select the default value so a quick overwrite replaces it.
      input.select();
    }, 0);
  });
}

module.exports = { prompt };
