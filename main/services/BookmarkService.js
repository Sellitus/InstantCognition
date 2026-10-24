// BookmarkService — JSON-backed tree of bookmark folders and entries.
//
// Tree shape: { id, type: 'folder'|'bookmark', name, url?, children?, parentId }
// Stored as a flat list keyed by id with parentId references — easier to update.
// Provides add/remove/move/getTree/search.

const fs = require('fs');
const path = require('path');
const { getConfigDir } = require('../../shared/configPaths');
const { errMsg } = require('../../shared/errMsg');
const { writeFileAtomic, readJsonOrQuarantine } = require('../../shared/atomicWrite');

const ROOT_ID = 'root';

class BookmarkService {
  constructor() {
    this._items = new Map();
    this._loaded = false;
    this._filePath = null;
    this._fs = fs;
    this._saveBlocked = false;
  }

  _setFs(f) { this._fs = f; }
  _setFilePath(p) { this._filePath = p; }

  _resolvePath() {
    if (this._filePath) return this._filePath;
    return path.join(getConfigDir(), 'bookmarks.json');
  }

  load() {
    if (this._loaded) return;
    const { value, blocked } = readJsonOrQuarantine(this._fs, this._resolvePath(), 'BookmarkService');
    this._saveBlocked = Boolean(blocked);
    if (Array.isArray(value)) {
      for (const item of value) this._items.set(item.id, item);
    }
    if (!this._items.has(ROOT_ID)) {
      this._items.set(ROOT_ID, { id: ROOT_ID, type: 'folder', name: 'Bookmarks', parentId: null });
    }
    this._loaded = true;
  }

  _newId(prefix) {
    return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  }

  /** @param {{ url?: string, title?: string, parentId?: string }} [spec] */
  add({ url, title, parentId } = {}) {
    if (!url) throw new Error('url required');
    this.load();
    const parent = parentId || ROOT_ID;
    if (!this._items.has(parent)) throw new Error(`parent folder not found: ${parent}`);
    const item = {
      id: this._newId('bm'),
      type: 'bookmark',
      name: title || url,
      url,
      parentId: parent,
      createdAt: Date.now(),
    };
    this._items.set(item.id, item);
    this._save();
    return item;
  }

  /** @param {{ name?: string, parentId?: string }} [spec] */
  addFolder({ name, parentId } = {}) {
    if (!name) throw new Error('name required');
    this.load();
    const parent = parentId || ROOT_ID;
    if (!this._items.has(parent)) throw new Error(`parent folder not found: ${parent}`);
    const folder = {
      id: this._newId('fld'),
      type: 'folder',
      name,
      parentId: parent,
      createdAt: Date.now(),
    };
    this._items.set(folder.id, folder);
    this._save();
    return folder;
  }

  remove(id) {
    this.load();
    if (id === ROOT_ID) return false;
    if (!this._items.has(id)) return false;
    // Cascade delete: remove descendants
    const toDelete = [id];
    let i = 0;
    while (i < toDelete.length) {
      const current = toDelete[i++];
      for (const item of this._items.values()) {
        if (item.parentId === current) toDelete.push(item.id);
      }
    }
    for (const targetId of toDelete) this._items.delete(targetId);
    this._save();
    return true;
  }

  move(id, targetFolderId) {
    this.load();
    const item = this._items.get(id);
    if (!item || id === ROOT_ID) return false;
    if (!this._items.has(targetFolderId)) return false;
    item.parentId = targetFolderId;
    this._save();
    return true;
  }

  getTree() {
    this.load();
    const childrenOf = (parentId) => {
      const children = [];
      for (const item of this._items.values()) {
        if (item.parentId === parentId) {
          const node = { ...item };
          if (node.type === 'folder') node.children = childrenOf(node.id);
          children.push(node);
        }
      }
      return children;
    };
    const root = { ...this._items.get(ROOT_ID), children: childrenOf(ROOT_ID) };
    return root;
  }

  // Exact-URL lookup backing the star toggle: pressing the star twice must
  // remove the bookmark rather than add a duplicate.
  findByUrl(url) {
    this.load();
    if (!url) return null;
    for (const item of this._items.values()) {
      if (item.type === 'bookmark' && item.url === url) return item;
    }
    return null;
  }

  search(query) {
    this.load();
    const q = (query || '').toLowerCase();
    if (!q) return [];
    const results = [];
    for (const item of this._items.values()) {
      if (item.type !== 'bookmark') continue;
      if (item.name.toLowerCase().includes(q) || (item.url && item.url.toLowerCase().includes(q))) {
        results.push(item);
      }
    }
    return results;
  }

  _save() {
    if (this._saveBlocked) {
      console.error('[BookmarkService] save skipped: bookmarks.json could not be loaded or moved aside');
      return;
    }
    try {
      writeFileAtomic(this._fs, this._resolvePath(), JSON.stringify([...this._items.values()]));
    } catch (err) {
      console.error('[BookmarkService] failed to save:', errMsg(err));
    }
  }
}

module.exports = new BookmarkService();
module.exports.ROOT_ID = ROOT_ID;
