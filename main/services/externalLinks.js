// Links handed to the app by the OS: macOS open-url, a second instance's argv
// (Windows/Linux "open with"), and the first launch's own argv. They can arrive
// before the main window exists, so they wait here until a sink is attached.
// Only http(s) ever reaches a tab; every other scheme is refused and logged.

const WEB_PREFIX = /^https?:\/\//i;
// Two or more scheme characters: a single letter followed by ':' is a Windows
// drive path (C:\...), not a URL.
const HAS_SCHEME = /^[a-z][a-z0-9+.-]+:/i;

/** @type {((url: string) => void) | null} */
let sink = null;
/** @type {string[]} */
const pending = [];

function refuse(raw, source) {
  console.error(`[externalLinks] refused a non-web link from ${source}:`, String(raw).slice(0, 200));
}

/**
 * @param {unknown} raw
 * @returns {string | null} the normalized URL when raw is an absolute http(s) URL
 */
function normalizeWebUrl(raw) {
  if (typeof raw !== 'string' || !WEB_PREFIX.test(raw) || !URL.canParse(raw)) return null;
  const url = new URL(raw);
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || !url.hostname) return null;
  return url.href;
}

/**
 * Open an OS-supplied link in a new tab, now or once the window can take it.
 * @param {unknown} raw
 * @param {string} source where the link came from, for the refusal log
 * @returns {boolean} false when the link was refused
 */
function openWebUrl(raw, source) {
  const url = normalizeWebUrl(raw);
  if (!url) {
    refuse(raw, source);
    return false;
  }
  if (sink) sink(url);
  else pending.push(url);
  return true;
}

/**
 * The http(s) URLs in a command line. Flags and file paths are not links and
 * are skipped silently; an argument with any other scheme is refused and logged.
 * @param {string[] | undefined} argv
 * @returns {string[]}
 */
function webUrlsFromArgv(argv) {
  const urls = [];
  for (const arg of Array.isArray(argv) ? argv : []) {
    if (typeof arg !== 'string' || arg.startsWith('-')) continue;
    const url = normalizeWebUrl(arg);
    if (url) urls.push(url);
    else if (HAS_SCHEME.test(arg)) refuse(arg, 'command line');
  }
  return urls;
}

/**
 * @param {string[] | undefined} argv
 * @param {string} source
 */
function openFromArgv(argv, source) {
  for (const url of webUrlsFromArgv(argv)) openWebUrl(url, source);
}

/**
 * Deliver queued links, then every later one, to `deliver`.
 * @param {(url: string) => void} deliver
 */
function attach(deliver) {
  sink = deliver;
  while (sink === deliver && pending.length) sink(/** @type {string} */ (pending.shift()));
}

function detach() {
  sink = null;
}

module.exports = { openWebUrl, webUrlsFromArgv, openFromArgv, attach, detach };
