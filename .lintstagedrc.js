module.exports = {
  // JavaScript and TypeScript files
  '*.{js,jsx,ts,tsx}': [
    'eslint --fix',
    'prettier --write',
    'jest --bail --findRelatedTests --passWithNoTests',
  ],

  // JSON files
  '*.json': ['prettier --write'],

  // Markdown files
  '*.md': ['prettier --write'],

  // CSS files
  '*.css': ['prettier --write'],

  // HTML files
  '*.html': ['prettier --write'],

  // Configuration files
  'package.json': ['npm run lint:fix', () => 'npm audit fix --dry-run'],
};
