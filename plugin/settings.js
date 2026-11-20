/*
 * DS Note — settings page.
 *
 * Two stores, deliberately separate:
 *   /kv       non-secret configuration (address, account, switches)
 *   /secrets  the DSM password, write-only; the host never gives the value back
 *
 * Nothing here talks to the NAS: this page has no Node access, and the point of
 * the worker is that only it does.
 */
const $ = (id) => document.getElementById(id);
const { channel, call } = globalThis.dsNoteBrain;

const PASSWORD_KEY = 'dsm_password';

const CERT_HINTS = {
  verify:
    'The NAS certificate is checked the normal way: chain, expiry and name. Use this when the NAS has a ' +
    'real certificate and you reach it by a name that certificate covers.',
  name:
    'Use this when the NAS has a real certificate but you reach it by an address the certificate does not ' +
    'name — a LAN IP, a Tailscale address, a VPN. The certificate is still verified properly; only the ' +
    'name check is pointed at the name you enter.',
  file:
    'Export the certificate from DSM (Control Panel → Security → Certificate → Export) and point at the ' +
    'file. The chain is validated against that certificate, with normal verification on.',
  pin:
    'The NAS must present exactly this certificate. Weaker than the two options above: it compares a ' +
    'fingerprint rather than validating the chain.',
  none:
    'Anything answering on that address is accepted. Only for a NAS you cannot verify any other way.',
};

const CERT_WARNINGS = {
  none:
    'The NAS certificate will not be checked, so anything answering on that address could receive the ' +
    'DSM password. Use this only on a network you control.',
};

function setStatus(text, tone) {
  const status = $('status');
  status.textContent = text;
  status.style.color = tone === 'error' ? 'var(--danger, #b3261e)' : '';
}

/* --------------------------------------------------------- certificate --- */

function applyCertMode() {
  const mode = $('certMode').value;
  $('cert-name-field').style.display = mode === 'name' ? 'flex' : 'none';
  $('cert-file-field').style.display = mode === 'file' ? 'flex' : 'none';
  $('cert-pin-field').style.display = mode === 'pin' ? 'flex' : 'none';
  $('cert-hint').textContent = CERT_HINTS[mode] ?? '';
  const warning = CERT_WARNINGS[mode];
  $('cert-warning').hidden = !warning;
  $('cert-warning').textContent = warning ?? '';
}

/** Which of the five options the stored configuration corresponds to. */
function certModeFromConfig(config) {
  if (config.certificateName) return 'name';
  if (config.certificate) return 'file';
  if (config.certificateFingerprint) return 'pin';
  if (config.allowSelfSigned === true) return 'none';
  return 'verify';
}

/* ---------------------------------------------------------------- mode --- */

function applyMode() {
  const mode = $('mode').value;
  const isDirect = mode === 'direct';
  const isAuto = mode === 'auto';
  $('direct-fields').style.display = isDirect ? 'flex' : 'none';
  $('auto-fields').style.display = isAuto ? 'block' : 'none';
  $('port-row').style.display = isAuto ? 'flex' : 'none';
  $('https-row').style.display = isDirect || isAuto ? 'flex' : 'none';
  $('quickconnect-fields').style.display = isDirect ? 'none' : 'block';
}

/* ---------------------------------------------------------------- load --- */

async function loadConfig() {
  let config = {};
  try {
    const response = await fetch('/kv');
    config = response.ok ? await response.json() : {};
  } catch {
    config = {};
  }

  $('mode').value = ['auto', 'direct', 'quickconnect', 'portal'].includes(config.mode)
    ? config.mode
    : 'direct';
  $('hosts').value = Array.isArray(config.hosts) ? config.hosts.join('\n') : '';
  $('host').value = config.host || '';
  $('port').value = config.port || 5001;
  $('port-auto').value = config.port || 5001;
  $('https').checked = config.https !== false;
  $('quickConnectId').value = config.quickConnectId || '';
  $('account').value = config.account || '';
  $('allowRaw').checked = Boolean(config.allowRaw);

  $('certMode').value = certModeFromConfig(config);
  $('certificateName').value = config.certificateName || '';
  $('certificate').value = config.certificate || '';
  $('certificateFingerprint').value = config.certificateFingerprint || '';

  applyMode();
  applyCertMode();
}

async function loadSecretState() {
  const state = $('password-state');
  try {
    const response = await fetch('/secrets');
    const list = response.ok ? await response.json() : [];
    const entry = Array.isArray(list) ? list.find((item) => item.key === PASSWORD_KEY) : null;
    if (entry?.saved) {
      state.textContent = entry.tail
        ? `A password is saved (ends ${entry.tail}). Leave the field empty to keep it.`
        : 'A password is saved. Leave the field empty to keep it.';
    } else {
      state.textContent = 'No password saved yet.';
    }
  } catch {
    state.textContent = '';
  }
}

/* ---------------------------------------------------------------- save --- */

async function savePassword() {
  const value = $('password').value;
  if (!value) {
    setStatus('Type a password first.', 'error');
    return;
  }
  try {
    const response = await fetch(`/secrets/${PASSWORD_KEY}`, {
      method: 'PUT',
      body: JSON.stringify({ value }),
    });
    if (!response.ok) {
      setStatus(`Could not save the password (HTTP ${response.status}).`, 'error');
      return;
    }
    $('password').value = '';
    setStatus('Password saved.');
    await loadSecretState();
    channel.postMessage({ type: 'settings-changed' });
  } catch (error) {
    setStatus(`Could not save the password: ${error.message}`, 'error');
  }
}

