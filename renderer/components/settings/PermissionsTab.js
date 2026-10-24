// PermissionsTab — lists per-origin permission overrides from PermissionService,
// lets the user revoke individual entries. Updates live via the
// `permission:changed` IPC event that notificationHandlers broadcasts.

const { ipcRenderer } = require('electron');
const { el } = require('./controls');
const { errMsg } = require('../../../shared/errMsg');

const PERMISSION_LABELS = {
  notifications: 'Notifications',
  geolocation: 'Location',
  media: 'Camera & Microphone',
  midi: 'MIDI',
  midiSysex: 'MIDI SysEx',
  'display-capture': 'Screen Sharing',
  'clipboard-read': 'Clipboard Read',
  'clipboard-sanitized-write': 'Clipboard Write',
  fullscreen: 'Fullscreen',
  pointerLock: 'Pointer Lock',
  'idle-detection': 'Idle Detection',
  'background-sync': 'Background Sync',
  hid: 'HID Devices',
  serial: 'Serial Devices',
  usb: 'USB Devices',
  mediaKeySystem: 'DRM / Media Keys',
  'window-management': 'Window Management',
  'persistent-storage': 'Persistent Storage',
  'storage-access': 'Storage Access',
  'top-level-storage-access': 'Top-Level Storage',
  'speaker-selection': 'Speaker Selection',
};

function labelFor(permission) {
  return PERMISSION_LABELS[permission] || permission;
}

function parseKey(key) {
  const idx = key.indexOf('|');
  if (idx < 0) return { origin: '*', permission: key };
  return { origin: key.slice(0, idx), permission: key.slice(idx + 1) };
}

class PermissionsTab {
  constructor() {
    this.container = null;
    this._onChange = this._refresh.bind(this);
    this._wired = false;
  }

  render(container) {
    this.container = container;
    container.innerHTML = '';
    container.append(
      el('p', { class: 'sv-section-intro' }, [
        'Sites you have granted or blocked permissions for. Remove an entry to be prompted again on the next visit.',
      ]),
      el('div', { id: 'permissions-list', class: 'sv-permissions-list' }),
    );
    if (!this._wired && ipcRenderer.on) {
      ipcRenderer.on('permission:changed', this._onChange);
      this._wired = true;
    }
    this._refresh();
  }

  // Settings re-mounts this tab on every open; drop the global listener so
  // stale instances don't pile up against detached DOM.
  destroy() {
    if (this._wired && ipcRenderer.removeListener) {
      ipcRenderer.removeListener('permission:changed', this._onChange);
    }
    this._wired = false;
  }

  async _refresh() {
    if (!this.container) return;
    const list = this.container.querySelector('#permissions-list');
    if (!list) return;
    let overrides = {};
    try {
      overrides = await ipcRenderer.invoke('notifications:permission:list-overrides') || {};
    } catch (err) {
      this._renderMessage(list, `Could not load site permissions: ${errMsg(err)}`, true);
      return;
    }

    const entries = Object.keys(overrides).map((k) => {
      const { origin, permission } = parseKey(k);
      return { key: k, origin, permission, decision: overrides[k] };
    }).sort((a, b) => {
      if (a.origin === b.origin) return a.permission.localeCompare(b.permission);
      return a.origin.localeCompare(b.origin);
    });

    if (entries.length === 0) {
      this._renderMessage(list, 'No site permissions set yet.');
      return;
    }

    while (list.firstChild) list.removeChild(list.firstChild);
    for (const entry of entries) {
      list.appendChild(this._buildRow(entry));
    }
  }

  _renderMessage(list, message, isError = false) {
    while (list.firstChild) list.removeChild(list.firstChild);
    list.appendChild(el('div', isError ? { class: 'sv-empty-row sv-empty-row--error', role: 'alert' } : { class: 'sv-empty-row' }, [message]));
  }

  _buildRow(entry) {
    const originDisplay = entry.origin === '*' ? 'All sites' : entry.origin;
    const badgeClass = entry.decision === 'allow' ? 'is-allow' : 'is-deny';
    const row = el('div', { class: 'sv-permission-row' });
    const main = el('div', { class: 'sv-permission-main' }, [
      el('span', { class: 'sv-permission-origin' }, [originDisplay]),
      el('span', { class: 'sv-permission-name' }, [labelFor(entry.permission)]),
    ]);
    const badge = el('span', { class: 'sv-status-badge ' + badgeClass }, [entry.decision]);
    const revoke = el('button', {
      type: 'button',
      class: 'sv-button sv-button--danger sv-permission-revoke',
    }, ['Revoke']);

    revoke.addEventListener('click', async () => {
      revoke.disabled = true;
      try {
        await ipcRenderer.invoke('notifications:permission:clear-override', {
          origin: entry.origin,
          permission: entry.permission,
        });
        this._refresh();
      } catch (err) {
        revoke.disabled = false;
        revoke.textContent = 'Failed';
        revoke.title = `Revoke failed: ${errMsg(err)}`;
      }
    });

    row.append(main, badge, revoke);
    return row;
  }

  refresh() { this._refresh(); }
}

module.exports = PermissionsTab;
