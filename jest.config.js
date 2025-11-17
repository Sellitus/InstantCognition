module.exports = {
  // Test environment
  testEnvironment: 'node',
  testEnvironmentOptions: {
    customExportConditions: ['node', 'node-addons'],
  },

  // File extensions
  moduleFileExtensions: ['js', 'jsx', 'ts', 'tsx', 'json'],

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
    'preload.js',
    'index.js',
    '!**/*.d.ts',
    '!**/node_modules/**',
    '!**/vendor/**',
    '!**/dist/**',
    '!**/build/**',
    '!**/coverage/**',
  ],
  coverageDirectory: '<rootDir>/coverage',
  coverageReporters: ['text', 'lcov', 'html', 'json'],
  coverageThreshold: {
    global: {
      branches: 80,
      functions: 85,
      lines: 85,
      statements: 85,
    },
    './main/**/*.js': {
      branches: 85,
      functions: 90,
      lines: 90,
      statements: 90,
    },
    './renderer/**/*.js': {
      branches: 75,
      functions: 80,
      lines: 80,
      statements: 80,
    },
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
  },

  // Setup files
  setupFiles: ['<rootDir>/tests/setup/jest.mocks.js'],
  setupFilesAfterEnv: ['<rootDir>/tests/setup/jest.setup.js'],

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
  watchPlugins: ['jest-watch-typeahead/filename', 'jest-watch-typeahead/testname'],

  // Clear mocks
  clearMocks: true,
  resetMocks: true,
  restoreMocks: true,

  // Detect leaks
  detectLeaks: false, // Enable for memory leak tests
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
      displayName: 'unit-main',
      testMatch: ['<rootDir>/tests/unit/main/**/*.test.(js|ts)'],
      testEnvironment: 'node',
      testEnvironmentOptions: {
        customExportConditions: ['node', 'node-addons'],
      },
    },
    {
      displayName: 'unit-renderer',
      testMatch: ['<rootDir>/tests/unit/renderer/**/*.test.(js|ts)'],
      testEnvironment: 'jsdom',
    },
    {
      displayName: 'integration',
      testMatch: ['<rootDir>/tests/integration/**/*.test.(js|ts)'],
      testEnvironment: 'node',
    },
    {
      displayName: 'e2e',
      testMatch: ['<rootDir>/tests/e2e/**/*.test.(js|ts)'],
      testEnvironment: 'node',
      globals: {
        jest: {
          testTimeout: 30000,
        },
      },
    },
    {
      displayName: 'performance',
      testMatch: ['<rootDir>/tests/performance/**/*.test.(js|ts)'],
      testEnvironment: 'node',
      detectLeaks: true,
    },
  ],
};