async function saveConfig() {
  const mode = $('mode').value;
  const config = {
    mode,
    account: $('account').value.trim(),
    allowRaw: $('allowRaw').checked,
  };
  const otpCode = $('otpCode')?.value.trim();
  // Only sent when the user typed one: DSM treats it as single-use, and the
  // worker only needs it until the device is trusted.
  if (otpCode) config.otpCode = otpCode;

  if (mode === 'auto') {
    config.hosts = $('hosts')
      .value.split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
    config.port = Number($('port-auto').value) || 5001;
    config.https = $('https').checked;
    config.quickConnectId = $('quickConnectId').value.trim();
  } else if (mode === 'direct') {
    config.host = $('host').value.trim();
    config.port = Number($('port').value) || 5001;
    config.https = $('https').checked;
  } else {
    config.quickConnectId = $('quickConnectId').value.trim();
  }

  // Exactly one certificate decision is stored. Writing only the chosen one
  // means a leftover fingerprint or path can never quietly override it.
  const certMode = $('certMode').value;
  if (certMode === 'name') {
    const name = $('certificateName').value.trim();
    if (!name) {
      setStatus('The certificate name is required for this option.', 'error');
      return false;
    }
    config.certificateName = name;
  } else if (certMode === 'file') {
    const file = $('certificate').value.trim();
    if (!file) {
      setStatus('The certificate file path is required for this option.', 'error');
      return false;
    }
    config.certificate = file;
  } else if (certMode === 'pin') {
    const pin = $('certificateFingerprint').value.trim();
    if (!pin) {
      setStatus('The certificate fingerprint is required for this option.', 'error');
      return false;
    }
    config.certificateFingerprint = pin;
  } else if (certMode === 'none') {
    config.allowSelfSigned = true;
  }

  if (!config.account) {
    setStatus('The DSM account is required.', 'error');
    return false;
  }
  if (mode === 'direct' && !config.host) {
    setStatus('The NAS address is required for a direct connection.', 'error');
    return false;
  }
  if (mode === 'auto' && config.hosts.length === 0 && !config.quickConnectId) {
    setStatus('List at least one address, or give a QuickConnect ID as the fallback.', 'error');
    return false;
  }
  if ((mode === 'quickconnect' || mode === 'portal') && !config.quickConnectId) {
    setStatus('The QuickConnect ID is required for this mode.', 'error');
    return false;
  }

  try {
    const response = await fetch('/kv', { method: 'PUT', body: JSON.stringify(config) });
    if (!response.ok) {
      setStatus(`Could not save (HTTP ${response.status}).`, 'error');
      return false;
    }
    setStatus('Saved.');
    channel.postMessage({ type: 'settings-changed' });
    return true;
  } catch (error) {
    setStatus(`Could not save: ${error.message}`, 'error');
    return false;
  }
}

/* ---------------------------------------------------------------- test --- */

function showTest(headline, detail, tone) {
  $('test-result').hidden = false;
  $('test-headline').textContent = headline;
  $('test-headline').style.color =
    tone === 'error' ? 'var(--danger, #b3261e)' : 'var(--success, #2e7d32)';
  $('test-detail').textContent = detail || '';
}

const CERT_LABELS = {
  'verified-by-name': 'certificate verified by name',
  'certificate-file': 'chain verified against your file · hostname not checked',
  pinned: 'certificate pinned by fingerprint',
  'accepted-unverified': 'certificate NOT checked',
  verified: 'certificate verified normally',
};

async function testConnection() {
  const saved = await saveConfig();
  if (!saved) {
    showTest('Not saved yet', 'Fix the field above, then test again.', 'error');
    return;
  }
  const button = $('test');
  button.disabled = true;
  showTest('Testing…', 'Connecting to the NAS.', null);
  try {
    await globalThis.dsNoteBrain.wake();
    const status = await call('dsnote_status');
    const counts = status.counts || {};
    const route = status.connection?.route || 'direct';
    const certificate = status.certificate || {};
    const dsm = status.dsm ? `${status.dsm.model} · ${status.dsm.version}` : 'DSM version unknown';
    showTest(
      'Connected',
      `${dsm} · route: ${route}${status.connection?.fallback ? ' (fallback)' : ''} · ` +
        `${CERT_LABELS[certificate.mode] ?? certificate.mode} · ` +
        `${counts.notebooks ?? 0} notebooks · ${counts.notes ?? 0} notes · ${counts.todos ?? 0} tasks` +
        (status.session?.csrfToken ? '' : ' · warning: no CSRF token, writes will fail'),
      'ok',
    );
    // The one-time code is single-use and must not linger in the settings.
    if ($('otpCode')?.value.trim()) {
      $('otpCode').value = '';
      try {
        const current = await (await fetch('/kv')).json();
        await fetch('/kv', {
          method: 'PUT',
          body: JSON.stringify({ ...current, otpCode: null }),
        });
        $('otp-state').textContent = 'Code used and cleared. DSM now trusts this device.';
      } catch {
        $('otp-state').textContent = 'Connected, but the one-time code could not be cleared. Remove it from /kv.';
      }
    }
  } catch (error) {
    showTest('Not connected', error.message, 'error');
  } finally {
    button.disabled = false;
  }
}

/* -------------------------------------------------------------- wiring --- */

$('mode').addEventListener('change', applyMode);
$('certMode').addEventListener('change', applyCertMode);
$('save').addEventListener('click', saveConfig);
$('test').addEventListener('click', testConnection);
$('save-password').addEventListener('click', savePassword);

loadConfig();
loadSecretState();
