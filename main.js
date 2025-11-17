/**
 * InstantCognition - Main Entry Point
 * Cross-platform entry that handles platform-specific initialization
 */

const { app } = require('electron');

// Ensure single instance
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  console.log('[InstantCognition] Another instance is already running');
  app.quit();
  process.exit(0);
}

// Platform-specific initialization
if (process.platform === 'win32') {
  // Windows: Disable GPU for compatibility
  app.disableHardwareAcceleration();
  app.commandLine.appendSwitch('disable-gpu');
  app.commandLine.appendSwitch('disable-gpu-compositing');
  app.commandLine.appendSwitch('disable-software-rasterizer');
}

// Environment setup
process.env.NODE_ENV = process.env.NODE_ENV || 'production';
process.env.ELECTRON_DISABLE_SECURITY_WARNINGS = 'true';

// Global error handlers
process.on('uncaughtException', (error) => {
  console.error('[InstantCognition] Uncaught Exception:', error);
});

process.on('unhandledRejection', (reason, _promise) => {
  console.error('[InstantCognition] Unhandled Rejection:', reason);
});

// Load the main application
try {
  console.log('[InstantCognition] Loading main application...');
  require('./main/index.js');
  console.log('[InstantCognition] Main application loaded successfully');
} catch (error) {
  console.error('[InstantCognition] Failed to load main application:', error);

  // Fallback: Show error window
  const { BrowserWindow } = require('electron');

  app.whenReady().then(() => {
    const errorWindow = new BrowserWindow({
      width: 800,
      height: 600,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true
      }
    });

    const errorHtml = `
      <!DOCTYPE html>
      <html>
        <head>
          <title>InstantCognition - Error</title>
          <style>
            body {
              font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
              background: #f5f5f5;
              margin: 0;
              padding: 40px;
            }
            .container {
              max-width: 700px;
              margin: 0 auto;
              background: white;
              padding: 30px;
              border-radius: 8px;
              box-shadow: 0 2px 8px rgba(0,0,0,0.1);
            }
            h1 { color: #d32f2f; margin-top: 0; }
            .error {
              background: #ffebee;
              padding: 15px;
              border-radius: 4px;
              border-left: 4px solid #d32f2f;
              font-family: monospace;
              font-size: 13px;
              margin: 20px 0;
              overflow-x: auto;
            }
            .info { color: #666; }
          </style>
        </head>
        <body>
          <div class="container">
            <h1>Failed to Start InstantCognition</h1>
            <p class="info">The application encountered an error during startup:</p>
            <div class="error">${error instanceof Error ? error.message : String(error)}</div>
            ${error instanceof Error && error.stack ? `<div class="error">${error.stack}</div>` : ''}
            <p class="info">
              <strong>Platform:</strong> ${process.platform}<br>
              <strong>Electron:</strong> ${process.versions.electron}<br>
              <strong>Node:</strong> ${process.versions.node}
            </p>
          </div>
        </body>
      </html>
    `;

    errorWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(errorHtml)}`);
    errorWindow.show();
  });
}
