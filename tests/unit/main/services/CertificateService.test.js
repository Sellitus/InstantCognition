const fs = require('fs');
const path = require('path');
const os = require('os');

jest.mock('electron', () => ({
  app: {
    getPath: jest.fn(() => '/mock'),
    isPackaged: false,
    on: jest.fn(),
  },
  dialog: {
    showMessageBox: jest.fn().mockResolvedValue({ response: 1 }),
  },
}));

const { app, dialog } = require('electron');

let certService;
let tmpDir;
let certsPath;

beforeEach(() => {
  jest.clearAllMocks();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ic-cert-test-'));
  certsPath = path.join(tmpDir, 'trusted_certificates.json');

  certService = require('../../../../main/services/CertificateService');
  certService.acceptedCertificates = {};
  certService.certsPath = certsPath;
  certService.autoDenyCertErrors = false;
  certService._certErrorHosts.clear();
});

afterEach(() => {
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch (_) {}
});

describe('CertificateService', () => {
  describe('Initialization', () => {
    test('starts with empty accepted certificates', () => {
      expect(certService.acceptedCertificates).toEqual({});
    });

    test('loads previously accepted certificates from disk', () => {
      const certs = { 'example.com': 'abc123' };
      fs.writeFileSync(certsPath, JSON.stringify(certs));
      certService._loadFromDisk();
      expect(certService.acceptedCertificates).toEqual(certs);
    });

    test('starts with empty certs if no file exists', () => {
      certService._loadFromDisk();
      expect(certService.acceptedCertificates).toEqual({});
    });

    test('handles corrupt cert file gracefully', () => {
      const err = jest.spyOn(console, 'error').mockImplementation(() => {});
      fs.writeFileSync(certsPath, 'invalid json');
      certService._loadFromDisk();
      expect(certService.acceptedCertificates).toEqual({});
      err.mockRestore();
    });

    test('a corrupt cert file is moved aside, so a later save keeps the original bytes', () => {
      const err = jest.spyOn(console, 'error').mockImplementation(() => {});
      fs.writeFileSync(certsPath, '{"example.com": "abc');
      certService._loadFromDisk();
      certService.acceptedCertificates['other.com'] = 'fp';
      certService._saveToDisk();
      const corrupt = fs.readdirSync(tmpDir).find((n) => n.startsWith('trusted_certificates.json.corrupt-'));
      expect(fs.readFileSync(path.join(tmpDir, corrupt), 'utf8')).toBe('{"example.com": "abc');
      expect(JSON.parse(fs.readFileSync(certsPath, 'utf8'))).toEqual({ 'other.com': 'fp' });
      err.mockRestore();
    });
  });

  describe('Certificate handling', () => {
    test('registers certificate-error handler on app', () => {
      certService._registerCertErrorHandler();
      expect(app.on).toHaveBeenCalledWith('certificate-error', expect.any(Function));
    });
  });

  describe('Persistence', () => {
    test('saves accepted certs as JSON to disk', () => {
      certService.acceptedCertificates = { 'test.com': 'fingerprint123' };
      certService._saveToDisk();

      const saved = JSON.parse(fs.readFileSync(certsPath, 'utf8'));
      expect(saved).toEqual({ 'test.com': 'fingerprint123' });
    });

    test('loads certs from disk', () => {
      const certs = { 'site.com': 'fp456' };
      fs.writeFileSync(certsPath, JSON.stringify(certs));
      certService._loadFromDisk();
      expect(certService.acceptedCertificates['site.com']).toBe('fp456');
    });
  });

  describe('Configuration', () => {
    test('setAutoDeny(true) enables auto-rejection', () => {
      certService.setAutoDeny(true);
      expect(certService.autoDenyCertErrors).toBe(true);
    });

    test('setAutoDeny(false) disables auto-rejection', () => {
      certService.autoDenyCertErrors = true;
      certService.setAutoDeny(false);
      expect(certService.autoDenyCertErrors).toBe(false);
    });

    test('setPrivateIpRanges merges with defaults', () => {
      certService.setPrivateIpRanges({ loopback: true });
      expect(certService.privateIpRanges.loopback).toBe(true);
      expect(certService.privateIpRanges.rfc1918).toBe(false);
      expect(certService.privateIpRanges.ipv6Loopback).toBe(false);
    });

    test('setPrivateIpRanges tolerates null/undefined input', () => {
      certService.setPrivateIpRanges(null);
      expect(certService.privateIpRanges.loopback).toBe(false);
      certService.setPrivateIpRanges(undefined);
      expect(certService.privateIpRanges.loopback).toBe(false);
    });
  });

  describe('Private-IP range matching', () => {
    test('_matchedPrivateRange returns range when enabled', () => {
      certService.privateIpRanges = { loopback: true };
      expect(certService._matchedPrivateRange('127.0.0.1')).toBe('loopback');
    });

    test('_matchedPrivateRange returns null when range disabled', () => {
      certService.privateIpRanges = { loopback: false };
      expect(certService._matchedPrivateRange('127.0.0.1')).toBeNull();
    });

    test('_matchedPrivateRange returns null for public hosts', () => {
      certService.privateIpRanges = { loopback: true, rfc1918: true };
      expect(certService._matchedPrivateRange('example.com')).toBeNull();
      expect(certService._matchedPrivateRange('8.8.8.8')).toBeNull();
    });
  });

  describe('Dialog Always-Deny button', () => {
    test('cert dialog buttons include "Always Deny"', async () => {
      // Replay the dialog code path by capturing the args passed to showMessageBox.
      const handler = jest.fn();
      app.on.mockImplementation((event, fn) => {
        if (event === 'certificate-error') handler.mockImplementation(fn);
      });
      certService._registerCertErrorHandler();
      // showMessageBox resolves with response: 2 => Always Deny
      dialog.showMessageBox.mockResolvedValueOnce({ response: 2 });
      const cb = jest.fn();
      handler(
        { preventDefault: () => {} },
        null,
        'https://example.com/page',
        'ERR_CERT_INVALID',
        { fingerprint: 'fp' },
        cb,
      );
      // wait for the promise chain to resolve
      await new Promise((r) => setImmediate(r));
      expect(dialog.showMessageBox).toHaveBeenCalled();
      const opts = dialog.showMessageBox.mock.calls[0][1];
      expect(opts.buttons).toEqual(['Accept', 'Reject', 'Always Deny']);
      // Always-Deny path flips auto-deny on AND denies the connection.
      expect(certService.autoDenyCertErrors).toBe(true);
      expect(cb).toHaveBeenCalledWith(false);
    });

    test('cert handler auto-accepts when host matches an enabled private range', () => {
      const handler = jest.fn();
      app.on.mockImplementation((event, fn) => {
        if (event === 'certificate-error') handler.mockImplementation(fn);
      });
      certService.privateIpRanges = { loopback: true };
      certService._registerCertErrorHandler();
      const cb = jest.fn();
      handler(
        { preventDefault: () => {} },
        null,
        'https://127.0.0.1:8443/api',
        'ERR_CERT_AUTHORITY_INVALID',
        { fingerprint: 'fp-private' },
        cb,
      );
      expect(cb).toHaveBeenCalledWith(true);
      expect(certService.acceptedCertificates['127.0.0.1']).toBe('fp-private');
      // Dialog should NOT be shown.
      expect(dialog.showMessageBox).not.toHaveBeenCalled();
    });

    test('cert handler still prompts on fingerprint mismatch for private IPs', async () => {
      const handler = jest.fn();
      app.on.mockImplementation((event, fn) => {
        if (event === 'certificate-error') handler.mockImplementation(fn);
      });
      certService.privateIpRanges = { loopback: true };
      certService.acceptedCertificates = { '127.0.0.1': 'old-fp' };
      certService._registerCertErrorHandler();
      dialog.showMessageBox.mockResolvedValueOnce({ response: 1 });
      const cb = jest.fn();
      handler(
        { preventDefault: () => {} },
        null,
        'https://127.0.0.1/',
        'ERR_CERT_AUTHORITY_INVALID',
        { fingerprint: 'new-fp' },
        cb,
      );
      await new Promise((r) => setImmediate(r));
      expect(dialog.showMessageBox).toHaveBeenCalled();
      expect(cb).toHaveBeenCalledWith(false);
    });
  });

  describe('hasCertificateException', () => {
    function fire(url, fingerprint) {
      let handler;
      app.on.mockImplementation((event, fn) => { if (event === 'certificate-error') handler = fn; });
      certService._registerCertErrorHandler();
      const cb = jest.fn();
      handler({ preventDefault: () => {} }, null, url, 'ERR_CERT_AUTHORITY_INVALID', { fingerprint }, cb);
      return cb;
    }

    test('a host the user accepted in the dialog is reported; other hosts are not', async () => {
      dialog.showMessageBox.mockResolvedValueOnce({ response: 0 });
      const cb = fire('https://bank.test/login', 'fp');
      await new Promise((r) => setImmediate(r));
      expect(cb).toHaveBeenCalledWith(true);
      expect(certService.hasCertificateException('bank.test')).toBe(true);
      expect(certService.hasCertificateException('other.test')).toBe(false);
    });

    test('a rejected host is not reported', async () => {
      dialog.showMessageBox.mockResolvedValueOnce({ response: 1 });
      fire('https://bank.test/', 'fp');
      await new Promise((r) => setImmediate(r));
      expect(certService.hasCertificateException('bank.test')).toBe(false);
    });

    test('a remembered fingerprint and an auto-accepted private IP are reported', () => {
      certService.acceptedCertificates = { 'bank.test': 'fp' };
      expect(certService.hasCertificateException('bank.test')).toBe(false);
      expect(fire('https://bank.test/', 'fp')).toHaveBeenCalledWith(true);
      expect(certService.hasCertificateException('bank.test')).toBe(true);
      certService.privateIpRanges = { rfc1918: true };
      expect(fire('https://192.168.1.5/', 'fp-lan')).toHaveBeenCalledWith(true);
      expect(certService.hasCertificateException('192.168.1.5')).toBe(true);
    });
  });
});
