const fs = require('fs');
const path = require('path');
const { app, dialog } = require('electron');

class ErrorHandler {
  constructor() {
    this.logPath = null;
    this.logStream = null;
    this.errorCount = 0;
    this.criticalErrors = [];
  }

  initialize() {
    // Set up log file
    const userDataPath = app.getPath('userData');
    const logsDir = path.join(userDataPath, 'logs');
    
    // Ensure logs directory exists
    if (!fs.existsSync(logsDir)) {
      fs.mkdirSync(logsDir, { recursive: true });
    }
    
    // Create log file with timestamp
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    this.logPath = path.join(logsDir, `error-${timestamp}.log`);
    this.logStream = fs.createWriteStream(this.logPath, { flags: 'a' });
    
    // Write header
    this.writeToLog('=== InstantCognition Error Log ===');
    this.writeToLog(`Started: ${new Date().toISOString()}`);
    this.writeToLog(`Platform: ${process.platform}`);
    this.writeToLog(`Architecture: ${process.arch}`);
    this.writeToLog(`Node: ${process.version}`);
    this.writeToLog(`Electron: ${process.versions.electron}`);
    this.writeToLog(`App Version: ${app.getVersion()}`);
    this.writeToLog(`Packaged: ${app.isPackaged}`);
    this.writeToLog('=====================================\n');
    
    // Set up global error handlers
    this.setupErrorHandlers();
    
    return this.logPath;
  }
  
  setupErrorHandlers() {
    // Handle uncaught exceptions
    process.on('uncaughtException', (error) => {
      this.handleError('Uncaught Exception', error, true);
    });
    
    // Handle unhandled promise rejections
    process.on('unhandledRejection', (reason, promise) => {
      this.handleError('Unhandled Promise Rejection', reason, false);
    });
    
    // Handle warnings
    process.on('warning', (warning) => {
      this.writeToLog(`[WARNING] ${warning.name}: ${warning.message}`);
      if (warning.stack) {
        this.writeToLog(warning.stack);
      }
    });
    
    // App error events
    app.on('render-process-gone', (event, webContents, details) => {
      this.handleError('Renderer Process Crashed', {
        reason: details.reason,
        exitCode: details.exitCode
      }, true);
    });
    
    app.on('child-process-gone', (event, details) => {
      this.handleError('Child Process Crashed', details, false);
    });
  }
  
  handleError(type, error, isCritical = false) {
    this.errorCount++;
    
    const errorInfo = {
      type,
      timestamp: new Date().toISOString(),
      message: error?.message || String(error),
      stack: error?.stack || 'No stack trace available',
      isCritical
    };
    
    // Log to file
    this.writeToLog(`\n[${errorInfo.type}] ${errorInfo.timestamp}`);
    this.writeToLog(`Message: ${errorInfo.message}`);
    this.writeToLog(`Stack trace:\n${errorInfo.stack}`);
    this.writeToLog('-----------------------------------');
    
    // Log to console
    console.error(`[${type}]`, error);
    
    // Track critical errors
    if (isCritical) {
      this.criticalErrors.push(errorInfo);
      
      // Show error dialog for critical errors
      if (!app.isReady()) {
        app.whenReady().then(() => this.showErrorDialog(errorInfo));
      } else {
        this.showErrorDialog(errorInfo);
      }
    }
  }
  
  showErrorDialog(errorInfo) {
    const buttons = ['View Log', 'Continue', 'Quit'];
    const defaultId = 1;
    
    dialog.showMessageBox({
      type: 'error',
      title: 'Application Error',
      message: errorInfo.type,
      detail: `${errorInfo.message}\n\nError logged to: ${this.logPath}`,
      buttons,
      defaultId,
      noLink: true
    }).then(({ response }) => {
      if (response === 0) {
        // View Log
        require('electron').shell.openPath(this.logPath);
      } else if (response === 2) {
        // Quit
        app.quit();
      }
    });
  }
  
  logRendererError(error) {
    this.handleError('Renderer Error', error, false);
  }
  
  writeToLog(message) {
    if (this.logStream) {
      this.logStream.write(message + '\n');
    }
  }
  
  getErrorSummary() {
    return {
      totalErrors: this.errorCount,
      criticalErrors: this.criticalErrors.length,
      logPath: this.logPath
    };
  }
  
  close() {
    if (this.logStream) {
      this.writeToLog('\n=== Session Ended ===');
      this.writeToLog(`Total Errors: ${this.errorCount}`);
      this.writeToLog(`Critical Errors: ${this.criticalErrors.length}`);
      this.logStream.end();
    }
  }
}

module.exports = new ErrorHandler();