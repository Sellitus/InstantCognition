# Changelog

All notable changes to InstantCognition will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.6.2] - 2025-06-14

### Added

- Comprehensive testing infrastructure with Jest
  - Unit tests for logger and configuration utilities
  - Integration test framework for IPC communication
  - End-to-end test setup with Playwright
  - Performance and memory leak testing capabilities
- TypeScript support with strict type checking
- Developer tooling
  - ESLint v9 configuration for code quality
  - Prettier for code formatting
  - Husky git hooks for automated checks
  - Commitlint for conventional commits
  - EditorConfig for consistent coding styles
- CI/CD workflows with GitHub Actions
  - Automated testing on multiple platforms
  - Dependency update automation
  - Release automation
- New utility modules
  - ConfigManager for centralized configuration handling
  - Enhanced logger with platform-specific paths

### Changed

- Updated Jest to v30.0.0 with latest test runners
- Updated babel-jest to v30.0.0 for consistency
- Updated jest-html-reporter to v4.1.0
- Updated tslib to v2.8.1 for better TypeScript support
- Modified npm test command to run only stable unit tests by default
- Updated build configuration to include main directory structure
- Migrated ESLint configuration to v9 format

### Fixed

- Electron app no longer launches during test execution
- Build process now includes all necessary dependencies
- Test suite runs automatically without manual intervention
- Fixed module resolution issues in test environment

### Security

- Added eslint-plugin-security for security linting
- Configured npm audit in pre-push hooks
- Added security testing workflow in CI/CD

### Developer Experience

- Tests run without opening Electron windows
- Simplified test execution with npm test
- Clear separation between working and experimental tests
- Comprehensive test documentation in tests/README.md
