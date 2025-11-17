#!/usr/bin/env node

/**
 * Error Reporter - Collects and reports all errors from various sources
 * Helps autonomous coders understand what went wrong
 */

const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const util = require('util');

const execAsync = util.promisify(exec);

class ErrorReporter {
  constructor() {
    this.reportPath = path.join(__dirname, '..', 'error-report.json');
    this.errors = {
      timestamp: new Date().toISOString(),
      environment: {
        node: process.version,
        platform: process.platform,
        arch: process.arch,
      },
      errors: {
        runtime: [],
        typescript: [],
        eslint: [],
        tests: [],
        build: [],
        dependencies: [],
      },
    };
  }

  async collectAllErrors() {
    console.log('Collecting errors from all sources...');

    await Promise.all([
      this.collectRuntimeErrors(),
      this.collectTypeScriptErrors(),
      this.collectESLintErrors(),
      this.collectTestErrors(),
      this.collectBuildErrors(),
      this.collectDependencyErrors(),
    ]);

    await this.analyzeAndSuggestFixes();
    await this.saveReport();

    return this.errors;
  }

  async collectRuntimeErrors() {
    // Check for Node.js error logs
    const logFiles = [
      'npm-debug.log',
      'yarn-error.log',
      path.join(process.env.HOME || '', '.npm/_logs'),
      'auto-fix.log',
    ];

    for (const logFile of logFiles) {
      if (fs.existsSync(logFile)) {
        try {
          const content = fs.readFileSync(logFile, 'utf8');
          const errors = this.parseErrorsFromLog(content);
          this.errors.errors.runtime.push(...errors);
        } catch (e) {
          // Skip if can't read
        }
      }
    }

    // Check electron crash dumps
    const crashDir = path.join(__dirname, '..', 'crashes');
    if (fs.existsSync(crashDir)) {
      const crashes = fs.readdirSync(crashDir);
      for (const crash of crashes) {
        this.errors.errors.runtime.push({
          type: 'crash',
          file: crash,
          path: path.join(crashDir, crash),
        });
      }
    }
  }

  async collectTypeScriptErrors() {
    try {
      const { stdout, stderr } = await execAsync('npx tsc --noEmit --pretty false');
      // TypeScript exits with error code if there are errors, so this won't reach
    } catch (error) {
      const output = error.stdout || error.stderr || error.message;
      const errors = this.parseTypeScriptErrors(output);
      this.errors.errors.typescript = errors;
    }
  }

  async collectESLintErrors() {
    try {
      const { stdout } = await execAsync('npx eslint . --ext .js,.jsx,.ts,.tsx --format json');
      const results = JSON.parse(stdout);

      for (const file of results) {
        if (file.errorCount > 0 || file.warningCount > 0) {
          this.errors.errors.eslint.push({
            file: file.filePath,
            errors: file.messages.filter((m) => m.severity === 2),
            warnings: file.messages.filter((m) => m.severity === 1),
          });
        }
      }
    } catch (error) {
      // ESLint returns non-zero exit code when there are errors
      if (error.stdout) {
        try {
          const results = JSON.parse(error.stdout);
          for (const file of results) {
            if (file.errorCount > 0) {
              this.errors.errors.eslint.push({
                file: file.filePath,
                errors: file.messages.filter((m) => m.severity === 2),
              });
            }
          }
        } catch (e) {
          // Failed to parse JSON
        }
      }
    }
  }

  async collectTestErrors() {
    try {
      const { stdout } = await execAsync(
        'npm test -- --json --silent',
        { maxBuffer: 10 * 1024 * 1024 } // 10MB buffer
      );
      const results = JSON.parse(stdout);

      if (results.numFailedTests > 0) {
        this.errors.errors.tests = results.testResults
          .filter((t) => t.status === 'failed')
          .map((t) => ({
            file: t.name,
            duration: t.endTime - t.startTime,
            failures: t.assertionResults
              .filter((a) => a.status === 'failed')
              .map((a) => ({
                test: a.fullName,
                error: a.failureMessages.join('\n'),
              })),
          }));
      }
    } catch (error) {
      // Test command failed
      this.errors.errors.tests.push({
        error: 'Test suite failed to run',
        message: error.message,
      });
    }
  }

  async collectBuildErrors() {
    const buildCommands = [
      { cmd: 'npm run build:ts', name: 'TypeScript Build' },
      { cmd: 'npm run package-win-x64', name: 'Windows Build' },
      { cmd: 'npm run package-mac-x64', name: 'macOS Build' },
    ];

    for (const { cmd, name } of buildCommands) {
      try {
        await execAsync(cmd, { timeout: 60000 }); // 1 minute timeout
      } catch (error) {
        this.errors.errors.build.push({
          command: cmd,
          name,
          error: error.message,
          output: error.stdout || error.stderr,
        });
      }
    }
  }

