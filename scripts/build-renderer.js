// Bundles the shell and launcher renderers into renderer.bundle.js and
// launcher.bundle.js. Those windows have no Node, so `electron` resolves to the
// context-bridge shim and any Node builtin import fails the build.
// Usage: node scripts/build-renderer.js
const path = require('path');
const esbuild = require('esbuild');

const ROOT = path.join(__dirname, '..');

/** @param {{ outdir?: string }} [opts] */
async function buildRenderer(opts = {}) {
  const outdir = opts.outdir || ROOT;
  /** @type {import('esbuild').BuildOptions} */
  const common = {
    bundle: true,
    platform: 'browser',
    format: 'iife',
    target: 'es2022',
    sourcemap: true,
    logLevel: 'warning',
    absWorkingDir: ROOT,
    alias: { electron: './renderer/ipc/electronShim.js' },
    define: { 'process.env.NODE_ENV': '"production"' },
  };
  await esbuild.build({
    ...common,
    entryPoints: ['renderer.js'],
    outfile: path.join(outdir, 'renderer.bundle.js'),
  });
  await esbuild.build({
    ...common,
    stdin: {
      contents: "require('./renderer/launcher/LauncherView').boot(document);",
      resolveDir: ROOT,
      sourcefile: 'launcher-entry.js',
    },
    outfile: path.join(outdir, 'launcher.bundle.js'),
  });
}

if (require.main === module) {
  buildRenderer().then(() => {
    console.log('Renderer bundled into renderer.bundle.js and launcher.bundle.js');
  }, (err) => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = { buildRenderer };
