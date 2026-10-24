module.exports = {
  // ESLint is the style authority here; there is no separate formatter pass.
  '*.{js,jsx,ts,tsx}': [
    'eslint --fix',
    'jest --bail --findRelatedTests --passWithNoTests --watchman=false',
  ],
};
