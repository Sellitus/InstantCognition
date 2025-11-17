# InstantCognition Test Suite

This directory contains the comprehensive test suite for InstantCognition,
designed to catch bugs before runtime.

## Test Structure

```
tests/
├── unit/               # Unit tests for individual components
│   ├── main/          # Main process tests
│   └── renderer/      # Renderer process tests
├── integration/       # Integration tests for IPC communication
├── e2e/              # End-to-end tests with Playwright
├── performance/      # Performance and memory leak tests
├── mocks/           # Mock implementations
└── setup/           # Test setup and configuration
```

## Running Tests

### All Tests

```bash
npm test
```

### Specific Test Categories

```bash
# Unit tests only
npm run test:unit

# Integration tests
npm run test:integration

# E2E tests
npm run test:e2e

# Performance tests
npm run test:memory
```

### Working Tests Without Manual Intervention

Due to the nature of Electron applications, some tests require special handling
to avoid launching the actual application. The following tests run successfully
without manual intervention:

```bash
# Run utility tests (config manager, logger)
npm test -- tests/unit/main/utils/ --runInBand --forceExit

# Run specific working tests
npm test -- tests/unit/main/utils/logger.simple.test.js --runInBand --forceExit
npm test -- tests/unit/main/utils/config.test.js --runInBand --forceExit
```

## Test Coverage

The test suite includes:

1. **Unit Tests**

   - Logger utility with platform-specific paths
   - Configuration manager with full CRUD operations
   - Component isolation and mocking

2. **Integration Tests**

   - IPC communication between main and renderer
   - Multi-window coordination
   - Event handling

3. **E2E Tests**

   - Full application workflow
   - User interactions
   - Multi-cognitizer scenarios

4. **Performance Tests**
   - Memory leak detection
   - Performance benchmarks
   - Resource usage monitoring

## Known Issues and Workarounds

### Electron Module Mocking

Some tests that directly import electron modules may fail with "Electron failed
to install correctly" error. This is because Jest tries to load the actual
Electron binary. To work around this:

1. Use `jest.doMock()` instead of `jest.mock()` for dynamic mocking
2. Mock electron modules before any imports
3. Use the `--forceExit` flag to ensure tests exit properly

### Test Timeouts

For tests that might hang:

- Use `timeout` command: `timeout 30s npm test`
- Set test timeout: `--testTimeout=5000`
- Use `--runInBand` to run tests serially

## Writing New Tests

When adding new tests:

1. **For Electron-dependent code**: Use the mocking pattern from
   `logger.simple.test.js`
2. **For utilities**: Follow the pattern in `config.test.js`
3. **Always clean up**: Reset modules and mocks in `beforeEach`
4. **Mock file system**: Prevent actual file operations during tests

## CI/CD Integration

The test suite is integrated with GitHub Actions for continuous testing. See
`.github/workflows/test.yml` for the CI configuration.

## Future Improvements

1. Complete electron mocking system for all test files
2. Add visual regression tests for UI components
3. Implement automated accessibility testing
4. Add mutation testing for better coverage quality
5. Create test data fixtures for consistent testing
