/**
 * @fileoverview npm Package Updater for Electron Applications
 * 
 * This module provides functionality to safely update npm packages in an Electron
 * application without affecting the Electron runtime itself. It creates a temporary
 * directory, excludes Electron from updates, and copies updated packages back to
 * the application directory.
 * 
 * @module updater
 * @requires child_process
 * @requires util
 * @requires fs/promises
 * @requires path
 * @requires os
 * 
 * @example
 * // Basic usage
 * const { runUpdater } = require('./updater');
 * 
 * try {
 *   await runUpdater();
 *   console.log('Packages updated successfully');
 * } catch (error) {
 *   console.error('Update failed:', error);
 * }
 * 
 * @example
 * // Using in an Electron main process
 * const { app } = require('electron');
 * const { runUpdater } = require('./updater');
 * 
 * app.on('ready', async () => {
 *   // Check for updates periodically
 *   setInterval(async () => {
 *     try {
 *       await runUpdater();
 *       console.log('Background update completed');
 *     } catch (error) {
 *       console.error('Background update failed:', error);
 *     }
 *   }, 24 * 60 * 60 * 1000); // Daily
 * });
 */

const { exec } = require('child_process');
const { promisify } = require('util');
const fs = require('fs').promises;
const path = require('path');
const os = require('os');

const execAsync = promisify(exec);

/**
 * Checks if a file or directory exists at the given path
 * 
 * @async
 * @param {string} p - The path to check
 * @returns {Promise<boolean>} True if the path exists, false otherwise
 * @private
 * 
 * @example
 * const exists = await pathExists('/path/to/file');
 * if (exists) {
 *   console.log('File exists');
 * }
 */
async function pathExists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function runUpdater() {
  let tempPath = null;
  try {
    const isWindows = process.platform === 'win32';
    const isMac = process.platform === 'darwin';

    // Create a unique temporary directory
    tempPath = path.join(os.tmpdir(), `instant_cognition_update_${Date.now()}`);

    // Determine the app path based on the environment
    let appPath;
    if (process.resourcesPath) {
      appPath = path.join(process.resourcesPath, 'app');
    } else if (process.env.ELECTRON_IS_DEV) {
      appPath = path.resolve(__dirname);
    } else {
      // In production, deduce path from executable location
      if (isMac) {
        appPath = path.join(process.execPath, '../../Resources/app');
      } else if (isWindows) {
        appPath = path.join(path.dirname(process.execPath), 'resources/app');
      } else {
        throw new Error('Unsupported platform');
      }
    }

    const packageJsonPath = path.join(appPath, 'package.json');
    console.log('App directory:', appPath);
    console.log('Looking for package.json at:', packageJsonPath);

    // Verify package.json exists
    if (!(await pathExists(packageJsonPath))) {
      throw new Error(`package.json not found at: ${packageJsonPath}`);
    }

    // Create temp directory
    await fs.mkdir(tempPath, { recursive: true });

    try {
      // Read and modify package.json to exclude electron
      const packageJson = JSON.parse(await fs.readFile(packageJsonPath, 'utf8'));
      const tempPackageJson = { ...packageJson };

      // Remove dev dependencies and electron
      delete tempPackageJson.devDependencies;
      if (tempPackageJson.dependencies && tempPackageJson.dependencies.electron) {
        delete tempPackageJson.dependencies.electron;
      }

      // Write modified package.json to temp directory
      await fs.writeFile(
        path.join(tempPath, 'package.json'),
        JSON.stringify(tempPackageJson, null, 2)
      );

      // Change to temp directory and update packages
      const originalDir = process.cwd();
      process.chdir(tempPath);

      console.log('Updating npm packages...');

      // Set a timeout for the update process (5 minutes)
      const updatePromise = (async () => {
        try {
          await execAsync('npm install --no-save --omit=dev');
          await execAsync('npm update --no-save --omit=dev');
        } finally {
          process.chdir(originalDir);
        }
      })();

      const timeoutPromise = new Promise((_, reject) => {
        setTimeout(
          () => reject(new Error('Update process timed out after 5 minutes')),
          5 * 60 * 1000
        );
      });

      await Promise.race([updatePromise, timeoutPromise]);

      // Copy updated node_modules back to app directory
      const appNodeModules = path.join(appPath, 'node_modules');
      const tempNodeModules = path.join(tempPath, 'node_modules');

      if (await pathExists(tempNodeModules)) {
        // Remove old node_modules one by one to handle locked files
        if (await pathExists(appNodeModules)) {
          const modules = await fs.readdir(appNodeModules);
          for (const module of modules) {
            const modulePath = path.join(appNodeModules, module);
            try {
              await fs.rm(modulePath, { recursive: true, force: true });
            } catch (error) {
              console.warn(`Failed to remove module ${module}:`, error.message);
            }
          }
        }

        // Copy new modules one by one
        const modules = await fs.readdir(tempNodeModules);
        for (const module of modules) {
          const sourcePath = path.join(tempNodeModules, module);
          const targetPath = path.join(appNodeModules, module);

          // Skip electron package
          if (module === 'electron') continue;

          try {
            await fs.cp(sourcePath, targetPath, { recursive: true });
          } catch (error) {
            console.warn(`Failed to copy module ${module}:`, error.message);
          }
        }
      }

      console.log('Update complete! Updated packages are ready to use.');
    } finally {
      // Clean up temp directory
      if (tempPath && process.cwd() !== tempPath) {
        try {
          const modules = await fs.readdir(path.join(tempPath, 'node_modules'));
          for (const module of modules) {
            try {
              await fs.rm(path.join(tempPath, 'node_modules', module), {
                recursive: true,
                force: true,
              });
            } catch (error) {
              console.warn(`Failed to remove temp module ${module}:`, error.message);
            }
          }
          await fs.rm(tempPath, { recursive: true, force: true });
        } catch (error) {
          console.warn('Failed to clean up temporary directory:', error.message);
        }
      }
    }
  } catch (error) {
    console.error('Error during update:', error);
    throw error;
  }
}

module.exports = { runUpdater };
