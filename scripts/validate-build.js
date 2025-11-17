#!/usr/bin/env node
/**
 * Validates that the project can be built successfully
 * Checks for common build issues before commit
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const errors = [];
const warnings = [];

console.log('🔍 Validating build readiness...\n');

// Check main entry point exists
const packageJson = JSON.parse(fs.readFileSync('package.json', 'utf8'));
const mainEntry = packageJson.main || 'index.js';

if (!fs.existsSync(mainEntry)) {
  errors.push(`Main entry point '${mainEntry}' not found`);
}

// Check all required files exist
const requiredFiles = [
  'index.html',
  'renderer.js',
  'preload.js',
  'main.css',
  'config.json'
];

const buildFiles = packageJson.build?.files || [];
const filesToCheck = [...requiredFiles];

// Extract actual files from build config (not patterns)
buildFiles.forEach(file => {
  if (!file.startsWith('!') && !file.includes('*') && !file.endsWith('/')) {
    filesToCheck.push(file);
  }
});

filesToCheck.forEach(file => {
  if (!fs.existsSync(file)) {
    errors.push(`Required file '${file}' not found`);
  }
});

// Check for TypeScript errors
try {
  console.log('📝 Checking TypeScript...');
  execSync('npm run typecheck', { stdio: 'pipe' });
  console.log('✅ TypeScript check passed\n');
} catch (error) {
  const output = error.stdout?.toString() || error.toString();
  const errorCount = (output.match(/error TS/g) || []).length;
  warnings.push(`TypeScript has ${errorCount} errors (non-blocking)`);
}

// Check package.json build configuration
if (!packageJson.build) {
  errors.push('No build configuration found in package.json');
} else {
  if (!packageJson.build.productName) {
    warnings.push('No productName in build configuration');
  }
  if (!packageJson.build.appId) {
    warnings.push('No appId in build configuration');
  }
}

// Check for electron dependency
if (!packageJson.devDependencies?.electron && !packageJson.dependencies?.electron) {
  errors.push('Electron is not listed as a dependency');
}

// Check node_modules exists
if (!fs.existsSync('node_modules')) {
  errors.push('node_modules directory not found. Run npm install first');
}

// Report results
console.log('📊 Build Validation Results:\n');

if (errors.length === 0 && warnings.length === 0) {
  console.log('✅ All checks passed! Project is ready to build.\n');
  process.exit(0);
} else {
  if (errors.length > 0) {
    console.log('❌ Errors found (must fix):\n');
    errors.forEach(error => console.log(`   - ${error}`));
    console.log('');
  }
  
  if (warnings.length > 0) {
    console.log('⚠️  Warnings found (optional):\n');
    warnings.forEach(warning => console.log(`   - ${warning}`));
    console.log('');
  }
  
  if (errors.length > 0) {
    console.log('❌ Build validation failed. Please fix errors before committing.\n');
    process.exit(1);
  } else {
    console.log('✅ Build validation passed with warnings.\n');
    process.exit(0);
  }
}