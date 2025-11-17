// Windows launcher with automatic fixes
// This file should be copied to the built app and set as main entry point for Windows builds

console.log('[LAUNCHER] Windows launcher starting...');

// Set environment variables before anything else
process.env.ELECTRON_DISABLE_GPU = '1';
process.env.ELECTRON_NO_ATTACH_CONSOLE = '1';

// Add command line arguments if not present
const requiredArgs = ['--no-sandbox', '--disable-gpu', '--disable-software-rasterizer'];
for (const arg of requiredArgs) {
  if (!process.argv.includes(arg)) {
    process.argv.push(arg);
  }
}

console.log('[LAUNCHER] GPU workarounds applied');

// Handle Windows-specific issues
if (process.platform === 'win32') {
  // Disable Windows Defender SmartScreen warnings
  process.env.ELECTRON_DISABLE_SECURITY_WARNINGS = 'true';
  
  // Fix for Windows 11 GPU issues
  process.env.ELECTRON_FORCE_CULL_FACE = '1';
}

// Now load the actual main file
try {
  console.log('[LAUNCHER] Loading main application...');
  require('./main/index.js');
} catch (error) {
  console.error('[LAUNCHER] Failed to load main application:', error);
  
  // Try alternative paths
  const alternatives = [
    './main/index.js',
    './resources/app/main/index.js',
    '../main/index.js',
    'main/index.js'
  ];
  
  let loaded = false;
  for (const alt of alternatives) {
    try {
      console.log(`[LAUNCHER] Trying alternative path: ${alt}`);
      require(alt);
      loaded = true;
      break;
    } catch (e) {
      // Continue trying
    }
  }
  
  if (!loaded) {
    console.error('[LAUNCHER] Could not find main application file');
    const { dialog } = require('electron');
    dialog.showErrorBox('Startup Error', 'Could not find main application file. Please reinstall.');
    process.exit(1);
  }
}