const fs = require('fs');
const path = require('path');

// CSS load order:
//   1. tokens       — design tokens (single source of truth)
//   2. reset        — minimal reset + global :focus-visible + reduced-motion
//   3. main         — global layout, webview, find bar
//   4. components   — every component stylesheet
//   5. themes       — explicit theme classes (light overrides dark)
const cssFiles = [
  'renderer/styles/base/tokens.css',
  'renderer/styles/base/reset.css',
  'main.css',
  'renderer/styles/components/settings-v2.css',
  'renderer/styles/components/animations.css',
  'renderer/styles/components/dropdown.css',
  'renderer/styles/components/tooltip.css',
  'renderer/styles/components/menu.css',
  'renderer/styles/components/find-bar.css',
  'renderer/styles/components/command-palette.css',
  'renderer/styles/components/library-window.css',
  'renderer/styles/components/agent-panel.css',
  'renderer/styles/components/markdown.css',
  'renderer/styles/components/assistant-shell.css',
  'renderer/styles/components/artifacts-pane.css',
  'renderer/styles/components/approval-card.css',
  'renderer/styles/components/chat-thread.css',
  'renderer/styles/components/plan-panel.css',
  'renderer/styles/components/composer.css',
  'renderer/styles/components/sessions.css',
  'renderer/styles/components/launcher.css',
  'renderer/styles/components/annotation.css',
  'renderer/styles/components/reader-view.css',
  'renderer/styles/components/permission-prompt.css',
  'renderer/styles/components/welcome-overlay.css',
  'renderer/styles/components/tab-bar.css',
  'renderer/styles/components/agent-workspace.css',
  'renderer/styles/components/agent-egress.css',
  'renderer/styles/components/chrome-bar.css',
  'renderer/styles/components/new-tab-picker.css',
  'renderer/styles/components/omnibox.css',
  'renderer/styles/components/voice-capture-overlay.css',
  'renderer/styles/components/voice-input-button.css',
  'renderer/styles/components/notifications.css',
  'renderer/styles/components/icon.css',
  'renderer/styles/components/toast.css',
  'renderer/styles/components/confirm-dialog.css',
  'renderer/styles/components/prompt-dialog.css',
  'renderer/styles/components/fx.css',
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
