const { ipcRenderer } = require('electron');
// Page annotation mode, driven by the host through ic-annotate:* messages.
require('./preload/annotate').install(ipcRenderer, typeof window === 'undefined' ? null : window);
// Saved-password capture on login submits and fill on request from main.
require('./preload/passwords').install(ipcRenderer, typeof window === 'undefined' ? null : window);

// ================================================================
// Web Notifications shim — intercept window.Notification and
// ServiceWorkerRegistration.prototype.showNotification so every
// notification a site shows is routed to the main-process inbox
// instead of the OS notification center. Permission state is cached
// per-origin from PermissionService; override changes invalidate it.
// ================================================================
(function installNotificationShim() {
  if (typeof window === 'undefined') return;
  if (window.__icNotificationShimInstalled) return;
  window.__icNotificationShimInstalled = true;

  const MAX_ICON_BYTES = 256 * 1024;
  let cachedPermission = 'default';
  const liveById = new Map();
  let _localIdCounter = 0;
  function nextLocalId() {
    _localIdCounter += 1;
    return 'local-' + Date.now().toString(36) + '-' + _localIdCounter.toString(36);
  }

  function currentOrigin() {
    try {
      const o = window.location && window.location.origin;
      return (o && o !== 'null') ? o : '';
    } catch (_) { return ''; }
  }

  function decisionToPermission(d) {
    if (d === 'allow') return 'granted';
    if (d === 'deny') return 'denied';
    return 'default';
  }

  function cloneForIpc(value) {
    if (value === undefined || value === null) return null;
    try { return JSON.parse(JSON.stringify(value)); } catch (_) { return null; }
  }

  async function resolveIconToDataUrl(src) {
    if (!src || typeof src !== 'string') return null;
    if (src.startsWith('data:')) {
      return src.length < MAX_ICON_BYTES * 2 ? src : null;
    }
    if (src.startsWith('blob:')) {
      try {
        const res = await fetch(src);
        const blob = await res.blob();
        if (blob.size > MAX_ICON_BYTES) return null;
        return await new Promise((resolve) => {
          const fr = new FileReader();
          fr.onload = () => resolve(fr.result);
          fr.onerror = () => resolve(null);
          fr.readAsDataURL(blob);
        });
      } catch (_) { return null; }
    }
    return null;
  }

  // Seed cached permission on load.
  try {
    ipcRenderer.invoke('permission:check', currentOrigin(), 'notifications').then((d) => {
      cachedPermission = decisionToPermission(d);
    }).catch((err) => console.error('[preload] permission:check(notifications) failed:', (err instanceof Error && err.message) || err));
  } catch (_) { /* ignore */ }

  // Keep the cached permission in sync when the user changes the override.
  try {
    ipcRenderer.on('permission:changed', (_e, payload) => {
      if (!payload || payload.permission !== 'notifications') return;
      const origin = currentOrigin();
      if (payload.origin !== '*' && payload.origin !== origin) return;
      cachedPermission = decisionToPermission(payload.decision);
    });
  } catch (_) { /* ignore */ }

  class ShimNotification extends EventTarget {
    constructor(title, options) {
      super();
      if (title === undefined) throw new TypeError('Failed to construct \'Notification\': 1 argument required, but only 0 present.');
      const opts = options || {};
      this.title = String(title);
      this.body = opts.body || '';
      this.icon = opts.icon || '';
      this.image = opts.image || '';
      this.badge = opts.badge || '';
      this.tag = opts.tag || '';
      this.data = (opts.data !== undefined) ? opts.data : null;
      this.dir = opts.dir || 'auto';
      this.lang = opts.lang || '';
      this.renotify = !!opts.renotify;
      this.requireInteraction = !!opts.requireInteraction;
      this.silent = !!opts.silent;
      this.timestamp = opts.timestamp != null ? opts.timestamp : Date.now();
      this.actions = Array.isArray(opts.actions) ? opts.actions.slice(0, 4) : [];
      this.vibrate = Array.isArray(opts.vibrate) ? opts.vibrate.slice() : [];
      this._id = nextLocalId();
      this._closed = false;
      this._onclick = null;
      this._onshow = null;
      this._onerror = null;
      this._onclose = null;
      liveById.set(this._id, this);

      const sendShow = async () => {
        let iconDataUrl = null;
        let iconUrl = null;
        const src = this.icon;
        if (typeof src === 'string' && src) {
          if (src.startsWith('http:') || src.startsWith('https:')) iconUrl = src;
          else if (src.startsWith('data:') || src.startsWith('blob:')) iconDataUrl = await resolveIconToDataUrl(src);
        }
        try {
          ipcRenderer.send('notification:show', {
            origin: currentOrigin(),
            localId: this._id,
            title: this.title,
            body: this.body,
            iconDataUrl,
            iconUrl,
            tag: this.tag,
            data: cloneForIpc(this.data),
            requireInteraction: this.requireInteraction,
            silent: this.silent,
            actions: this.actions.map((a) => ({
              action: a && a.action ? String(a.action) : '',
              title: a && a.title ? String(a.title) : '',
              icon: a && a.icon ? String(a.icon) : '',
            })),
          });
        } catch (_) { /* ignore */ }
        queueMicrotask(() => this._fire('show'));
      };
      sendShow();
    }

    close() {
      if (this._closed) return;
      this._closed = true;
      liveById.delete(this._id);
      this._fire('close');
    }

    _fire(type) {
      try { this.dispatchEvent(new Event(type)); } catch (err) { console.error(`[preload] Notification ${type} listener threw:`, (err instanceof Error && err.message) || err); }
      const handler = this['_on' + type];
      if (typeof handler === 'function') { try { handler.call(this, new Event(type)); } catch (err) { console.error(`[preload] Notification on${type} handler threw:`, (err instanceof Error && err.message) || err); } }
    }

    get onclick() { return this._onclick; }
    set onclick(fn) { this._onclick = typeof fn === 'function' ? fn : null; }
    get onshow() { return this._onshow; }
    set onshow(fn) { this._onshow = typeof fn === 'function' ? fn : null; }
    get onerror() { return this._onerror; }
    set onerror(fn) { this._onerror = typeof fn === 'function' ? fn : null; }
    get onclose() { return this._onclose; }
    set onclose(fn) { this._onclose = typeof fn === 'function' ? fn : null; }
  }

  Object.defineProperty(ShimNotification, 'permission', {
    get: () => cachedPermission,
    configurable: true,
  });
  ShimNotification.maxActions = 4;
  ShimNotification.requestPermission = function requestPermission(cb) {
    const origin = currentOrigin();
    const p = ipcRenderer.invoke('permission:request', origin, 'notifications')
      .then((result) => {
        cachedPermission = result === 'granted' ? 'granted' : 'denied';
        if (typeof cb === 'function') { try { cb(cachedPermission); } catch (err) { console.error('[preload] requestPermission callback threw:', (err instanceof Error && err.message) || err); } }
        return cachedPermission;
      })
      .catch(() => {
        if (typeof cb === 'function') { try { cb('denied'); } catch (err) { console.error('[preload] requestPermission callback threw:', (err instanceof Error && err.message) || err); } }
        return 'denied';
      });
    return p;
  };

  try { window.Notification = /** @type {any} */ (ShimNotification); } catch (_) { /* ignore */ }

  // Dispatch click on the live Notification instance when the user activates
  // the inbox entry. We match by the localId we generated on send.
  try {
    ipcRenderer.on('notification:activate', (_e, localId) => {
      const notif = liveById.get(localId);
      if (!notif) return;
      try { notif._fire('click'); } catch (_) { /* ignore */ }
    });
  } catch (_) { /* ignore */ }

  // Patch ServiceWorkerRegistration.prototype.showNotification so PWAs like
  // Slack/Gmail route through the same pipeline — the default implementation
  // would fire an OS banner, which we're suppressing on purpose.
  if (typeof ServiceWorkerRegistration !== 'undefined'
    && ServiceWorkerRegistration.prototype
    && typeof ServiceWorkerRegistration.prototype.showNotification === 'function') {
    ServiceWorkerRegistration.prototype.showNotification = async function (title, options) {
      const opts = options || {};
      try {
        let iconDataUrl = null;
        let iconUrl = null;
        const src = opts.icon;
        if (typeof src === 'string' && src) {
          if (src.startsWith('http:') || src.startsWith('https:')) iconUrl = src;
          else if (src.startsWith('data:') || src.startsWith('blob:')) iconDataUrl = await resolveIconToDataUrl(src);
        }
        ipcRenderer.send('notification:show', {
          origin: currentOrigin(),
          title: String(title != null ? title : ''),
          body: opts.body || '',
          iconDataUrl,
          iconUrl,
          tag: opts.tag || '',
          data: cloneForIpc(opts.data),
          requireInteraction: !!opts.requireInteraction,
          silent: !!opts.silent,
          actions: Array.isArray(opts.actions) ? opts.actions.slice(0, 4).map((a) => ({
            action: a && a.action ? String(a.action) : '',
            title: a && a.title ? String(a.title) : '',
            icon: a && a.icon ? String(a.icon) : '',
          })) : [],
        });
      } catch (_) { /* ignore */ }
      return Promise.resolve();
    };
  }
})();

