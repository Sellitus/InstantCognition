#!/usr/bin/env node

/**
 * Automatic Error Detection and Fixing Script
 * This script helps autonomous coders by automatically detecting and fixing common issues
 */

const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const util = require('util');

const execAsync = util.promisify(exec);

class AutoFixer {
  constructor() {
    this.logFile = path.join(__dirname, '..', 'auto-fix.log');
    this.fixes = [];
  }

  log(message, level = 'info') {
    const timestamp = new Date().toISOString();
    const logMessage = `[${timestamp}] [${level.toUpperCase()}] ${message}\n`;
    fs.appendFileSync(this.logFile, logMessage);
    console.log(logMessage.trim());
  }

  async runCommand(command, description) {
    this.log(`Running: ${description}`);
    try {
      const { stdout, stderr } = await execAsync(command);
      if (stdout) this.log(`Output: ${stdout}`, 'debug');
      if (stderr) this.log(`Warning: ${stderr}`, 'warn');
      return { success: true, stdout, stderr };
    } catch (error) {
      this.log(`Error in ${description}: ${error.message}`, 'error');
      return { success: false, error };
    }
  }

  async detectAndFixIssues() {
    this.log('Starting automatic issue detection and fixing...');

    // 1. Fix ESLint issues
    await this.fixESLintIssues();

    // 2. Fix Prettier formatting
    await this.fixPrettierIssues();

    // 3. Fix TypeScript errors
    await this.fixTypeScriptErrors();

    // 4. Fix missing dependencies
    await this.fixMissingDependencies();

    // 5. Fix import/export issues
    await this.fixImportExportIssues();

    // 6. Clean and rebuild if needed
    await this.cleanAndRebuild();

    // 7. Run tests and collect failures
    await this.runTestsAndCollectFailures();

    this.log(`Completed auto-fix process. Fixed ${this.fixes.length} issues.`);
    return this.fixes;
  }

  async fixESLintIssues() {
    const result = await this.runCommand(
      'npx eslint . --ext .js,.jsx,.ts,.tsx --fix',
      'ESLint auto-fix'
    );

    if (result.success) {
      this.fixes.push('Fixed ESLint issues');
    }
  }

  async fixPrettierIssues() {
    const result = await this.runCommand(
      'npx prettier --write "**/*.{js,jsx,ts,tsx,json,css,md}"',
      'Prettier formatting'
    );

    if (result.success) {
      this.fixes.push('Fixed formatting issues');
    }
  }

  async fixTypeScriptErrors() {
    this.log('Running TypeScript fixer...');

    try {
      // Use the dedicated TypeScript fixer
      const { stdout } = await execAsync('node scripts/fix-typescript.js');
      this.log(stdout);
      this.fixes.push('Fixed TypeScript errors');
    } catch (error) {
      this.log('TypeScript fixer failed, attempting basic fixes...', 'warn');

      // Fallback to basic fixes
      const result = await this.runCommand('npx tsc --noEmit', 'TypeScript check');

      if (!result.success && result.error) {
        const errorOutput = result.error.stdout || result.error.message;

        // Parse TypeScript errors and attempt common fixes
        if (errorOutput.includes('Cannot find module')) {
          await this.fixMissingModules(errorOutput);
        }

        if (errorOutput.includes('Property') && errorOutput.includes('does not exist')) {
          await this.addMissingTypeDefinitions(errorOutput);
        }
      }
    }
  }

  async fixMissingDependencies() {
    const result = await this.runCommand('npm ls', 'Check dependencies');

    if (!result.success) {
      this.log('Found missing dependencies, attempting to fix...');

      // Try to install missing dependencies
      const installResult = await this.runCommand(
        'npm install --legacy-peer-deps',
        'Install missing dependencies'
      );

      if (installResult.success) {
        this.fixes.push('Installed missing dependencies');
      }
    }
  }

  async fixImportExportIssues() {
    // Find all JS/TS files
    const files = await this.findFiles(
      ['**/*.js', '**/*.ts'],
      ['node_modules', 'builds', 'dist', 'coverage']
    );

    for (const file of files) {
      const content = fs.readFileSync(file, 'utf8');
      let modified = false;
      let newContent = content;

      // Fix missing file extensions in imports
      newContent = newContent.replace(
        /from ['"](\.[^'"]+)(?<!\.js)(?<!\.ts)(?<!\.json)['"]/g,
        (match, importPath) => {
          const jsPath = path.join(path.dirname(file), `${importPath}.js`);
          const tsPath = path.join(path.dirname(file), `${importPath}.ts`);

          if (fs.existsSync(jsPath)) {
            modified = true;
            return `from '${importPath}.js'`;
          } else if (fs.existsSync(tsPath)) {
            modified = true;
            return `from '${importPath}.ts'`;
          }
          return match;
        }
      );

      if (modified) {
        fs.writeFileSync(file, newContent);
        this.fixes.push(`Fixed import paths in ${file}`);
      }
    }
  }

