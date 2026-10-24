const SingleLayout = require('./SingleLayout');
const SideBySideLayout = require('./SideBySideLayout');
const GridLayout = require('./GridLayout');
const TwoRowLayout = require('./TwoRowLayout');
const StackedLayout = require('./StackedLayout');

const layouts = {
  single: SingleLayout,
  sideBySide: SideBySideLayout,
  grid: GridLayout,
  twoRow: TwoRowLayout,
  stacked: StackedLayout,
};

/**
 * Create a layout instance by name.
 * @param {string} name - layout name
 * @returns {InstanceType<typeof import('./LayoutStrategy')>}
 */
function createLayout(name) {
  const LayoutClass = layouts[name];
  if (!LayoutClass) {
    throw new Error(`Unknown layout: "${name}". Available: ${Object.keys(layouts).join(', ')}`);
  }
  return new LayoutClass();
}

/**
 * Register a custom layout strategy.
 * @param {string} name - layout name
 * @param {Function} LayoutClass - constructor extending LayoutStrategy
 */
function registerLayout(name, LayoutClass) {
  layouts[name] = LayoutClass;
}

/**
 * Get list of all available layout names.
 * @returns {string[]}
 */
function getAvailableLayouts() {
  return Object.keys(layouts);
}

module.exports = { createLayout, registerLayout, getAvailableLayouts };
