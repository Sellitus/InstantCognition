// jsdom marks every dispatched event untrusted and isTrusted cannot be
// redefined, while host-input listeners ignore untrusted events. This records
// the listeners added to a target and calls them with the real event wrapped
// so it reports isTrusted: true; preventDefault and defaultPrevented still act
// on the real event.

/** @param {EventTarget} target */
function recordListeners(target) {
  /** @type {Array<{ type: string, listener: any }>} */
  const recorded = [];
  const original = target.addEventListener;
  target.addEventListener = function addEventListener(type, listener, options) {
    recorded.push({ type, listener });
    return original.call(this, type, listener, options);
  };
  return {
    /** @template {Event} E @param {E} event @returns {E} */
    fire(event) {
      const trusted = new Proxy(event, {
        get(real, prop) {
          if (prop === 'isTrusted') return true;
          const value = Reflect.get(real, prop, real);
          return typeof value === 'function' ? value.bind(real) : value;
        },
      });
      for (const { type, listener } of recorded) {
        if (type !== event.type) continue;
        if (typeof listener === 'function') listener.call(target, trusted);
        else listener.handleEvent(trusted);
      }
      return event;
    },
    restore() { target.addEventListener = original; },
  };
}

module.exports = { recordListeners };
