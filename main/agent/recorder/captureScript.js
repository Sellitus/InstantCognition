// captureScript — the in-page half of the action recorder. The recorder
// installs CAPTURE_SOURCE with Page.addScriptToEvaluateOnNewDocument (every
// future document) and Runtime.evaluate (the current one). It reports user
// actions through a CDP Runtime binding as JSON strings; main re-validates
// every payload, so nothing here is trusted.
//
// Sensitive field values are replaced with "[redacted]" before they leave
// the page. A field that was ever type=password stays sensitive after a
// show-password toggle flips it to text (tracked by a MutationObserver on
// `type`). Only trusted (user-generated) events in the top frame are
// recorded: synthetic events from page scripts and iframes (payment widgets
// included) are ignored.

const { describeElement, isSensitiveField } = require('./domDescribe');

const BINDING_NAME = '__icRecorderEmit';
const REDACTED = '[redacted]';

/* istanbul ignore next */
function installCapture(bindingName, describe, isSensitive, redacted, trustedOnly) {
  var w = /** @type {any} */ (window);
  if (w.top !== w) return;
  if (typeof w[bindingName] !== 'function' || w.__icRecorderUninstall) return;
  var send = w[bindingName];
  var MAX_VALUE = 500;
  var ACTIONABLE = 'a,button,input,select,textarea,label,summary,option,[role],[contenteditable="true"],[contenteditable=""]';
  var wasPassword = new WeakSet();
  var typeWatch = new w.MutationObserver(function (records) {
    for (var r = 0; r < records.length; r++) {
      if (String(records[r].oldValue || '').toLowerCase() === 'password') wasPassword.add(records[r].target);
    }
  });
  typeWatch.observe(w.document, { subtree: true, attributes: true, attributeFilter: ['type'], attributeOldValue: true });

  function hints(el) {
    return {
      type: el.getAttribute('type'), autocomplete: el.getAttribute('autocomplete'),
      name: el.getAttribute('name'), id: el.getAttribute('id'),
    };
  }
  function emit(ev) { send(JSON.stringify(ev)); }
  function ok(e) { return !trustedOnly || e.isTrusted; }
  function fieldValue(el, ev) {
    var h = hints(el);
    ev.field = { type: String(h.type || el.tagName).toLowerCase(), autocomplete: h.autocomplete, name: h.name, id: h.id };
    if (String(h.type || '').toLowerCase() === 'password') wasPassword.add(el);
    if (isSensitive(h) || wasPassword.has(el)) { ev.value = redacted; ev.redacted = true; return ev; }
    var v = el.isContentEditable ? el.innerText : el.value;
    ev.value = String(v == null ? '' : v).slice(0, MAX_VALUE);
    return ev;
  }
  function isTextField(el) {
    if (el.isContentEditable || el.tagName === 'TEXTAREA') return true;
    return el.tagName === 'INPUT' && !/^(checkbox|radio|button|submit|reset|image|file|hidden)$/i.test(el.getAttribute('type') || '');
  }
  function onClick(e) {
    if (!ok(e) || !e.target || e.target.nodeType !== 1) return;
    var el = e.target.closest(ACTIONABLE) || e.target;
    emit({ type: 'click', target: describe(el) });
  }
  function onInput(e) {
    var el = e.target;
    if (!ok(e) || !el || el.nodeType !== 1 || !isTextField(el)) return;
    emit(fieldValue(el, { type: 'input', target: describe(el) }));
  }
  function onChange(e) {
    var el = e.target;
    if (!ok(e) || !el || el.nodeType !== 1 || isTextField(el)) return;
    var type = (el.getAttribute('type') || '').toLowerCase();
    if (type === 'checkbox' || type === 'radio') {
      emit({ type: 'change', target: describe(el), field: { type: type }, checked: !!el.checked });
    } else if (el.tagName === 'SELECT') {
      emit(fieldValue(el, { type: 'change', target: describe(el) }));
    }
  }
  function onSubmit(e) {
    if (!ok(e) || !e.target || e.target.nodeType !== 1) return;
    emit({ type: 'submit', target: describe(e.target) });
  }
  function onKey(e) {
    if (!ok(e) || (e.key !== 'Enter' && e.key !== 'Escape')) return;
    var el = e.target && e.target.nodeType === 1 ? e.target : w.document.body;
    if (!el) return;
    emit({ type: 'key', key: e.key, target: describe(el) });
  }
  var listeners = [['click', onClick], ['input', onInput], ['change', onChange], ['submit', onSubmit], ['keydown', onKey]];
  for (var i = 0; i < listeners.length; i++) w.addEventListener(listeners[i][0], listeners[i][1], true);
  Object.defineProperty(w, '__icRecorderUninstall', {
    configurable: true,
    enumerable: false,
    value: function () {
      for (var j = 0; j < listeners.length; j++) w.removeEventListener(listeners[j][0], listeners[j][1], true);
      typeWatch.disconnect();
      delete w.__icRecorderUninstall;
    },
  });
}

/**
 * Page source for the capture script. trustedOnly=false exists for jsdom
 * tests, which cannot dispatch trusted events; the recorder always uses true.
 * @param {{ trustedOnly?: boolean }} [opts]
 */
function buildCaptureSource(opts) {
  const trustedOnly = !opts || opts.trustedOnly !== false;
  return `(${installCapture.toString()})(${JSON.stringify(BINDING_NAME)}, ${describeElement.toString()}, `
    + `${isSensitiveField.toString()}, ${JSON.stringify(REDACTED)}, ${trustedOnly});`;
}

const CAPTURE_SOURCE = buildCaptureSource();

const UNINSTALL_SOURCE = 'if (typeof window.__icRecorderUninstall === "function") window.__icRecorderUninstall();';

module.exports = { BINDING_NAME, REDACTED, CAPTURE_SOURCE, UNINSTALL_SOURCE, buildCaptureSource };
