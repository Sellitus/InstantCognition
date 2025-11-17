#!/usr/bin/env node

/**
 * Health Check Script
 * Comprehensive system health check for autonomous coding
 */

const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const util = require('util');

const execAsync = util.promisify(exec);

class HealthChecker {
  constructor() {
    this.results = {
      timestamp: new Date().toISOString(),
      healthy: true,
      checks: [],
      quickFixes: [],
    };
  }

  async runHealthCheck() {
    console.log('🏥 Running comprehensive health check...\n');

    const checks = [
      this.checkNodeModules(),
      this.checkTypeScript(),
      this.checkESLint(),
      this.checkTests(),
      this.checkDependencies(),
      this.checkGitStatus(),
      this.checkBuildArtifacts(),
      this.checkFilePermissions(),
      this.checkEnvironment(),
    ];

    await Promise.all(checks);

    this.generateReport();
    return this.results;
  }

  async checkNodeModules() {
    const check = { name: 'Node Modules', status: 'checking' };

    try {
      const nodeModulesExists = fs.existsSync('node_modules');
      const packageLockExists = fs.existsSync('package-lock.json');

      if (!nodeModulesExists) {
        check.status = 'error';
        check.message = 'node_modules directory missing';
        this.results.quickFixes.push('npm install --legacy-peer-deps');
      } else if (!packageLockExists) {
        check.status = 'warning';
        check.message = 'package-lock.json missing';
        this.results.quickFixes.push('npm install');
      } else {
        // Check if node_modules is up to date
        const { stdout } = await execAsync('npm ls --depth=0 --json');
        const deps = JSON.parse(stdout);

        if (deps.problems && deps.problems.length > 0) {
          check.status = 'warning';
          check.message = `${deps.problems.length} dependency issues found`;
          this.results.quickFixes.push('npm install --legacy-peer-deps');
        } else {
          check.status = 'ok';
          check.message = 'All dependencies installed correctly';
        }
      }
    } catch (error) {
      check.status = 'error';
      check.message = error.message;
      this.results.quickFixes.push('rm -rf node_modules package-lock.json && npm install');
    }

    this.results.checks.push(check);
    if (check.status === 'error') this.results.healthy = false;
  }

  async checkTypeScript() {
    const check = { name: 'TypeScript', status: 'checking' };

    try {
      await execAsync('npx tsc --noEmit');
      check.status = 'ok';
      check.message = 'No TypeScript errors';
    } catch (error) {
      const output = error.stdout || error.stderr || '';
      const errorCount = (output.match(/error TS/g) || []).length;

      check.status = 'error';
      check.message = `${errorCount} TypeScript errors found`;
      this.results.quickFixes.push('npm run fix');
    }

    this.results.checks.push(check);
  }

  async checkESLint() {
    const check = { name: 'ESLint', status: 'checking' };

    try {
      const { stdout } = await execAsync('npx eslint . --ext .js,.jsx,.ts,.tsx --format json');
      const results = JSON.parse(stdout);

      let errorCount = 0;
      let warningCount = 0;

      for (const file of results) {
        errorCount += file.errorCount;
        warningCount += file.warningCount;
      }

      if (errorCount > 0) {
        check.status = 'error';
        check.message = `${errorCount} errors, ${warningCount} warnings`;
        this.results.quickFixes.push('npm run lint:fix');
      } else if (warningCount > 0) {
        check.status = 'warning';
        check.message = `${warningCount} warnings`;
      } else {
        check.status = 'ok';
        check.message = 'No linting issues';
      }
    } catch (error) {
      check.status = 'error';
      check.message = 'ESLint check failed';
      this.results.quickFixes.push('npm run lint:fix');
    }

    this.results.checks.push(check);
  }

  async checkTests() {
    const check = { name: 'Tests', status: 'checking' };

    try {
      const { stdout } = await execAsync('npm test -- --json');
      const results = JSON.parse(stdout);

      if (results.numFailedTests > 0) {
        check.status = 'error';
        check.message = `${results.numFailedTests} tests failing`;
        this.results.quickFixes.push('npm run errors:report');
      } else {
        check.status = 'ok';
        check.message = `${results.numPassedTests} tests passing`;
      }
    } catch (error) {
      check.status = 'warning';
      check.message = 'Tests failed to run';
    }

    this.results.checks.push(check);
  }

  async checkDependencies() {
    const check = { name: 'Security', status: 'checking' };

    try {
      const { stdout } = await execAsync('npm audit --json');
      const audit = JSON.parse(stdout);

      const vulns = audit.metadata.vulnerabilities;
      const total = vulns.total || 0;

      if (total === 0) {
        check.status = 'ok';
        check.message = 'No vulnerabilities found';
      } else if (vulns.high > 0 || vulns.critical > 0) {
        check.status = 'error';
        check.message = `${total} vulnerabilities (${vulns.critical} critical, ${vulns.high} high)`;
        this.results.quickFixes.push('npm audit fix');
      } else {
        check.status = 'warning';
        check.message = `${total} vulnerabilities (low/moderate)`;
      }
    } catch (error) {
      check.status = 'warning';
      check.message = 'Security audit failed';
    }

    this.results.checks.push(check);
  }

