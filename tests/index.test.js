// Root level test suite for InstantCognition

describe('InstantCognition Application', () => {
  it('should have valid package.json', () => {
    const packageJson = require('../package.json');

    expect(packageJson.name).toBe('instant-cognition');
    expect(packageJson.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(packageJson.main).toBe('index.js');
    expect(packageJson.scripts).toHaveProperty('start');
    expect(packageJson.scripts).toHaveProperty('test');
  });

  it('should have required dependencies', () => {
    const packageJson = require('../package.json');

    // Core dependencies
    expect(packageJson.dependencies).toHaveProperty('@cliqz/adblocker-electron');
    expect(packageJson.dependencies).toHaveProperty('winston');
    expect(packageJson.dependencies).toHaveProperty('cross-fetch');

    // Dev dependencies
    expect(packageJson.devDependencies).toHaveProperty('electron');
    expect(packageJson.devDependencies).toHaveProperty('jest');
  });

  it('should have proper file structure', () => {
    const fs = require('fs');
    const path = require('path');

    // Check main files exist
    expect(fs.existsSync(path.join(__dirname, '../index.js'))).toBe(true);
    expect(fs.existsSync(path.join(__dirname, '../index.html'))).toBe(true);
    expect(fs.existsSync(path.join(__dirname, '../main.css'))).toBe(true);
    expect(fs.existsSync(path.join(__dirname, '../renderer.js'))).toBe(true);
    expect(fs.existsSync(path.join(__dirname, '../preload.js'))).toBe(true);

    // Check directories
    expect(fs.existsSync(path.join(__dirname, '../main'))).toBe(true);
    expect(fs.existsSync(path.join(__dirname, '../renderer'))).toBe(true);
    expect(fs.existsSync(path.join(__dirname, '../assets'))).toBe(true);
  });

  it('should export main module correctly', () => {
    const mainIndex = require('../index.js');
    expect(mainIndex).toBeDefined();
  });
});
