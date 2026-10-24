/**
 * ConfirmDialog — reusable destructive-action confirmation.
 *
 * Usage:
 *   const ok = await confirm({
 *     title: 'Clear history?',
 *     message: 'This removes all browsing history. It can't be undone.',
 *     confirmLabel: 'Clear',
 *     confirmKind: 'danger',      // 'danger' | 'primary' (default)
 *   });
 *   if (ok) doTheThing();
 *
 * Returns a Promise<boolean> — `true` if confirmed, `false` on cancel / backdrop click / Escape.
 * Focus is trapped inside the dialog while open, restored on close.
 */

const { trap } = require('../utils/focusTrap');
const modalStack = require('../utils/modalStack');
const { escapeHtml } = require('../utils/html');
const { iconHTML } = require('./Icon');

function confirm(opts = {}) {
  return new Promise((resolve) => {
    if (typeof document === 'undefined' || !document.body) {
      resolve(false);
      return;
    }

    const title = opts.title || 'Are you sure?';
    const message = opts.message || '';
    const confirmLabel = opts.confirmLabel || 'Confirm';
    const cancelLabel = opts.cancelLabel || 'Cancel';
    const kind = opts.confirmKind === 'danger' ? 'danger' : 'primary';

    const overlay = document.createElement('div');
    overlay.className = 'confirm-dialog-overlay';
    overlay.innerHTML = ''
      + '<div class="confirm-dialog" role="alertdialog" aria-modal="true" aria-labelledby="confirm-dialog-title">'
      + '  <div class="confirm-dialog-header">'
      + `    <div class="confirm-dialog-title" id="confirm-dialog-title">${escapeHtml(title)}</div>`
      + `    <button type="button" class="confirm-dialog-close" aria-label="Close" title="Close">${iconHTML('close')}</button>`
      + '  </div>'
      + (message ? `  <div class="confirm-dialog-message">${escapeHtml(message)}</div>` : '')
      + '  <div class="confirm-dialog-actions">'
      + `    <button type="button" class="confirm-dialog-cancel">${escapeHtml(cancelLabel)}</button>`
      + `    <button type="button" class="confirm-dialog-confirm confirm-dialog-${kind}">${escapeHtml(confirmLabel)}</button>`
      + '  </div>'
      + '</div>';

    document.body.appendChild(overlay);

    let releaseTrap = null;
    let settled = false;
    const layer = modalStack.push();
    const dialog = overlay.querySelector('.confirm-dialog');
    const confirmBtn = overlay.querySelector('.confirm-dialog-confirm');
    const cancelBtn = overlay.querySelector('.confirm-dialog-cancel');
    const closeBtn = overlay.querySelector('.confirm-dialog-close');

    function finish(result) {
      if (settled) return;
      settled = true;
      modalStack.pop(layer);
      if (releaseTrap) { try { releaseTrap(); } catch (err) { console.warn('[confirm] focus trap release failed:', (err instanceof Error && err.message) || err); } }
      document.removeEventListener('keydown', onKey, true);
      overlay.classList.add('confirm-dialog-leaving');
      setTimeout(() => { if (overlay.parentNode) overlay.parentNode.removeChild(overlay); }, 150);
      resolve(!!result);
    }

    function onKey(e) {
      if (!modalStack.isTop(layer)) return;
      if (e.key === 'Escape') { e.preventDefault(); finish(false); }
      // Enter on Cancel or the close icon is left to the button's own click.
      if (e.key === 'Enter' && document.activeElement !== cancelBtn && document.activeElement !== closeBtn) { e.preventDefault(); finish(true); }
    }

    confirmBtn.addEventListener('click', () => finish(true));
    cancelBtn.addEventListener('click', () => finish(false));
    closeBtn.addEventListener('click', () => finish(false));
    overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) finish(false); });
    document.addEventListener('keydown', onKey, true);

    // Small delay so the trap targets the rendered DOM. The settled check is
    // load-bearing: a dialog closed before this tick would otherwise install a
    // trap nobody can release, leaving every body child inert and the window dead.
    setTimeout(() => { if (settled) return; releaseTrap = trap(dialog, { initialFocus: confirmBtn }); }, 0);
  });
}

module.exports = { confirm };