// ================================================================
// Badging API shim — `navigator.setAppBadge(n)` /
// `navigator.clearAppBadge()`. Forwards to main so BadgeService can
// aggregate per-origin counts and update the dock/taskbar.
// ================================================================
(function installBadgingShim() {
  if (typeof navigator === 'undefined') return;
  const nav = /** @type {any} */ (navigator);
  if (nav.__icBadgingShimInstalled) return;
  nav.__icBadgingShimInstalled = true;
  function currentOrigin() {
    try {
      const o = window.location && window.location.origin;
      return (o && o !== 'null') ? o : '';
    } catch (_) { return ''; }
  }
  navigator.setAppBadge = function setAppBadge(count) {
    try {
      const n = Math.max(0, Math.floor(Number(count) || 0));
      ipcRenderer.send('badge:set', { origin: currentOrigin(), count: n });
    } catch (_) { /* ignore */ }
    return Promise.resolve();
  };
  navigator.clearAppBadge = function clearAppBadge() {
    try { ipcRenderer.send('badge:clear', { origin: currentOrigin() }); }
    catch (_) { /* ignore */ }
    return Promise.resolve();
  };
})();

window.addEventListener('DOMContentLoaded', () => {
  const replaceText = (selector, text) => {
    const element = document.getElementById(selector);
    if (element) element.innerText = text;
  };

  for (const type of ['chrome', 'node', 'electron']) {
    replaceText(`${type}-version`, process.versions[type]);
  }
});

// Swipe/mouse-button navigation and the host keys; the shell installs the same.
require('../shared/hostInput').install(ipcRenderer.send.bind(ipcRenderer), window);