  async checkGitStatus() {
    const check = { name: 'Git Status', status: 'checking' };

    try {
      const { stdout: status } = await execAsync('git status --porcelain');
      const { stdout: stash } = await execAsync('git stash list');

      const modifiedFiles = status.trim().split('\n').filter(Boolean).length;
      const stashCount = stash.trim().split('\n').filter(Boolean).length;

      if (modifiedFiles === 0) {
        check.status = 'ok';
        check.message = 'Working directory clean';
      } else {
        check.status = 'warning';
        check.message = `${modifiedFiles} modified files`;

        if (status.includes('??')) {
          this.results.quickFixes.push('git add . && git commit -m "Add new files"');
        }
      }

      if (stashCount > 0) {
        check.message += `, ${stashCount} stashed changes`;
      }
    } catch (error) {
      check.status = 'error';
      check.message = 'Not a git repository';
    }

    this.results.checks.push(check);
  }

  async checkBuildArtifacts() {
    const check = { name: 'Build Artifacts', status: 'checking' };

    const dirs = ['builds', 'dist', 'out'];
    const existing = dirs.filter((d) => fs.existsSync(d));

    if (existing.length > 0) {
      const sizes = {};
      for (const dir of existing) {
        sizes[dir] = await this.getDirectorySize(dir);
      }

      const totalSize = Object.values(sizes).reduce((a, b) => a + b, 0);

      check.status = 'info';
      check.message = `${existing.length} build directories (${this.formatBytes(totalSize)})`;

      if (totalSize > 1024 * 1024 * 1024) {
        // 1GB
        check.status = 'warning';
        this.results.quickFixes.push('npm run clean');
      }
    } else {
      check.status = 'ok';
      check.message = 'No build artifacts';
    }

    this.results.checks.push(check);
  }

  async checkFilePermissions() {
    const check = { name: 'File Permissions', status: 'checking' };

    const executables = [
      'scripts/auto-fix.js',
      'scripts/error-reporter.js',
      'scripts/health-check.js',
    ];

    const notExecutable = [];

    for (const file of executables) {
      if (fs.existsSync(file)) {
        try {
          fs.accessSync(file, fs.constants.X_OK);
        } catch {
          notExecutable.push(file);
        }
      }
    }

    if (notExecutable.length === 0) {
      check.status = 'ok';
      check.message = 'All scripts are executable';
    } else {
      check.status = 'warning';
      check.message = `${notExecutable.length} scripts need execute permission`;
      this.results.quickFixes.push(`chmod +x ${notExecutable.join(' ')}`);
    }

    this.results.checks.push(check);
  }

  async checkEnvironment() {
    const check = { name: 'Environment', status: 'checking' };

    const nodeVersion = process.version;
    const npmVersion = (await execAsync('npm --version')).stdout.trim();
    const platform = process.platform;

    // Check Node.js version
    const requiredNode = '18.0.0';
    const currentNode = nodeVersion.slice(1);

    if (this.compareVersions(currentNode, requiredNode) >= 0) {
      check.status = 'ok';
      check.message = `Node ${nodeVersion}, npm ${npmVersion}, ${platform}`;
    } else {
      check.status = 'error';
      check.message = `Node ${nodeVersion} (requires >=${requiredNode})`;
      this.results.quickFixes.push('nvm install 18');
    }

    this.results.checks.push(check);
  }

  async getDirectorySize(dir) {
    try {
      const { stdout } = await execAsync(`du -sb ${dir}`);
      return parseInt(stdout.split('\t')[0]);
    } catch {
      return 0;
    }
  }

  formatBytes(bytes) {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  }

  compareVersions(a, b) {
    const partsA = a.split('.').map(Number);
    const partsB = b.split('.').map(Number);

    for (let i = 0; i < Math.max(partsA.length, partsB.length); i++) {
      const partA = partsA[i] || 0;
      const partB = partsB[i] || 0;

      if (partA > partB) return 1;
      if (partA < partB) return -1;
    }

    return 0;
  }

  generateReport() {
    console.log('\n📋 Health Check Report\n');
    console.log('─'.repeat(50));

    for (const check of this.results.checks) {
      const icon = {
        ok: '✅',
        warning: '⚠️ ',
        error: '❌',
        info: 'ℹ️ ',
        checking: '🔄',
      }[check.status];

      console.log(`${icon} ${check.name.padEnd(20)} ${check.message}`);
    }

    console.log('─'.repeat(50));

    if (this.results.quickFixes.length > 0) {
      console.log('\n🔧 Quick Fixes:\n');
      this.results.quickFixes.forEach((fix) => {
        console.log(`   npm run fix:all  # or manually:`);
        console.log(`   ${fix}`);
      });
    }

    console.log(`\n${this.results.healthy ? '✅ System is healthy!' : '❌ Issues detected!'}`);

    // Save detailed report
    fs.writeFileSync('health-report.json', JSON.stringify(this.results, null, 2));
  }
}

// Run if called directly
if (require.main === module) {
  const checker = new HealthChecker();
  checker
    .runHealthCheck()
    .then((results) => {
      process.exit(results.healthy ? 0 : 1);
    })
    .catch((error) => {
      console.error('Health check failed:', error);
      process.exit(1);
    });
}

module.exports = HealthChecker;
