#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

// Color codes for terminal output
const colors = {
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  reset: '\x1b[0m',
  bold: '\x1b[1m'
};

// Node.js built-in modules that won't work in renderer process without nodeIntegration
const nodeOnlyModules = [
  'child_process', 'cluster', 'dgram', 'dns', 'http', 'http2', 'https',
  'net', 'readline', 'repl', 'tls', 'tty', 'v8', 'vm', 'worker_threads',
  'crypto', 'stream', 'util', 'zlib', 'querystring', 'string_decoder',
  'timers', 'url', 'assert', 'buffer', 'console', 'constants', 'domain',
  'events', 'punycode', 'process'
];

// Modules that are allowed in renderer with nodeIntegration
const allowedNodeModules = ['fs', 'path', 'os'];

// Track all findings
const findings = {
  errors: [],
  warnings: [],
  info: []
};

// Track module dependencies for circular dependency detection
const moduleDependencies = new Map();
const visitedModules = new Set();

function log(message, type = 'info') {
  const color = type === 'error' ? colors.red : type === 'warning' ? colors.yellow : colors.blue;
  console.log(`${color}${colors.bold}[${type.toUpperCase()}]${colors.reset} ${message}`);
}

function findRendererFiles(dir, fileList = []) {
  const files = fs.readdirSync(dir);
  
  files.forEach(file => {
    const filePath = path.join(dir, file);
    const stat = fs.statSync(filePath);
    
    if (stat.isDirectory() && !file.startsWith('.') && file !== 'node_modules') {
      findRendererFiles(filePath, fileList);
    } else if (file.endsWith('.js') && !file.endsWith('.test.js')) {
      fileList.push(filePath);
    }
  });
  
  return fileList;
}

