// httpDownload — stream an HTTPS URL to a file (or buffer text) following
// redirects. Small reusable promise over https.get with a redirect cap and
// an overall timeout. HTTPS only: downloads must not be tampered with in
// transit.

const fs = require('fs');
const https = require('https');
const { URL } = require('url');

const REDIRECT_CODES = new Set([301, 302, 303, 307, 308]);
const DEFAULT_TIMEOUT_MS = 120000;
/**
 * @param {{ maxRedirects?: number, timeoutMs?: number, headers?: Object,
 *           onProgress?: ((received: number, total: number, chunkLength: number) => void) }} [options]
 */
function downloadToFile(url, destPath, options = {}) {
  const { maxRedirects = 5, timeoutMs = DEFAULT_TIMEOUT_MS, headers, onProgress } = options;
  return new Promise((resolve, reject) => {
    const go = (current, redirectsLeft) => {
      let parsed;
      try {
        parsed = new URL(current);
      } catch (_) {
        reject(new Error('Invalid download URL'));
        return;
      }
      if (parsed.protocol !== 'https:') {
        reject(new Error('Only HTTPS downloads are allowed'));
        return;
      }

      const req = https.get(current, { headers }, (res) => {
        const { statusCode, headers: resHeaders } = res;
        if (REDIRECT_CODES.has(statusCode) && resHeaders.location) {
          res.resume();
          if (redirectsLeft <= 0) {
            reject(new Error('Too many redirects'));
            return;
          }
          go(new URL(resHeaders.location, current).toString(), redirectsLeft - 1);
          return;
        }
        if (statusCode < 200 || statusCode >= 300) {
          res.resume();
          reject(new Error(`HTTP ${statusCode}`));
          return;
        }
        const out = fs.createWriteStream(destPath);
        if (onProgress) {
          const total = parseInt(resHeaders['content-length'] || '0', 10);
          let received = 0;
          res.on('data', (chunk) => {
            received += chunk.length;
            onProgress(received, total, chunk.length);
          });
        }
        res.pipe(out);
        // A socket-level error mid-body (RST, TLS reset, proxy hang-up) emits
        // 'error' on res after the 2xx headers — without a listener that
        // crashes the main process and the promise never settles.
        res.on('error', (err) => {
          try { fs.unlinkSync(destPath); } catch (_) { /* nothing written */ }
          reject(err);
        });
        out.on('error', (err) => {
          try { fs.unlinkSync(destPath); } catch (_) { /* nothing written */ }
          reject(err);
        });
        out.on('close', () => resolve(destPath));
      });

      req.on('error', reject);
      req.setTimeout(timeoutMs, () => {
        req.destroy(new Error('Download timed out'));
      });
    };
    go(url, maxRedirects);
  });
}

/**
 * @param {{ maxRedirects?: number, timeoutMs?: number, headers?: Object }} [options]
 */

function getText(url, options = {}) {
  const { maxRedirects = 5, timeoutMs = DEFAULT_TIMEOUT_MS, headers } = options;
  return new Promise((resolve, reject) => {
    const go = (current, redirectsLeft) => {
      let parsed;
      try {
        parsed = new URL(current);
      } catch (_) {
        reject(new Error('Invalid download URL'));
        return;
      }
      if (parsed.protocol !== 'https:') {
        reject(new Error('Only HTTPS downloads are allowed'));
        return;
      }

      const req = https.get(current, { headers }, (res) => {
        const { statusCode, headers: resHeaders } = res;
        if (REDIRECT_CODES.has(statusCode) && resHeaders.location) {
          res.resume();
          if (redirectsLeft <= 0) {
            reject(new Error('Too many redirects'));
            return;
          }
          go(new URL(resHeaders.location, current).toString(), redirectsLeft - 1);
          return;
        }
        if (statusCode < 200 || statusCode >= 300) {
          res.resume();
          reject(new Error(`HTTP ${statusCode}`));
          return;
        }
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => resolve(data));
        res.on('error', reject);
      });

      req.on('error', reject);
      req.setTimeout(timeoutMs, () => {
        req.destroy(new Error('Download timed out'));
      });
    };
    go(url, maxRedirects);
  });
}

module.exports = { downloadToFile, getText };
