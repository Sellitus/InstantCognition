const fs = require('fs');
const path = require('path');

// CSS files to combine
const cssFiles = [
  'main.css',
  'renderer/styles/components/sidebar.css',
  'renderer/styles/components/settings.css',
  'renderer/styles/components/animations.css',
  'renderer/styles/themes/dark.css',
  'renderer/styles/themes/light.css'
];

// Read and combine CSS files
let combinedCSS = '';

cssFiles.forEach(file => {
  const filePath = path.join(__dirname, '..', file);
  if (fs.existsSync(filePath)) {
    const content = fs.readFileSync(filePath, 'utf8');
    combinedCSS += `\n/* === ${file} === */\n${content}\n`;
  }
});

// Write combined CSS
const outputPath = path.join(__dirname, '..', 'main.combined.css');
fs.writeFileSync(outputPath, combinedCSS);

console.log('CSS files combined successfully into main.combined.css');