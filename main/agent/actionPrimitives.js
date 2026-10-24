// actionPrimitives — produces JS source strings for individual agent actions
// (click, type, scroll, waitFor, extractText, fillForm). Each builder returns
// a self-contained IIFE that runs in the page context via webContents.executeJavaScript.
//
// The pattern follows the existing broadcast feature in renderer.js which
// already injects scripts into webviews to set input values and dispatch events.

function jsString(s) {
  return JSON.stringify(String(s == null ? '' : s));
}

function buildClickScript(selector) {
  return `
(function () {
  var el = document.querySelector(${jsString(selector)});
  if (!el) return { ok: false, error: 'not_found' };
  if (typeof el.scrollIntoView === 'function') el.scrollIntoView({ block: 'center', inline: 'center' });
  try { el.click(); return { ok: true }; }
  catch (err) { return { ok: false, error: String(err && err.message || err) }; }
})();`;
}

function buildTypeScript(selector, text) {
  // Mirrors broadcast feature: focus, set value, dispatch input event for React/Vue
  return `
(function () {
  var el = document.querySelector(${jsString(selector)});
  if (!el) return { ok: false, error: 'not_found' };
  try {
    el.focus();
    var text = ${jsString(text)};
    if ('value' in el) {
      var setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value') ||
                   Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value');
      if (setter && setter.set) { setter.set.call(el, text); }
      else { el.value = text; }
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    } else if (el.isContentEditable) {
      document.execCommand('insertText', false, text);
    } else {
      return { ok: false, error: 'unsupported_element' };
    }
    return { ok: true };
  } catch (err) { return { ok: false, error: String(err && err.message || err) }; }
})();`;
}

function buildScrollScript(direction, amount) {
  var dy = 0, dx = 0;
  if (direction === 'down') dy = amount;
  else if (direction === 'up') dy = -amount;
  else if (direction === 'right') dx = amount;
  else if (direction === 'left') dx = -amount;
  return `
(function () {
  try { window.scrollBy(${dx}, ${dy}); return { ok: true, scrollY: window.scrollY }; }
  catch (err) { return { ok: false, error: String(err && err.message || err) }; }
})();`;
}

function buildWaitForScript(selector, timeoutMs) {
  // Polling-based; the script returns a promise that resolves when found.
  // executeJavaScript supports promises.
  return `
(function () {
  return new Promise(function (resolve) {
    var deadline = Date.now() + ${Number(timeoutMs) || 5000};
    function tick() {
      var el = document.querySelector(${jsString(selector)});
      if (el) return resolve({ ok: true });
      if (Date.now() >= deadline) return resolve({ ok: false, error: 'timeout' });
      setTimeout(tick, 100);
    }
    tick();
  });
})();`;
}

// A broad selector ('body', 'pre') on a JSON or feed URL yields the whole
// document. Capping in the page keeps it out of the conversation, and the
// truncated flag tells the model to narrow the selector rather than assume it
// saw everything.
function buildExtractTextScript(selector, maxChars) {
  const limit = Number(maxChars) > 0 ? Math.floor(Number(maxChars)) : 6000;
  return `
(function () {
  var els = document.querySelectorAll(${jsString(selector)});
  if (!els.length) return { ok: false, error: 'not_found' };
  var out = [];
  for (var i = 0; i < els.length; i++) {
    var t = els[i].innerText || els[i].textContent || '';
    out.push(t.replace(/\\s+/g, ' ').trim());
  }
  var text = out.join('\\n');
  var limit = ${limit};
  if (text.length <= limit) return { ok: true, text: text, matched: els.length };
  return { ok: true, text: text.slice(0, limit), matched: els.length, truncated: true, totalChars: text.length };
})();`;
}

function buildFillFormScript(fields) {
  // fields = [{ selector, value }, ...]
  var serialized = JSON.stringify(fields || []);
  return `
(function () {
  var fields = ${serialized};
  var results = [];
  for (var i = 0; i < fields.length; i++) {
    var f = fields[i];
    var el = document.querySelector(f.selector);
    if (!el) { results.push({ selector: f.selector, ok: false, error: 'not_found' }); continue; }
    try {
      el.focus();
      if ('value' in el) {
        var setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value') ||
                     Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value');
        if (setter && setter.set) { setter.set.call(el, f.value); } else { el.value = f.value; }
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        results.push({ selector: f.selector, ok: true });
      } else { results.push({ selector: f.selector, ok: false, error: 'unsupported' }); }
    } catch (err) { results.push({ selector: f.selector, ok: false, error: String(err) }); }
  }
  return { ok: true, results: results };
})();`;
}

module.exports = {
  buildClickScript,
  buildTypeScript,
  buildScrollScript,
  buildWaitForScript,
  buildExtractTextScript,
  buildFillFormScript,
};
