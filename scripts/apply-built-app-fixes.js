#!/usr/bin/env node
// Auto-generated fix script for built app issues

const fs = require('fs');
const path = require('path');

console.log('Applying fixes for built app...');

const platform = 'win';
const arch = 'x64';
const subfolder = arch === 'arm' ? 'arm64' : 'x64';

const buildPath = platform === 'win' 
  ? path.join(__dirname, `../builds/win-${arch}/InstantCognition-win32-${subfolder}`)
  : path.join(__dirname, `../builds/mac-${arch}/InstantCognition-darwin-${subfolder}`);

const mainPath = path.join(buildPath, 'resources/app/main/index.js');

if (!fs.existsSync(mainPath)) {
  console.error('Main file not found:', mainPath);
  process.exit(1);
}

let mainContent = fs.readFileSync(mainPath, 'utf8');

// Apply fixes


// Check if GPU fix already applied
if (!mainContent.includes('app.disableHardwareAcceleration()')) {
  // Add after the first line
  const lines = mainContent.split('\n');
  lines.splice(1, 0, `
// Auto-applied GPU fix for built app
const { app } = require('electron');
app.disableHardwareAcceleration();
`);
  mainContent = lines.join('\n');
}

// Write fixed content
fs.writeFileSync(mainPath, mainContent);
console.log('✓ Fixes applied to:', mainPath);

// Also fix the wrapper if it exists
const wrapperPath = path.join(buildPath, 'resources/app/main-wrapper.js');
if (fs.existsSync(wrapperPath)) {
  let wrapperContent = fs.readFileSync(wrapperPath, 'utf8');
  if (!wrapperContent.includes('ELECTRON_DISABLE_GPU')) {
    wrapperContent = 'process.env.ELECTRON_DISABLE_GPU = "1";\n' + wrapperContent;
    fs.writeFileSync(wrapperPath, wrapperContent);
    console.log('✓ Fixed wrapper:', wrapperPath);
  }
}

console.log('\nFixes applied! Try running the app again.');
