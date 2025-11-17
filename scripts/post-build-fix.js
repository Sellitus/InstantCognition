#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

console.log('=== Post-Build Fixer ===\n');

// Detect what was just built by checking builds directory
const buildsDir = path.join(__dirname, '../builds');
const buildFolders = fs.readdirSync(buildsDir).filter(f => fs.statSync(path.join(buildsDir, f)).isDirectory());

if (buildFolders.length === 0) {
  console.log('No builds found');
  process.exit(0);
}

// Get the most recent build
const latestBuild = buildFolders
  .map(f => ({
    name: f,
    path: path.join(buildsDir, f),
    time: fs.statSync(path.join(buildsDir, f)).mtime
  }))
  .sort((a, b) => b.time - a.time)[0];

console.log(`Latest build: ${latestBuild.name}`);
console.log(`Build time: ${latestBuild.time}`);

// Parse platform and architecture from folder name
const match = latestBuild.name.match(/(win|mac|lin)-(arm|x64)/);
if (!match) {
  console.log('Could not parse platform/arch from build folder name');
  process.exit(1);
}

const [, platform, architecture] = match;
console.log(`Platform: ${platform}, Architecture: ${architecture}`);

// Find the actual app folder
const subfolders = fs.readdirSync(latestBuild.path);
const appFolder = subfolders.find(f => f.includes('InstantCognition'));

if (!appFolder) {
  console.log('Could not find InstantCognition folder in build');
  process.exit(1);
}

const appPath = path.join(latestBuild.path, appFolder);
console.log(`\nApp path: ${appPath}`);

// Apply fixes based on platform
console.log('\nApplying post-build fixes...');

// 1. Fix main entry point
const resourcesPath = path.join(appPath, 'resources/app');
const packageJsonPath = path.join(resourcesPath, 'package.json');

if (fs.existsSync(packageJsonPath)) {
  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
  console.log(`\n1. Checking main entry: ${packageJson.main}`);
  
  // Ensure main points to correct file
  if (packageJson.main === 'main-wrapper.js') {
    // Check if wrapper exists
    if (!fs.existsSync(path.join(resourcesPath, 'main-wrapper.js'))) {
      console.log('   ✗ main-wrapper.js not found, reverting to main/index.js');
      packageJson.main = 'main/index.js';
      fs.writeFileSync(packageJsonPath, JSON.stringify(packageJson, null, 2));
    }
  }
}

// 2. Apply GPU fixes for Windows
if (platform === 'win') {
  console.log('\n2. Applying Windows GPU fixes...');
  
  const mainPath = path.join(resourcesPath, 'main/index.js');
  if (fs.existsSync(mainPath)) {
    let mainContent = fs.readFileSync(mainPath, 'utf8');
    
    // Check if GPU fix already exists
    if (!mainContent.includes('app.disableHardwareAcceleration()')) {
      console.log('   Adding GPU acceleration disable...');
      
      // Find the first app import
      const appImportMatch = mainContent.match(/const\s*{\s*app[^}]*}\s*=\s*require\(['"]electron['"]\);/);
      if (appImportMatch) {
        const insertPos = appImportMatch.index + appImportMatch[0].length;
        mainContent = mainContent.slice(0, insertPos) + '\napp.disableHardwareAcceleration();\n' + mainContent.slice(insertPos);
      } else {
        // Add at the beginning
        mainContent = "const { app } = require('electron');\napp.disableHardwareAcceleration();\n\n" + mainContent;
      }
      
      fs.writeFileSync(mainPath, mainContent);
      console.log('   ✓ GPU fix applied');
    } else {
      console.log('   ✓ GPU fix already present');
    }
  }
}

// 3. Fix paths for packaged app
console.log('\n3. Fixing paths for packaged app...');

const filesToFix = [
  'main/index.js',
  'main/preload.js',
  'renderer/renderer.js'
];

for (const file of filesToFix) {
  const filePath = path.join(resourcesPath, file);
  if (fs.existsSync(filePath)) {
    let content = fs.readFileSync(filePath, 'utf8');
    let modified = false;
    
    // Fix relative paths that won't work in packaged app
    if (content.includes("require('../") && !content.includes('app.getAppPath()')) {
      console.log(`   Fixing relative paths in ${file}...`);
      
      // Add path resolution at the top
      if (!content.includes('const __appPath')) {
        content = `const __appPath = require('electron').app ? require('electron').app.getAppPath() : __dirname;\n` + content;
        
        // Replace relative requires
        content = content.replace(/require\(['"]\.\.\/([^'"]+)['"]\)/g, "require(require('path').join(__appPath, '$1'))");
        modified = true;
      }
    }
    
    if (modified) {
      fs.writeFileSync(filePath, content);
      console.log(`   ✓ Fixed ${file}`);
    }
  }
}

// 4. Create a launcher script for Windows
if (platform === 'win') {
  console.log('\n4. Creating Windows launcher with fixes...');
  
  const launcherPath = path.join(appPath, 'InstantCognition-Fixed.bat');
  const launcherContent = `@echo off
echo Starting InstantCognition with fixes...
set ELECTRON_DISABLE_GPU=1
set ELECTRON_NO_ATTACH_CONSOLE=1
start "" "%~dp0\\InstantCognition.exe" --no-sandbox --disable-gpu --disable-software-rasterizer
`;
  
  fs.writeFileSync(launcherPath, launcherContent);
  console.log(`   ✓ Created launcher: InstantCognition-Fixed.bat`);
}

// 5. Verify critical files
console.log('\n5. Verifying critical files...');
const criticalFiles = [
  'resources/app/index.html',
  'resources/app/main/index.js',
  'resources/app/renderer/renderer.js',
  'resources/app/assets/icon.ico'
];

let allGood = true;
for (const file of criticalFiles) {
  const filePath = path.join(appPath, file);
  if (fs.existsSync(filePath)) {
    console.log(`   ✓ ${file}`);
  } else {
    console.log(`   ✗ ${file} - MISSING!`);
    allGood = false;
  }
}

console.log('\n' + (allGood ? '✓ All fixes applied successfully!' : '✗ Some issues remain'));

// 6. Run quick test
console.log('\n6. Running quick startup test...');
try {
  const testResult = execSync(`node "${path.join(__dirname, 'test-built-app.js')}" ${platform} ${architecture}`, {
    encoding: 'utf8',
    timeout: 15000
  });
  
  if (testResult.includes('No issues detected')) {
    console.log('   ✓ App starts correctly!');
  } else {
    console.log('   ⚠ Some issues detected, check test output');
  }
} catch (error) {
  console.log('   ✗ Test failed or timed out');
  console.log('   Run manually: node scripts/test-built-app.js');
}

console.log('\n✓ Post-build fixes complete!');