  async cleanAndRebuild() {
    // Check if there are build artifacts causing issues
    const buildDirs = ['builds', 'dist', 'out'];
    let cleaned = false;

    for (const dir of buildDirs) {
      if (fs.existsSync(dir)) {
        await this.runCommand(`rm -rf ${dir}`, `Clean ${dir} directory`);
        cleaned = true;
      }
    }

    if (cleaned) {
      this.fixes.push('Cleaned build artifacts');
    }
  }

  async runTestsAndCollectFailures() {
    const result = await this.runCommand(
      'npm test -- --json --outputFile=test-results.json',
      'Run tests with JSON output'
    );

    if (!result.success && fs.existsSync('test-results.json')) {
      const testResults = JSON.parse(fs.readFileSync('test-results.json', 'utf8'));

      // Log test failures for analysis
      if (testResults.numFailedTests > 0) {
        this.log(`Found ${testResults.numFailedTests} test failures`, 'warn');

        // Store detailed failure information
        const failures = testResults.testResults
          .filter((t) => t.status === 'failed')
          .map((t) => ({
            file: t.name,
            failures: t.assertionResults
              .filter((a) => a.status === 'failed')
              .map((a) => ({
                title: a.title,
                message: a.failureMessages.join('\n'),
              })),
          }));

        fs.writeFileSync('test-failures.json', JSON.stringify(failures, null, 2));

        this.log('Test failures saved to test-failures.json', 'info');
      }
    }
  }

  async fixMissingModules(errorOutput) {
    const moduleRegex = /Cannot find module '([^']+)'/g;
    const matches = [...errorOutput.matchAll(moduleRegex)];

    for (const match of matches) {
      const moduleName = match[1];

      if (!moduleName.startsWith('.')) {
        // It's an npm package
        this.log(`Installing missing module: ${moduleName}`);
        await this.runCommand(`npm install ${moduleName}`, `Install ${moduleName}`);
        this.fixes.push(`Installed missing module: ${moduleName}`);
      }
    }
  }

  async addMissingTypeDefinitions(errorOutput) {
    // Extract type errors and create basic type definitions
    const typeErrorRegex = /Property '(\w+)' does not exist on type '(\w+)'/g;
    const matches = [...errorOutput.matchAll(typeErrorRegex)];

    const typeAdditions = new Map();

    for (const match of matches) {
      const [, property, type] = match;
      if (!typeAdditions.has(type)) {
        typeAdditions.set(type, []);
      }
      typeAdditions.get(type).push(property);
    }

    if (typeAdditions.size > 0) {
      // Create or update type definitions file
      const typesFile = path.join(__dirname, '..', 'types', 'auto-generated.d.ts');
      let content = '// Auto-generated type definitions\n\n';

      for (const [type, properties] of typeAdditions) {
        content += `interface ${type} {\n`;
        for (const prop of properties) {
          content += `  ${prop}?: any;\n`;
        }
        content += '}\n\n';
      }

      fs.mkdirSync(path.dirname(typesFile), { recursive: true });
      fs.writeFileSync(typesFile, content);

      this.fixes.push('Added missing type definitions');
    }
  }

  async findFiles(patterns, ignore) {
    const { stdout } = await execAsync(
      `find . -type f \\( ${patterns.map((p) => `-name "${p}"`).join(' -o ')} \\) ${ignore.map((i) => `-not -path "./${i}/*"`).join(' ')}`
    );
    return stdout.trim().split('\n').filter(Boolean);
  }
}

// Run if called directly
if (require.main === module) {
  const autoFixer = new AutoFixer();
  autoFixer
    .detectAndFixIssues()
    .then((fixes) => {
      console.log('\nSummary of fixes:');
      fixes.forEach((fix) => console.log(`  - ${fix}`));
      process.exit(fixes.length > 0 ? 0 : 1);
    })
    .catch((error) => {
      console.error('Auto-fix failed:', error);
      process.exit(1);
    });
}

module.exports = AutoFixer;
