const { app, dialog } = require('electron');
const fs = require('fs');
const configService = require('./ConfigService');
const { detectPrivateIpRange, RANGE_LABELS } = require('../../shared/privateIp');
const { writeFileAtomic, readJsonOrQuarantine } = require('../../shared/atomicWrite');
const { getTrustedCertificatesPath, getLegacyPathCandidates, migrateLegacyFile } = require('../utils/configStorage');

const DEFAULT_PRIVATE_IP_RANGES = {
  loopback: false,
  rfc1918: false,
  linkLocal: false,
  cgnat: false,
  ipv6Loopback: false,
  ipv6Ula: false,
  ipv6LinkLocal: false,
};

class CertificateService {
  constructor() {
    this.acceptedCertificates = {};
    this.certsPath = null;
    this.autoDenyCertErrors = false;
    this.privateIpRanges = { ...DEFAULT_PRIVATE_IP_RANGES };
    this._saveBlocked = false;
    // Hosts let through with an invalid certificate on this run. Chromium
    // keeps that exception for the session, so pages there may be MITM'd.
    this._certErrorHosts = new Set();
  }

  /** True when a connection to `host` was allowed despite a certificate error on this run. */
  hasCertificateException(host) {
    return this._certErrorHosts.has(String(host || '').toLowerCase());
  }

  _allow(host, callback) {
    this._certErrorHosts.add(host.toLowerCase());
    callback(true);
  }

  initialize() {
    this.certsPath = getTrustedCertificatesPath();
    migrateLegacyFile(
      this.certsPath,
      getLegacyPathCandidates('trusted_certificates.json')
    );
    this.autoDenyCertErrors = configService.get('settings.autoDenyCertErrors', false);
    this.privateIpRanges = {
      ...DEFAULT_PRIVATE_IP_RANGES,
      ...(configService.get('settings.autoAcceptCertsForPrivateIps', null) || {}),
    };
    this._loadFromDisk();
    this._registerCertErrorHandler();
  }

  setAutoDeny(enabled) {
    this.autoDenyCertErrors = enabled;
    configService.set('settings.autoDenyCertErrors', enabled);
  }

  setPrivateIpRanges(ranges) {
    this.privateIpRanges = { ...DEFAULT_PRIVATE_IP_RANGES, ...(ranges || {}) };
    configService.set('settings.autoAcceptCertsForPrivateIps', { ...this.privateIpRanges });
  }

  // Returns the enabled-range name if `host` is a private IP and that range
  // is opted-in, else null. Pure read of current state.
  _matchedPrivateRange(host) {
    const range = detectPrivateIpRange(host);
    if (!range) return null;
    return this.privateIpRanges[range] ? range : null;
  }

  _loadFromDisk() {
    if (!this.certsPath) return;
    const { value, blocked } = readJsonOrQuarantine(fs, this.certsPath, 'CertificateService');
    this._saveBlocked = Boolean(blocked);
    if (value && typeof value === 'object' && !Array.isArray(value)) this.acceptedCertificates = value;
  }

  _saveToDisk() {
    if (!this.certsPath) return;
    if (this._saveBlocked) {
      console.error('[CertificateService] save skipped: trusted certificates file could not be loaded or moved aside');
      return;
    }
    try {
      writeFileAtomic(fs, this.certsPath, JSON.stringify(this.acceptedCertificates, null, 2));
    } catch (error) {
      console.error('Failed to save accepted certificates:', error);
    }
  }

  _registerCertErrorHandler() {
    app.on('certificate-error', (event, _webContents, url, error, certificate, callback) => {
      event.preventDefault();

      let host;
      try {
        host = new URL(url).hostname;
      } catch (_) {
        console.error('Certificate error handler: malformed URL:', url);
        callback(false);
        return;
      }
      const fingerprint = certificate.fingerprint;

      // Check if already accepted
      if (this.acceptedCertificates[host] && this.acceptedCertificates[host] === fingerprint) {
        this._allow(host, callback);
        return;
      }

      // Auto-accept for opted-in private IP ranges. Only applied when the
      // host isn't already in a fingerprint-mismatch state — if a cert
      // *changes* on a known LAN host we still warn, since that's the
      // signal worth surfacing (MITM, replaced device, etc.).
      const knownDifferentCert = this.acceptedCertificates[host]
        && this.acceptedCertificates[host] !== fingerprint;
      if (!knownDifferentCert) {
        const matchedRange = this._matchedPrivateRange(host);
        if (matchedRange) {
          console.log(`Certificate auto-accepted for ${host} (${matchedRange})`);
          this.acceptedCertificates[host] = fingerprint;
          this._saveToDisk();
          this._allow(host, callback);
          return;
        }
      }

      // Auto-deny if setting is enabled
      if (this.autoDenyCertErrors) {
        console.log(`Certificate auto-denied for ${host}`);
        callback(false);
        return;
      }

      const isMismatch = knownDifferentCert;
      const message = isMismatch
        ? `WARNING: The certificate for ${host} has CHANGED!\n\nThis could indicate a security issue.\n\nOld fingerprint: ${this.acceptedCertificates[host]}\nNew fingerprint: ${fingerprint}\n\nError: ${error}`
        : `Certificate error for ${host}\n\nError: ${error}\nFingerprint: ${fingerprint}`;

      dialog
        .showMessageBox(null, {
          type: isMismatch ? 'warning' : 'question',
          title: isMismatch ? 'Certificate Changed' : 'Certificate Error',
          message,
          detail: 'Choose "Always Deny" to silently reject invalid certificates from now on (the cert-error setting will be turned on).',
          buttons: ['Accept', 'Reject', 'Always Deny'],
          defaultId: isMismatch ? 1 : 0,
          cancelId: 1,
        })
        .then(({ response }) => {
          if (response === 0) {
            this.acceptedCertificates[host] = fingerprint;
            this._saveToDisk();
            this._allow(host, callback);
          } else if (response === 2) {
            // "Always Deny" — reject this connection AND enable the
            // auto-deny setting so future cert errors no-op silently.
            this.setAutoDeny(true);
            callback(false);
          } else {
            callback(false);
          }
        })
        .catch(() => {
          callback(false);
        });
    });
  }
}

const instance = new CertificateService();
module.exports = instance;
module.exports.DEFAULT_PRIVATE_IP_RANGES = DEFAULT_PRIVATE_IP_RANGES;
module.exports.RANGE_LABELS = RANGE_LABELS;
