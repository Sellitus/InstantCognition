const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');
const { errMsg } = require('../../shared/errMsg');
const ipcSenderPolicy = require('./ipcSenderPolicy');

class RecoveryMode {
  constructor() {
    this.isRecoveryMode = false;
    this.failureCount = 0;
    this.recoveryWindow = null;
  }
  
  checkRecoveryMode() {
    // Check command line args
    if (process.argv.includes('--recovery')) {
      this.isRecoveryMode = true;
      return true;
    }
    
    // Don't check file if app isn't ready yet
    if (!app.isReady()) {
      return false;
    }
    
    // Check failure count from file
    const failureFile = path.join(app.getPath('userData'), 'failure-count.json');
    
    try {
      if (fs.existsSync(failureFile)) {
        const data = JSON.parse(fs.readFileSync(failureFile, 'utf8'));
        this.failureCount = data.count || 0;
        
        // If failed 3 times in a row, start in recovery mode
        if (this.failureCount >= 3) {
          this.isRecoveryMode = true;
          return true;
        }
      }
    } catch (error) {
      console.error('Error reading failure count:', error);
    }
    
    return false;
  }
  
  incrementFailureCount() {
    this.failureCount++;
    
    // Can't save if app isn't ready
    if (!app.isReady()) {
      return;
    }
    
    const failureFile = path.join(app.getPath('userData'), 'failure-count.json');
    
    try {
      fs.writeFileSync(failureFile, JSON.stringify({ 
        count: this.failureCount,
        lastFailure: new Date().toISOString()
      }));
    } catch (error) {
      console.error('Error writing failure count:', error);
    }
  }
  
  resetFailureCount() {
    this.failureCount = 0;
    
    // Can't reset file if app isn't ready
    if (!app.isReady()) {
      return;
    }
    
    const failureFile = path.join(app.getPath('userData'), 'failure-count.json');
    
    try {
      if (fs.existsSync(failureFile)) {
        fs.unlinkSync(failureFile);
      }
    } catch (error) {
      console.error('Error resetting failure count:', error);
    }
  }
  
  createRecoveryWindow() {
    this.recoveryWindow = new BrowserWindow({
      width: 600,
      height: 400,
      webPreferences: {
        nodeIntegration: true,
        contextIsolation: false
      },
      title: 'InstantCognition Recovery Mode'
    });
    ipcSenderPolicy.trustShell(this.recoveryWindow.webContents);
    
    // Create recovery HTML content
    const recoveryHTML = `
      <!DOCTYPE html>
      <html>
      <head>
        <title>Recovery Mode</title>
        <style>
          body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            margin: 0;
            padding: 40px;
            background: #15171b;
            color: #ecedef;
            line-height: 1.5;
          }
          h1 {
            color: #d9b26e;
            margin-bottom: 20px;
            font-weight: 600;
          }
          h3 { color: #ecedef; font-weight: 600; margin-top: 28px; }
          .actions { margin-top: 30px; display: flex; gap: 8px; flex-wrap: wrap; }
          button {
            background: #23262c;
            color: #ecedef;
            border: 1px solid rgba(255,255,255,0.10);
            padding: 10px 20px;
            border-radius: 6px;
            cursor: pointer;
            font-size: 14px;
            font-family: inherit;
            transition: background 150ms ease;
          }
          button:hover { background: rgba(255,255,255,0.04); }
          button.primary { background: #2FB9D6; border-color: #2FB9D6; color: #fff; }
          button.primary:hover { background: #45CDEC; }
          button.danger {
            background: rgba(224,122,122,0.14);
            border-color: #e07a7a;
            color: #e07a7a;
          }
          button.danger:hover { background: #e07a7a; color: #fff; }
          .log-path {
            font-family: ui-monospace, 'SF Mono', Menlo, Consolas, monospace;
            background: #0e1013;
            color: #a0a4ab;
            padding: 6px 10px;
            border-radius: 4px;
            border: 1px solid rgba(255,255,255,0.06);
            word-break: break-all;
            display: inline-block;
          }
          ul { color: #a0a4ab; }
          ul li { margin: 4px 0; }
        </style>
      </head>
      <body>
        <h1>Recovery Mode</h1>
        <p>InstantCognition has detected multiple startup failures and is running in recovery mode.</p>
        
        <h3>What you can do:</h3>
        <ul>
          <li>Reset all settings to defaults</li>
          <li>Clear application cache</li>
          <li>View error logs</li>
          <li>Try starting normally again</li>
        </ul>
        
        <p>Error logs location:<br>
        <span class="log-path">${app.getPath('userData')}/logs/</span></p>
        
        <div class="actions">
          <button onclick="resetSettings()">Reset Settings</button>
          <button onclick="clearCache()">Clear Cache</button>
          <button onclick="viewLogs()">View Logs</button>
          <button class="primary" onclick="tryNormal()">Try Normal Start</button>
          <button class="danger" onclick="quit()">Quit</button>
        </div>
        
        <script>
          const { ipcRenderer } = require('electron');
          
          function resetSettings() {
            if (confirm('This will reset all settings to defaults. Continue?')) {
              ipcRenderer.send('recovery-reset-settings');
            }
          }
          
          function clearCache() {
            if (confirm('This will clear all cached data. Continue?')) {
              ipcRenderer.send('recovery-clear-cache');
            }
          }
          
          function viewLogs() {
            ipcRenderer.send('recovery-view-logs');
          }
          
          function tryNormal() {
            ipcRenderer.send('recovery-try-normal');
          }
          
          function quit() {
            ipcRenderer.send('recovery-quit');
          }
          
          ipcRenderer.on('recovery-message', (event, message) => {
            alert(message);
          });
        </script>
      </body>
      </html>
    `;
    
    // Write recovery HTML to temp file
    const tempFile = path.join(app.getPath('temp'), 'recovery.html');
    fs.writeFileSync(tempFile, recoveryHTML);
    
    this.recoveryWindow.loadFile(tempFile);
    this.recoveryWindow.show();
    
    return this.recoveryWindow;
  }
  
  setupRecoveryHandlers() {
    const { ipcMain, shell } = require('electron');
    
    ipcMain.on('recovery-reset-settings', () => {
      try {
        // Reset config file
        const configPath = path.join(app.getPath('userData'), 'config.json');
        if (fs.existsSync(configPath)) {
          fs.unlinkSync(configPath);
        }
        
        // Reset failure count
        this.resetFailureCount();
        
        this.recoveryWindow.webContents.send('recovery-message', 'Settings reset successfully. Restarting...');
        
        setTimeout(() => {
          app.relaunch();
          app.quit();
        }, 2000);
      } catch (error) {
        this.recoveryWindow.webContents.send('recovery-message', `Error: ${errMsg(error)}`);
      }
    });

    ipcMain.on('recovery-clear-cache', async () => {
      try {
        const session = require('electron').session;
        await session.defaultSession.clearCache();
        await session.defaultSession.clearStorageData();
        
        this.recoveryWindow.webContents.send('recovery-message', 'Cache cleared successfully.');
      } catch (error) {
        this.recoveryWindow.webContents.send('recovery-message', `Error: ${errMsg(error)}`);
      }
    });

    ipcMain.on('recovery-view-logs', () => {
      const logsPath = path.join(app.getPath('userData'), 'logs');
      shell.openPath(logsPath);
    });
    
    ipcMain.on('recovery-try-normal', () => {
      this.resetFailureCount();
      app.relaunch();
      app.quit();
    });
    
    ipcMain.on('recovery-quit', () => {
      app.quit();
    });
  }
}

module.exports = new RecoveryMode();