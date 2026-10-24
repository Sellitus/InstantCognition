// Jest does NOT inherit root-level options into `projects` entries. Anything a
// project must see has to live here and be spread into every project below.
const projectBase = {
  moduleFileExtensions: ['js', 'jsx', 'ts', 'tsx', 'json'],

  roots: ['<rootDir>/main', '<rootDir>/renderer', '<rootDir>/shared', '<rootDir>/tests'],

  transform: {
    '^.+\\.(js|jsx)$': 'babel-jest',
    '^.+\\.(ts|tsx)$': 'ts-jest',
  },

  testPathIgnorePatterns: ['/node_modules/', '/builds/', '/dist/', '/release/'],
  modulePathIgnorePatterns: ['<rootDir>/builds/', '<rootDir>/dist/', '<rootDir>/release/'],

  moduleNameMapper: {
    '^@main/(.*)$': '<rootDir>/main/$1',
    '^@renderer/(.*)$': '<rootDir>/renderer/$1',
    '^@shared/(.*)$': '<rootDir>/shared/$1',
    '^@tests/(.*)$': '<rootDir>/tests/$1',
    '\\.(css|less|scss|sass)$': '<rootDir>/tests/mocks/styleMock.js',
    '\\.(jpg|jpeg|png|gif|svg)$': '<rootDir>/tests/mocks/fileMock.js',
    '^electron$': '<rootDir>/tests/mocks/electron.js',
    // marked ships ESM only; Electron's renderer loads it via require(esm),
    // Jest (CJS, node_modules untransformed) needs the package's UMD build.
    '^marked$': '<rootDir>/node_modules/marked/lib/marked.umd.js',
  },

  slowTestThreshold: 5000,

  // Call history is cleared and spies restored between tests. `resetMocks` is
  // deliberately off: it also wipes the implementations that `jest.mock`
  // factories install once per file, which turns shared fixtures into
  // undefined-returning stubs rather than isolating anything.
  clearMocks: true,
  restoreMocks: true,
};

