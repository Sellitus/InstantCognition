#!/usr/bin/env node

console.log('Running pre-build checks...');

const fs = require('fs');
const path = require('path');

// Check required files
const required = [
  'main/index.js',
  'index.html',
  'renderer/renderer.js',
  'assets/icon.ico',
  'assets/icon.png'
];

let missing = [];
for (const file of required) {
  if (!fs.existsSync(path.join(__dirname, '..', file))) {
    missing.push(file);
  }
}

if (missing.length > 0) {
  console.error('Missing required files:');
  missing.forEach(f => console.error('  -', f));
  process.exit(1);
}

console.log('✓ All required files present');

// Check main process for GPU fixes
const mainPath = path.join(__dirname, '../main/index.js');
const mainContent = fs.readFileSync(mainPath, 'utf8');

if (!mainContent.includes('app.disableHardwareAcceleration()')) {
  console.log('⚠ GPU fix not found in main/index.js');
  console.log('  Run: node scripts/fix-build-config.js');
}

// Run renderer module checks
console.log('\nChecking renderer modules...');
const { execSync } = require('child_process');

try {
  execSync('node scripts/test-renderer-modules.js', { stdio: 'inherit' });
  console.log('✓ Renderer module checks passed');
} catch (error) {
  console.error('✗ Renderer module checks failed');
  console.error('  Fix module loading errors before building');
  process.exit(1);
}

console.log('\n✓ All pre-build checks complete');
