const { ipcRenderer } = require('electron');
const toast = require('../components/Toast');

class RendererErrorHandler {
  constructor() {
    this.errorCount = 0;
    // Uncaught errors and rejections only. `errorCount` also counts every
    // console.error the app emits, which passes 1 within seconds of startup —
    // gating the toast on it silences it for the rest of the session.
    this.uncaughtCount = 0;
    this.setupErrorHandlers();
  }
  
  setupErrorHandlers() {
    // Handle window errors
    window.addEventListener('error', (event) => {
      this.handleError({
        type: 'JavaScript Error',
        message: event.message,
        filename: event.filename,
        line: event.lineno,
        column: event.colno,
        stack: event.error?.stack || 'No stack trace',
        timestamp: new Date().toISOString()
      });
    });
    
    // Handle promise rejections
    window.addEventListener('unhandledrejection', (event) => {
      this.handleError({
        type: 'Unhandled Promise Rejection',
        message: event.reason?.message || String(event.reason),
        stack: event.reason?.stack || 'No stack trace',
        timestamp: new Date().toISOString()
      });
    });
    
    // Override console.error to capture all errors
    const originalError = console.error;
    const originalLog = console.log;
    this._originalLog = originalLog;
    console.error = (...args) => {
      originalError.apply(console, args);
      
      const errorInfo = {
        type: 'Console Error',
        message: args.map(arg => {
          if (arg instanceof Error) {
            return arg.message;
          }
          return String(arg);
        }).join(' '),
        stack: new Error().stack,
        timestamp: new Date().toISOString()
      };
      
      this.handleError(errorInfo);
    };
  }
  
  handleError(errorInfo) {
    this.errorCount++;
    const isUncaught = errorInfo.type === 'JavaScript Error'
      || errorInfo.type === 'Unhandled Promise Rejection';
    if (isUncaught) this.uncaughtCount++;
    
    // Log to console (use original to avoid recursion if console.error is overridden)
    (this._originalLog || console.log).call(console, '[Renderer Error]', errorInfo);
    
    // Send to main process
    try {
      ipcRenderer.send('renderer-error', errorInfo);
    } catch (e) {
      console.log('Failed to send error to main process:', e);
    }
    
    // Show user-friendly error message for critical errors
    if (isUncaught && this.uncaughtCount === 1) {
      this.showErrorNotification(errorInfo);
    }
  }
  
  showErrorNotification(errorInfo) {
    toast.error(errorInfo.message || 'An unexpected error occurred.', {
      title: 'Error detected',
      timeout: 8000,
      action: { label: 'Reload', onClick: () => window.location.reload() },
    });
  }

}

// Initialize and export
module.exports = new RendererErrorHandler();