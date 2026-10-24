const globals = require('globals');

module.exports = [
  {
    ignores: [
      'builds/**/*',
      'dist/**/*',
      'out/**/*',
      'node_modules/**/*',
      'coverage/**/*',
      'vendor/**/*',
      '*.min.js',
      '*.bundle.js',
      '**/*.d.ts',
      'types/**/*',
      '.husky/**/*',
      '**/*.test.js',
      '**/*.spec.js',
    ],
  },
  {
    files: ['**/*.js', '**/*.jsx'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'commonjs',
      globals: {
        ...globals.node,
        ...globals.browser,
        ...globals.jest,
      },
      parserOptions: {
        ecmaFeatures: {
          jsx: true,
        },
      },
    },
    rules: {
      // Relaxed rules for better compatibility
      'no-unused-vars': [
        'warn',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],
      'no-console': 'off',
      'no-debugger': 'warn',
      'no-undef': 'error',
      'no-redeclare': 'error',
      'no-const-assign': 'error',
      'no-this-before-super': 'error',
      'no-unreachable': 'warn',
      'valid-typeof': 'error',
      'no-duplicate-case': 'error',
      'no-empty': ['warn', { allowEmptyCatch: true }],
      'no-extra-semi': 'warn',
      'no-func-assign': 'error',
      'no-irregular-whitespace': 'warn',
      'no-unexpected-multiline': 'error',
      'use-isnan': 'error',
      'no-fallthrough': 'warn',
      'no-mixed-spaces-and-tabs': 'warn',
      'prefer-const': 'off',
      'no-var': 'off',
      'no-async-promise-executor': 'warn',
      'no-case-declarations': 'warn',
      'no-prototype-builtins': 'off',
      'no-useless-escape': 'warn',
      'no-control-regex': 'off',
      'no-constant-condition': ['warn', { checkLoops: false }],
    },
  },
  {
    files: ['main/**/*.js'],
    rules: {
      // Main process specific rules
      'no-process-exit': 'off',
    },
  },
  {
    files: ['renderer/**/*.js'],
    languageOptions: {
      globals: {
        document: 'readonly',
        window: 'readonly',
        navigator: 'readonly',
        location: 'readonly',
        HTMLElement: 'readonly',
        localStorage: 'readonly',
        sessionStorage: 'readonly',
      },
    },
  },
  {
    files: ['scripts/**/*.js'],
    rules: {
      // Scripts can use console
      'no-console': 'off',
    },
  },
  {
    files: ['tests/mocks/**/*.js'],
    rules: {
      // Mock signatures mirror the real Electron API, so the parameter names
      // are documentation even where the stub body ignores them.
      'no-unused-vars': ['warn', { args: 'none', varsIgnorePattern: '^_' }],
    },
  },
];