function parseRequireStatements(filePath, fileContent) {
  const requires = [];
  const imports = [];
  
  // Use regex to find require() calls and import statements
  const requireRegex = /require\s*\(\s*['"`]([^'"`]+)['"`]\s*\)/g;
  const importRegex = /import\s+.*\s+from\s+['"`]([^'"`]+)['"`]/g;
  const destructureRequireRegex = /\{\s*(\w+(?:\s*,\s*\w+)*)\s*\}\s*=\s*require\s*\(\s*['"`]([^'"`]+)['"`]\s*\)/g;
  
  let match;
  
  // Find regular require() calls
  while ((match = requireRegex.exec(fileContent)) !== null) {
    const line = fileContent.substring(0, match.index).split('\n').length;
    requires.push({ module: match[1], line });
  }
  
  // Find destructured require() calls
  while ((match = destructureRequireRegex.exec(fileContent)) !== null) {
    const line = fileContent.substring(0, match.index).split('\n').length;
    requires.push({ module: match[2], line });
  }
  
  // Find import statements
  while ((match = importRegex.exec(fileContent)) !== null) {
    const line = fileContent.substring(0, match.index).split('\n').length;
    imports.push({ module: match[1], line });
  }
  
  return { requires, imports };
}

function resolveModulePath(moduleName, fromFile) {
  // Handle relative paths
  if (moduleName.startsWith('./') || moduleName.startsWith('../')) {
    const basePath = path.dirname(fromFile);
    let resolvedPath = path.resolve(basePath, moduleName);
    
    // Try different extensions
    const extensions = ['', '.js', '.json', '/index.js'];
    for (const ext of extensions) {
      const fullPath = resolvedPath + ext;
      if (fs.existsSync(fullPath) && fs.statSync(fullPath).isFile()) {
        return fullPath;
      }
    }
    return null;
  }
  
  // Handle node_modules
  const nodeModulesPath = path.join(process.cwd(), 'node_modules', moduleName);
  if (fs.existsSync(nodeModulesPath)) {
    return nodeModulesPath;
  }
  
  // Check if it's a Node.js built-in module
  if (nodeOnlyModules.includes(moduleName) || allowedNodeModules.includes(moduleName)) {
    return 'builtin:' + moduleName;
  }
  
  return null;
}

function checkModule(filePath, moduleName, line) {
  const resolvedPath = resolveModulePath(moduleName, filePath);
  const relativeFilePath = path.relative(process.cwd(), filePath);
  
  if (!resolvedPath) {
    findings.errors.push({
      file: relativeFilePath,
      line,
      message: `Cannot find module '${moduleName}'`,
      module: moduleName
    });
    return;
  }
  
  if (resolvedPath.startsWith('builtin:')) {
    const builtinModule = resolvedPath.substring(8);
    if (nodeOnlyModules.includes(builtinModule)) {
      findings.errors.push({
        file: relativeFilePath,
        line,
        message: `Node.js module '${builtinModule}' is not available in renderer process without nodeIntegration`,
        module: builtinModule
      });
    } else if (allowedNodeModules.includes(builtinModule)) {
      findings.warnings.push({
        file: relativeFilePath,
        line,
        message: `Node.js module '${builtinModule}' requires nodeIntegration to be enabled`,
        module: builtinModule
      });
    }
  }
  
  // Track dependencies for circular dependency detection
  if (!moduleDependencies.has(filePath)) {
    moduleDependencies.set(filePath, new Set());
  }
  if (resolvedPath && !resolvedPath.startsWith('builtin:') && !resolvedPath.includes('node_modules')) {
    moduleDependencies.get(filePath).add(resolvedPath);
  }
}

function detectCircularDependencies(filePath, chain = []) {
  if (visitedModules.has(filePath)) {
    return;
  }
  
  if (chain.includes(filePath)) {
    const circularChain = chain.slice(chain.indexOf(filePath)).concat(filePath);
    const relativeChain = circularChain.map(p => path.relative(process.cwd(), p));
    findings.errors.push({
      file: path.relative(process.cwd(), filePath),
      line: 0,
      message: `Circular dependency detected: ${relativeChain.join(' -> ')}`,
      module: 'circular'
    });
    return;
  }
  
  visitedModules.add(filePath);
  const dependencies = moduleDependencies.get(filePath) || new Set();
  
  for (const dep of dependencies) {
    detectCircularDependencies(dep, [...chain, filePath]);
  }
}

function analyzeFile(filePath) {
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    const { requires, imports } = parseRequireStatements(filePath, content);
    
    // Check all require() calls
    requires.forEach(req => {
      checkModule(filePath, req.module, req.line);
    });
    
    // Check all import statements
    imports.forEach(imp => {
      checkModule(filePath, imp.module, imp.line);
    });
    
    // Check for common patterns that might cause issues
    if (content.includes('__dirname') || content.includes('__filename')) {
      findings.warnings.push({
        file: path.relative(process.cwd(), filePath),
        line: 0,
        message: '__dirname and __filename are not available in some Electron renderer contexts',
        module: 'globals'
      });
    }
    
    // Check for process.cwd() usage
    if (content.includes('process.cwd()')) {
      findings.warnings.push({
        file: path.relative(process.cwd(), filePath),
        line: 0,
        message: 'process.cwd() may not work as expected in packaged Electron apps',
        module: 'process'
      });
    }
    
    // Check for Electron module usage
    if (content.includes("require('electron')") || content.includes('from \'electron\'')) {
      findings.info.push({
        file: path.relative(process.cwd(), filePath),
        line: 0,
        message: 'Uses Electron API - ensure preload script is properly configured',
        module: 'electron'
      });
    }
    
  } catch (error) {
    findings.errors.push({
      file: path.relative(process.cwd(), filePath),
      line: 0,
      message: `Failed to analyze file: ${error.message}`,
      module: 'parse-error'
    });
  }
}

function printSummary() {
  console.log('\n' + '='.repeat(80));
  console.log(`${colors.bold}Module Loading Test Summary${colors.reset}`);
  console.log('='.repeat(80) + '\n');
  
  if (findings.errors.length > 0) {
    console.log(`${colors.red}${colors.bold}Errors (${findings.errors.length}):${colors.reset}`);
    findings.errors.forEach(error => {
      console.log(`  ${colors.red}✗${colors.reset} ${error.file}:${error.line} - ${error.message}`);
    });
    console.log();
  }
  
  if (findings.warnings.length > 0) {
    console.log(`${colors.yellow}${colors.bold}Warnings (${findings.warnings.length}):${colors.reset}`);
    findings.warnings.forEach(warning => {
      console.log(`  ${colors.yellow}⚠${colors.reset} ${warning.file}:${warning.line} - ${warning.message}`);
    });
    console.log();
  }
  
  if (findings.info.length > 0) {
    console.log(`${colors.blue}${colors.bold}Info (${findings.info.length}):${colors.reset}`);
    findings.info.forEach(info => {
      console.log(`  ${colors.blue}ℹ${colors.reset} ${info.file}:${info.line} - ${info.message}`);
    });
    console.log();
  }
  
  if (findings.errors.length === 0 && findings.warnings.length === 0) {
    console.log(`${colors.green}${colors.bold}✓ All module imports look good!${colors.reset}`);
  }
  
  console.log('\n' + '='.repeat(80));
  console.log(`Total files analyzed: ${visitedModules.size}`);
  console.log(`Errors: ${findings.errors.length} | Warnings: ${findings.warnings.length} | Info: ${findings.info.length}`);
  console.log('='.repeat(80) + '\n');
}

function main() {
  console.log(`${colors.bold}Electron Renderer Module Test${colors.reset}`);
  console.log('Testing for module loading errors in renderer process...\n');
  
  const rendererDir = path.join(process.cwd(), 'renderer');
  
  if (!fs.existsSync(rendererDir)) {
    log('Renderer directory not found!', 'error');
    process.exit(1);
  }
  
  // Find all JavaScript files in renderer directory
  const files = findRendererFiles(rendererDir);
  
  // Also check renderer.js in root if it exists
  const rootRenderer = path.join(process.cwd(), 'renderer.js');
  if (fs.existsSync(rootRenderer)) {
    files.push(rootRenderer);
  }
  
  log(`Found ${files.length} JavaScript files to analyze`, 'info');
  
  // Analyze each file
  files.forEach(file => {
    analyzeFile(file);
  });
  
  // Check for circular dependencies
  log('Checking for circular dependencies...', 'info');
  for (const [filePath] of moduleDependencies) {
    if (!filePath.includes('node_modules')) {
      detectCircularDependencies(filePath);
    }
  }
  
  // Print summary
  printSummary();
  
  // Exit with error code if there are errors
  if (findings.errors.length > 0) {
    process.exit(1);
  }
}

// Run the test
if (require.main === module) {
  main();
}

module.exports = { findRendererFiles, parseRequireStatements, checkModule };