  async collectDependencyErrors() {
    try {
      const { stdout, stderr } = await execAsync('npm ls --json');
      const deps = JSON.parse(stdout);

      if (deps.problems) {
        this.errors.errors.dependencies = deps.problems;
      }
    } catch (error) {
      // npm ls returns error code if there are problems
      try {
        const deps = JSON.parse(error.stdout || '{}');
        if (deps.problems) {
          this.errors.errors.dependencies = deps.problems;
        }
      } catch (e) {
        this.errors.errors.dependencies.push({
          error: 'Failed to analyze dependencies',
          message: error.message,
        });
      }
    }

    // Also check for security vulnerabilities
    try {
      const { stdout } = await execAsync('npm audit --json');
      const audit = JSON.parse(stdout);

      if (audit.metadata.vulnerabilities.total > 0) {
        this.errors.errors.dependencies.push({
          type: 'security',
          vulnerabilities: audit.metadata.vulnerabilities,
          advisories: Object.values(audit.advisories || {}),
        });
      }
    } catch (error) {
      // Ignore audit errors
    }
  }

  parseErrorsFromLog(content) {
    const errors = [];
    const lines = content.split('\n');

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.includes('ERROR') || line.includes('Error:')) {
        const error = {
          line: i + 1,
          message: line,
          context: [],
        };

        // Get surrounding context
        for (let j = Math.max(0, i - 2); j <= Math.min(lines.length - 1, i + 2); j++) {
          if (j !== i) {
            error.context.push(lines[j]);
          }
        }

        errors.push(error);
      }
    }

    return errors;
  }

  parseTypeScriptErrors(output) {
    const errors = [];
    const lines = output.split('\n');
    const errorRegex = /^(.+)\((\d+),(\d+)\): error TS(\d+): (.+)$/;

    for (const line of lines) {
      const match = line.match(errorRegex);
      if (match) {
        errors.push({
          file: match[1],
          line: parseInt(match[2]),
          column: parseInt(match[3]),
          code: `TS${match[4]}`,
          message: match[5],
        });
      }
    }

    return errors;
  }

  async analyzeAndSuggestFixes() {
    const suggestions = [];

    // Analyze TypeScript errors
    const tsErrors = this.errors.errors.typescript;
    if (tsErrors.length > 0) {
      const missingModules = tsErrors
        .filter((e) => e.code === 'TS2307')
        .map((e) => e.message.match(/Cannot find module '([^']+)'/)?.[1])
        .filter(Boolean);

      if (missingModules.length > 0) {
        suggestions.push({
          issue: 'Missing modules',
          fix: `npm install ${[...new Set(missingModules)].join(' ')}`,
        });
      }
    }

    // Analyze dependency errors
    if (this.errors.errors.dependencies.length > 0) {
      suggestions.push({
        issue: 'Dependency issues',
        fix: 'npm install --legacy-peer-deps',
      });
    }

    // Analyze ESLint errors
    const eslintErrors = this.errors.errors.eslint;
    if (eslintErrors.length > 0) {
      suggestions.push({
        issue: 'ESLint errors',
        fix: 'npm run lint:fix',
      });
    }

    this.errors.suggestions = suggestions;
  }

  async saveReport() {
    fs.writeFileSync(this.reportPath, JSON.stringify(this.errors, null, 2));

    console.log(`\nError report saved to: ${this.reportPath}`);
    console.log('\nSummary:');
    console.log(`- Runtime errors: ${this.errors.errors.runtime.length}`);
    console.log(`- TypeScript errors: ${this.errors.errors.typescript.length}`);
    console.log(`- ESLint errors: ${this.errors.errors.eslint.length}`);
    console.log(`- Test failures: ${this.errors.errors.tests.length}`);
    console.log(`- Build errors: ${this.errors.errors.build.length}`);
    console.log(`- Dependency issues: ${this.errors.errors.dependencies.length}`);

    if (this.errors.suggestions.length > 0) {
      console.log('\nSuggested fixes:');
      this.errors.suggestions.forEach((s) => {
        console.log(`- ${s.issue}: ${s.fix}`);
      });
    }
  }
}

// Run if called directly
if (require.main === module) {
  const reporter = new ErrorReporter();
  reporter
    .collectAllErrors()
    .then(() => {
      console.log('\nError collection complete!');
    })
    .catch((error) => {
      console.error('Error reporter failed:', error);
      process.exit(1);
    });
}

module.exports = ErrorReporter;
