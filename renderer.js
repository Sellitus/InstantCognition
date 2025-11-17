// Main renderer process entry point
// This file ensures the renderer module loads correctly in both dev and production

// Since nodeIntegration is enabled, we can use require directly
// The key is that all requires are relative to where THIS file is loaded from (the app root)

// Simply require the renderer module using a path relative to the app root
require('./renderer/renderer');