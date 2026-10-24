const { Tray, nativeImage, app } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

class TrayService {
  constructor() {
    this.tray = null;
  }

  /**
   * Create the system tray icon.
   * @returns {Tray|null}
   */
  createTray() {
    let iconPath = path.join(__dirname, '..', '..', 'assets', 'icon');
    if (os.platform() === 'win32') {
      iconPath += '.ico';
    } else {
      iconPath += '.png';
    }

    if (!fs.existsSync(iconPath)) {
      console.error('Tray icon not found at:', iconPath);
      const alternativePath = app.isPackaged
        ? path.join(process.resourcesPath, 'assets', path.basename(iconPath))
        : iconPath;
      if (fs.existsSync(alternativePath)) {
        iconPath = alternativePath;
      }
    }

    try {
      const trayIcon = nativeImage.createFromPath(iconPath);
      if (trayIcon.isEmpty()) {
        console.error('Failed to load tray icon - image is empty');
        return null;
      }

      if (os.platform() === 'win32') {
        this.tray = new Tray(trayIcon);
      } else {
        this.tray = new Tray(trayIcon.resize({ width: 22, height: 22 }));
      }
      console.log('Tray icon created successfully');
      return this.tray;
    } catch (error) {
      console.error('Error creating tray icon:', error);
      return null;
    }
  }

  /**
   * Set the tray context menu and tooltip.
   * @param {import('electron').Menu} contextMenu - built context menu
   * @param {string} [tooltip='InstantCognition'] - tooltip text
   */
  setContextMenu(contextMenu, tooltip = 'InstantCognition') {
    if (!this.tray) return;
    this.tray.setToolTip(tooltip);
    this.tray.setContextMenu(contextMenu);
  }

  destroy() {
    if (this.tray) {
      this.tray.destroy();
      this.tray = null;
    }
  }
}

module.exports = new TrayService();
