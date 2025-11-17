// Extract the adblocker service functionality for testing
const path = require('path');
const os = require('os');

// Function copied from the main file
async function createAndUpdateBlocker(session) {
  const { ElectronBlocker } = require('@cliqz/adblocker-electron');
  const fs = require('fs');
  const fetch = require('cross-fetch');

  // URL for Hagezi's blocklist (choose the appropriate one for your needs)
  // let HAGEZI_LIST_URL = 'https://raw.githubusercontent.com/hagezi/dns-blocklists/main/adblock/pro.txt';
  let HAGEZI_LIST_URL =
    'https://raw.githubusercontent.com/hagezi/dns-blocklists/main/adblock/pro.plus.txt';
  let OISD_LIST_URL = 'https://big.oisd.nl/';
  let HAGEZI_TIF = 'https://raw.githubusercontent.com/hagezi/dns-blocklists/main/adblock/tif.txt';
  let HAGEZI_BADWARE =
    'https://raw.githubusercontent.com/hagezi/dns-blocklists/main/adblock/hoster.txt';
  let HAGEZI_FAKE = 'https://raw.githubusercontent.com/hagezi/dns-blocklists/main/adblock/fake.txt';
  let HAGEZI_ABUSED_TLD =
    'https://raw.githubusercontent.com/hagezi/dns-blocklists/main/adblock/spam-tlds-adblock.txt';

  let activeLists = [
    HAGEZI_LIST_URL,
    OISD_LIST_URL,
    HAGEZI_TIF,
    HAGEZI_BADWARE,
    HAGEZI_FAKE,
    HAGEZI_ABUSED_TLD,
  ];

  // Optimize adblocker creation by caching the blocker instance
  let blockerCache = null;

  if (blockerCache) return blockerCache;

  try {
    const cachePath = path.join(
      os.platform() === 'darwin'
        ? path.join(os.homedir(), '.instant-cognition', 'adblocker_cache.bin')
        : path.join(__dirname, '../../adblocker_cache.bin')
    );

    let cacheStats;
    let shouldUpdate = true;
    const CACHE_MAX_AGE = 24 * 60 * 60 * 1000; // 24 hours

    // Check cache age
    if (fs.existsSync(cachePath)) {
      cacheStats = fs.statSync(cachePath);
      shouldUpdate = Date.now() - cacheStats.mtimeMs > CACHE_MAX_AGE;

      if (!shouldUpdate) {
        const cachedData = await fs.promises.readFile(cachePath);
        try {
          blockerCache = await ElectronBlocker.deserialize(cachedData);
          console.log('Adblocker: Loaded from cache');
        } catch (error) {
          console.error('Cache deserialization failed, forcing update:', error);
          shouldUpdate = true;
        }
      }
    }

    if (shouldUpdate) {
      console.log('Adblocker: Updating filters...');
      blockerCache = await ElectronBlocker.fromLists(fetch, activeLists, {
        enableCompression: true,
        path: cachePath,
        read: fs.promises.readFile,
        write: fs.promises.writeFile,
        loadNetworkFilters: true,
        loadCosmeticFilters: false, // Disable cosmetic filtering for better performance
      });

      // Save updated cache
      const serialized = await blockerCache.serialize();
      await fs.promises.writeFile(cachePath, serialized);
      console.log('Adblocker: Cache updated');
    }

    // Enable blocking for all sessions
    const { BrowserWindow } = require('electron');
    const sessions = BrowserWindow.getAllWindows()
      .map((window) => window.webContents.session)
      .filter(Boolean); // Filter out any null/undefined sessions

    for (const session of sessions) {
      try {
        blockerCache.enableBlockingInSession(session);
      } catch (error) {
        console.error(`Failed to enable blocking for session:`, error);
      }
    }

    return blockerCache;
  } catch (error) {
    console.error('Adblocker: Critical error:', error);
    throw error; // Propagate error for proper handling
  }
}

// Function to disable the adblocker
function disableAdblocker(blocker) {
  if (blocker) {
    const { BrowserWindow } = require('electron');
    const sessions = BrowserWindow.getAllWindows().map((window) => window.webContents.session);
    sessions.forEach((session) => {
      blocker.disableBlockingInSession(session);
    });
    console.log('Adblocker: disabled');

    blocker = null;
  }
  return null;
}

module.exports = {
  createAndUpdateBlocker,
  disableAdblocker,
};
