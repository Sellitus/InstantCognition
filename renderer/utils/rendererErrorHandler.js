const { ipcRenderer } = require('electron');

class RendererErrorHandler {
  constructor() {
    this.errorCount = 0;
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
    
    // Log to console
    console.log('[Renderer Error]', errorInfo);
    
    // Send to main process
    try {
      ipcRenderer.send('renderer-error', errorInfo);
    } catch (e) {
      console.log('Failed to send error to main process:', e);
    }
    
    // Show user-friendly error message for critical errors
    if (errorInfo.type === 'JavaScript Error' && this.errorCount === 1) {
      this.showErrorNotification(errorInfo);
    }
  }
  
  showErrorNotification(errorInfo) {
    // Create error notification element
    const notification = document.createElement('div');
    notification.className = 'error-notification';
    notification.innerHTML = `
      <div class="error-notification-content">
        <div class="error-notification-header">
          <span class="error-notification-title">⚠️ Error Detected</span>
          <button class="error-notification-close" onclick="this.parentElement.parentElement.parentElement.remove()">×</button>
        </div>
        <div class="error-notification-message">${errorInfo.message}</div>
        <div class="error-notification-actions">
          <button onclick="window.location.reload()">Reload</button>
          <button onclick="this.parentElement.parentElement.parentElement.remove()">Dismiss</button>
        </div>
      </div>
    `;
    
    // Add styles if not already present
    if (!document.getElementById('error-notification-styles')) {
      const style = document.createElement('style');
      style.id = 'error-notification-styles';
      style.textContent = `
        .error-notification {
          position: fixed;
          top: 20px;
          right: 20px;
          background: #ff5252;
          color: white;
          border-radius: 8px;
          box-shadow: 0 4px 12px rgba(0,0,0,0.3);
          padding: 16px;
          max-width: 400px;
          z-index: 999999;
          animation: slideIn 0.3s ease-out;
        }
        
        @keyframes slideIn {
          from {
            transform: translateX(100%);
            opacity: 0;
          }
          to {
            transform: translateX(0);
            opacity: 1;
          }
        }
        
        .error-notification-header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          margin-bottom: 8px;
        }
        
        .error-notification-title {
          font-weight: bold;
          font-size: 16px;
        }
        
        .error-notification-close {
          background: none;
          border: none;
          color: white;
          font-size: 24px;
          cursor: pointer;
          padding: 0;
          width: 24px;
          height: 24px;
          display: flex;
          align-items: center;
          justify-content: center;
        }
        
        .error-notification-message {
          margin-bottom: 12px;
          font-size: 14px;
          word-break: break-word;
        }
        
        .error-notification-actions {
          display: flex;
          gap: 8px;
        }
        
        .error-notification-actions button {
          background: rgba(255,255,255,0.2);
          border: 1px solid rgba(255,255,255,0.3);
          color: white;
          padding: 6px 12px;
          border-radius: 4px;
          cursor: pointer;
          font-size: 14px;
        }
        
        .error-notification-actions button:hover {
          background: rgba(255,255,255,0.3);
        }
      `;
      document.head.appendChild(style);
    }
    
    document.body.appendChild(notification);
    
    // Auto-remove after 10 seconds
    setTimeout(() => {
      if (notification.parentElement) {
        notification.remove();
      }
    }, 10000);
  }
  
  getErrorSummary() {
    return {
      totalErrors: this.errorCount,
      timestamp: new Date().toISOString()
    };
  }
}

// Initialize and export
module.exports = new RendererErrorHandler();