module.exports = {
  // Test environment
  testEnvironment: 'node',
  testEnvironmentOptions: {
    customExportConditions: ['node', 'node-addons'],
  },

  // File extensions
  moduleFileExtensions: ['js', 'jsx', 'ts', 'tsx', 'json'],

  // Limit discovery to source and test roots so packaged artifacts do not
  // participate in Jest's haste map.
  roots: ['<rootDir>/main', '<rootDir>/renderer', '<rootDir>/shared', '<rootDir>/tests'],

  // Transform files
  transform: {
    '^.+\\.(js|jsx)$': 'babel-jest',
    '^.+\\.(ts|tsx)$': 'ts-jest',
  },

  // Test patterns
  testMatch: [
    '<rootDir>/tests/**/*.test.(js|jsx|ts|tsx)',
    '<rootDir>/tests/**/*.spec.(js|jsx|ts|tsx)',
  ],

  // Paths to ignore
  testPathIgnorePatterns: ['/node_modules/', '/builds/', '/dist/', '/release/'],

  // Module paths to ignore
  modulePathIgnorePatterns: ['<rootDir>/builds/', '<rootDir>/dist/', '<rootDir>/release/'],

  // Coverage configuration
  collectCoverage: false,
  collectCoverageFrom: [
    'main/**/*.{js,jsx,ts,tsx}',
    'renderer/**/*.{js,jsx,ts,tsx}',
    '!**/*.d.ts',
    '!**/node_modules/**',
    '!**/vendor/**',
    '!**/dist/**',
    '!**/build/**',
    '!**/coverage/**',
    // Bootstrap/glue: pure Electron wiring with no meaningful unit-test seam.
    // Covered instead by the tests/e2e smoke (execution-truth).
    '!renderer/renderer.js',
    '!preload.js',
    '!main/preload.js',
    '!main/ic-pages/**',
    '!renderer/utils/rendererErrorHandler.js',
  ],
  coverageDirectory: '<rootDir>/coverage',
  coverageReporters: ['text', 'lcov', 'html', 'json'],
  // Per-directory floors keep a weak area from hiding behind the global
  // average. Directory keys aggregate over everything beneath them (a glob key
  // would instead apply the numbers to every file individually). Each floor
  // sits a few points below the measured value, so it is a ratchet against
  // regression rather than a target to chase: raise one when a directory
  // climbs, never lower one to make a red run pass.
  // `global` is not the whole repo: Jest removes every file matched by a path
  // key below from the global group, leaving the bootstrap files (main/App.js,
  // main/index.js) — hence the lower branch/function floors, which are what
  // Electron wiring with few reachable branches actually measures.
  coverageThreshold: {
    global: {
      branches: 65,
      functions: 72,
      lines: 80,
      statements: 80,
    },
    './main/agent/':{ branches: 80, functions: 90, lines: 93, statements: 90 },
    './main/ipc/': { branches: 80, functions: 87, lines: 93, statements: 91 },
    './main/services/': { branches: 77, functions: 87, lines: 90, statements: 87 },
    './main/utils/': { branches: 82, functions: 90, lines: 91, statements: 89 },
    './renderer/components/': { branches: 66, functions: 76, lines: 86, statements: 82 },
    './renderer/core/': { branches: 79, functions: 71, lines: 91, statements: 86 },
    './renderer/ipc/': { branches: 82, functions: 93, lines: 92, statements: 90 },
    './renderer/layouts/': { branches: 71, functions: 83, lines: 89, statements: 84 },
    './renderer/managers/': { branches: 79, functions: 85, lines: 92, statements: 89 },
    './renderer/utils/': { branches: 87, functions: 94, lines: 95, statements: 94 },
  },

  // Module paths
  moduleNameMapper: {
    '^@main/(.*)$': '<rootDir>/main/$1',
    '^@renderer/(.*)$': '<rootDir>/renderer/$1',
    '^@shared/(.*)$': '<rootDir>/shared/$1',
    '^@tests/(.*)$': '<rootDir>/tests/$1',
    '\\.(css|less|scss|sass)$': '<rootDir>/tests/mocks/styleMock.js',
    '\\.(jpg|jpeg|png|gif|svg)$': '<rootDir>/tests/mocks/fileMock.js',
    '^electron$': '<rootDir>/tests/mocks/electron.js',
    // marked ships ESM only; Electron's renderer loads it via require(esm),
    // Jest (CJS, node_modules untransformed) needs the package's UMD build.
    '^marked$': '<rootDir>/node_modules/marked/lib/marked.umd.js',
  },

  // Global settings
  globals: {
    'ts-jest': {
      tsconfig: {
        jsx: 'react',
        allowJs: true,
      },
    },
  },

  // Performance settings
  maxWorkers: '50%',
  maxConcurrency: 5,

  // Timeout settings
  slowTestThreshold: 5000,

  // Watch settings
  watchman: false,
  watchPlugins: ['jest-watch-typeahead/filename', 'jest-watch-typeahead/testname'],

  // Clear mocks
  clearMocks: true,
  restoreMocks: true,

  detectOpenHandles: true,

  // Error handling
  bail: false,
  errorOnDeprecated: true,

  // Notifications
  notify: false,
  notifyMode: 'failure-change',

  // Reporters
  reporters: [
    'default',
    [
      'jest-html-reporters',
      {
        publicPath: './coverage',
        filename: 'test-report.html',
        pageTitle: 'InstantCognition Test Report',
        expand: true,
        hideIcon: false,
        customInfos: [
          {
            title: 'Environment',
            value: 'Node ' + process.version
          }
        ]
      },
    ],
  ],

  // Test environments for different test types
  projects: [
    {
      ...projectBase,
      displayName: 'unit-shared',
      testMatch: ['<rootDir>/tests/unit/shared/**/*.test.(js|ts)'],
      testEnvironment: 'node',
      testEnvironmentOptions: {
        customExportConditions: ['node', 'node-addons'],
      },
    },
    {
      ...projectBase,
      displayName: 'unit-main',
      testMatch: ['<rootDir>/tests/unit/main/**/*.test.(js|ts)'],
      testEnvironment: 'node',
      testEnvironmentOptions: {
        customExportConditions: ['node', 'node-addons'],
      },
    },
    {
      ...projectBase,
      displayName: 'unit-renderer',
      testMatch: ['<rootDir>/tests/unit/renderer/**/*.test.(js|ts)'],
      testEnvironment: 'jsdom',
    },
    {
      ...projectBase,
      displayName: 'integration',
      testMatch: ['<rootDir>/tests/integration/**/*.test.(js|ts)'],
      testEnvironment: 'node',
    },
    {
      ...projectBase,
      displayName: 'e2e',
      testMatch: ['<rootDir>/tests/e2e/**/*.test.(js|ts)'],
      testEnvironment: 'node',
      globals: {
        jest: {
          testTimeout: 30000,
        },
      },
    },
  ],
};
