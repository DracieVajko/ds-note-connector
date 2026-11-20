/**
 * One place that decides how a certificate is trusted.
 *
 * Five modes, strongest first:
 *   verified-by-name      chain + name checked against a name you supply
 *   certificate-file      chain checked against the certificate you exported
 *   pinned                one certificate accepted by fingerprint
 *   accepted-unverified   anything accepted (warned about, opt-in)
 *   verified              ordinary public-CA verification
 *
 * These four fields used to be assembled by hand in five places, and the
 * resulting label was derived in three, which is how they drifted apart.
 */
export const CERTIFICATE_MODES = [
  'verified',
  'verified-by-name',
  'certificate-file',
  'pinned',
  'accepted-unverified',
];

/** The mode a configuration resolves to. Precedence is deliberate. */
export function certificateMode(config = {}) {
  if (config.certificateName) return 'verified-by-name';
  if (config.certificate) return 'certificate-file';
  if (config.certificateFingerprint) return 'pinned';
  if (config.allowSelfSigned === true) return 'accepted-unverified';
  return 'verified';
}

/** The transport fields every request needs, from a resolved configuration. */
export function transportOptions(config = {}) {
  return {
    allowSelfSigned: config.allowSelfSigned === true,
    pinnedFingerprint: config.certificateFingerprint || undefined,
    serverName: config.certificateName || undefined,
    ca: config.ca || undefined,
  };
}
