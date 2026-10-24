// NotificationService.js — In-app inbox for Web Notifications intercepted from
// webview preloads. FIFO-capped, tag-dedup per origin (Web Notifications spec:
// same-origin + same-tag replaces the prior one). Persists to
// `state.notifications.inbox` via ConfigService. Ephemeral private-session
// entries are surfaced via events but NOT persisted.
//
// Events:
//   'added'         ({record, unreadCount})        after a notification is stored
//   'replaced'      ({record, previousId, unreadCount})  when tag collision replaced an entry
//   'dismissed'     ({id, unreadCount})            after dismiss()
//   'cleared'       ({unreadCount:0})              after clearAll()
//   'read-changed'  ({id?, unreadCount})           after markRead / markAllRead

const { EventEmitter } = require('events');
const iconCache = require('../utils/iconCache');

const DEFAULT_CAP = 200;
const INBOX_PATH = 'state.notifications.inbox';

let _counter = 0;
function nextId() {
  _counter += 1;
  return 'notif-' + Date.now().toString(36) + '-' + _counter.toString(36);
}

class NotificationService extends EventEmitter {
  constructor() {
    super();
    this._configService = null;
    this._inbox = []; // newest first
    this._tabMap = new Map(); // notificationId -> webContentsId
    this._cap = DEFAULT_CAP;
    this._persistTimer = null;
  }

  initialize(configService) {
    this._configService = configService || null;
    if (!this._configService) return;
    const cap = this._configService.get('settings.notifications.maxInbox', DEFAULT_CAP);
    if (Number.isInteger(cap) && cap > 0) this._cap = cap;
    const persisted = this._configService.get(INBOX_PATH, []);
    if (Array.isArray(persisted)) {
      this._inbox = persisted
        .filter((r) => r && typeof r === 'object' && typeof r.id === 'string')
        .slice(0, this._cap);
    }
    // GC any orphaned icon files on startup
    try { iconCache.gc(this._inbox); } catch (_) { /* ignore */ }
  }

  // Incoming notification from a webview preload shim.
  // record: {origin, title, body, iconDataUrl?, iconUrl?, tag, data, requireInteraction,
  //          silent, actions, webContentsId, ephemeral, localId?}
  add(input) {
    const origin = typeof input.origin === 'string' ? input.origin : '';
    const tag = typeof input.tag === 'string' ? input.tag : '';

    // Resolve icon: prefer data URL (caller resolved blob/http -> base64),
    // fall back to a safe remote URL, else null.
    let iconPath = null;
    if (typeof input.iconDataUrl === 'string' && input.iconDataUrl.startsWith('data:')) {
      iconPath = iconCache.storeDataUrl(input.iconDataUrl);
    } else if (typeof input.iconUrl === 'string'
      && (input.iconUrl.startsWith('http://') || input.iconUrl.startsWith('https://'))) {
      iconPath = input.iconUrl;
    }

    const record = {
      id: nextId(),
      // The webview-generated id the live Notification instance is keyed by;
      // activation must route back to the preload under this id, not `id`.
      localId: typeof input.localId === 'string' ? input.localId : null,
      origin,
      title: typeof input.title === 'string' ? input.title : '',
      body: typeof input.body === 'string' ? input.body : '',
      iconPath,
      tag,
      data: (input.data !== undefined) ? input.data : null,
      requireInteraction: !!input.requireInteraction,
      silent: !!input.silent,
      actions: Array.isArray(input.actions) ? input.actions.slice(0, 4) : [],
      timestamp: Date.now(),
      read: false,
      ephemeral: !!input.ephemeral,
    };

    let previousId = null;
    // Tag dedup: same origin + same non-empty tag replaces existing entry.
    if (origin && tag) {
      const existingIdx = this._inbox.findIndex((r) => r.origin === origin && r.tag === tag);
      if (existingIdx >= 0) {
        previousId = this._inbox[existingIdx].id;
        this._inbox.splice(existingIdx, 1);
        this._tabMap.delete(previousId);
      }
    }

    this._inbox.unshift(record);
    while (this._inbox.length > this._cap) {
      const evicted = this._inbox.pop();
      if (evicted) this._tabMap.delete(evicted.id);
    }

    if (input.webContentsId != null) {
      this._tabMap.set(record.id, input.webContentsId);
    }

    this._schedulePersist();

    const unreadCount = this.unreadCount();
    if (previousId) {
      this.emit('replaced', { record, previousId, unreadCount });
    } else {
      this.emit('added', { record, unreadCount });
    }
    return record;
  }

  dismiss(id) {
    const idx = this._inbox.findIndex((r) => r.id === id);
    if (idx < 0) return false;
    this._inbox.splice(idx, 1);
    this._tabMap.delete(id);
    this._schedulePersist();
    this.emit('dismissed', { id, unreadCount: this.unreadCount() });
    return true;
  }

  clearAll() {
    const ids = this._inbox.map((r) => r.id);
    this._inbox = [];
    for (const id of ids) this._tabMap.delete(id);
    this._schedulePersist();
    try { iconCache.clearAll(); } catch (_) { /* ignore */ }
    this.emit('cleared', { unreadCount: 0 });
    return ids.length;
  }

  markRead(id) {
    const rec = this._inbox.find((r) => r.id === id);
    if (!rec || rec.read) return false;
    rec.read = true;
    this._schedulePersist();
    this.emit('read-changed', { id, unreadCount: this.unreadCount() });
    return true;
  }

  markAllRead() {
    let changed = false;
    for (const rec of this._inbox) {
      if (!rec.read) { rec.read = true; changed = true; }
    }
    if (!changed) return 0;
    this._schedulePersist();
    const unreadCount = 0;
    this.emit('read-changed', { unreadCount });
    return this._inbox.length;
  }

  list(opts = {}) {
    const { includeRead = true, origin = null } = opts;
    return this._inbox.filter((r) => {
      if (!includeRead && r.read) return false;
      if (origin && r.origin !== origin) return false;
      return true;
    }).map((r) => ({ ...r }));
  }

  unreadCount() {
    let n = 0;
    for (const r of this._inbox) if (!r.read) n++;
    return n;
  }

  getWebContentsIdFor(id) {
    return this._tabMap.get(id) || null;
  }

  // Persist a lean snapshot (drop ephemeral entries, omit transient tabMap).
  _schedulePersist() {
    if (!this._configService) return;
    if (this._persistTimer) return;
    this._persistTimer = setTimeout(() => {
      this._persistTimer = null;
      try {
        const snapshot = this._inbox
          .filter((r) => !r.ephemeral)
          .map((r) => {
            const { ...rest } = r;
            return rest;
          });
        this._configService.set(INBOX_PATH, snapshot);
      } catch (err) {
        console.error('[NotificationService] persist failed:', err);
      }
    }, 200);
    if (this._persistTimer && typeof this._persistTimer.unref === 'function') {
      this._persistTimer.unref();
    }
  }

  // Test seam — allow tests to force a synchronous flush.
  _flush() {
    if (this._persistTimer) {
      clearTimeout(this._persistTimer);
      this._persistTimer = null;
    }
    if (!this._configService) return;
    const snapshot = this._inbox.filter((r) => !r.ephemeral).map((r) => ({ ...r }));
    this._configService.set(INBOX_PATH, snapshot);
  }
}

module.exports = new NotificationService();
