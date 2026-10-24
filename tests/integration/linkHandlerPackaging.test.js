/**
 * linkHandlerPackaging.test.js — the packaged app must declare itself a handler
 * for http/https links, or other apps can never hand it one.
 *
 * - macOS: build.protocols becomes CFBundleURLTypes in Info.plist (electron-builder
 *   electronMac.js), which open-url requires.
 * - Linux: the same protocols become `x-scheme-handler/<scheme>` MimeType entries
 *   in the .desktop file (LinuxTargetHelper.computeDesktopEntry).
 */

const BUILD = require('../../package.json').build;

function declaredSchemes() {
  const protocols = Array.isArray(BUILD.protocols) ? BUILD.protocols : [BUILD.protocols];
  return protocols.flatMap((p) => (p && p.schemes) || []);
}

describe('http/https link handler packaging', () => {
  test('build.protocols registers the app for http and https', () => {
    expect(declaredSchemes()).toEqual(expect.arrayContaining(['http', 'https']));
    for (const p of BUILD.protocols) expect(typeof p.name).toBe('string');
  });

  test('no other scheme is claimed, since the app refuses every non-web link', () => {
    expect(declaredSchemes().filter((s) => s !== 'http' && s !== 'https')).toEqual([]);
  });

  test('linux.mimeTypes does not repeat the scheme handlers protocols already emits', () => {
    const mime = (BUILD.linux && BUILD.linux.mimeTypes) || [];
    expect(mime.filter((m) => m.startsWith('x-scheme-handler/'))).toEqual([]);
  });
});

// Windows ignores build.protocols for browsers: Default Apps lists only apps
// registered under StartMenuInternet + RegisteredApplications, which the NSIS
// include writes.
describe('Windows installer browser registration', () => {
  const fs = require('fs');
  const path = require('path');
  const includePath = BUILD.nsis && BUILD.nsis.include;
  const script = () => fs.readFileSync(path.join(__dirname, '..', '..', includePath), 'utf8');

  test('build.nsis.include names an existing script', () => {
    expect(includePath).toBe('build/installer.nsh');
    expect(fs.existsSync(path.join(__dirname, '..', '..', includePath))).toBe(true);
  });

  test('defines the install and uninstall hooks electron-builder calls', () => {
    expect(script()).toMatch(/^!macro customInstall\b/m);
    expect(script()).toMatch(/^!macro customUnInstall\b/m);
  });

  test('registers http and https capabilities to a ProgID that opens the URL', () => {
    const nsh = script();
    expect(nsh).toContain('Software\\RegisteredApplications');
    expect(nsh).toMatch(/Capabilities\\URLAssociations" "http" "\$\{PRODUCT_NAME\}URL"/);
    expect(nsh).toMatch(/Capabilities\\URLAssociations" "https" "\$\{PRODUCT_NAME\}URL"/);
    expect(nsh).toContain('\\shell\\open\\command" "" \'"$INSTDIR\\${APP_EXECUTABLE_FILENAME}" "%1"\'');
  });

  test('the ProgID is not itself a URL scheme', () => {
    expect(script()).not.toContain('URL Protocol');
  });

  test('uninstall removes the registration, except during an in-place update', () => {
    const uninstall = script().split('!macro customUnInstall')[1];
    expect(uninstall).toMatch(/\$\{ifNot\} \$\{isUpdated\}/);
    expect(uninstall).toContain('DeleteRegValue SHELL_CONTEXT "Software\\RegisteredApplications"');
    expect(uninstall).toContain('DeleteRegKey SHELL_CONTEXT "Software\\Clients\\StartMenuInternet\\${PRODUCT_NAME}"');
  });
});
