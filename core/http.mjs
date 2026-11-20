/**
 * Minimal HTTP client: node:https / node:http, a cookie jar, and nothing else.
 *
 * No dependencies on purpose — this same module runs inside the Cindy plugin,
 * inside an MCP stdio server, and on a NAS in Docker.
 */
import http from 'node:http';
import https from 'node:https';
import { checkServerIdentity as tlsCheckServerIdentity } from 'node:tls';
import { URL } from 'node:url';

/**
 * Strip the address out of a network error message.
 *
 * Node reports timeouts, DNS failures and TLS mismatches with the hostname (or
 * the relay IP) inline. That text travels into a tool result, so it is reduced
 * here — the shape of the failure survives, the address does not.
 */
export function sanitizeNetworkMessage(message) {
  return String(message)
    .replace(/\b\d{1,3}(?:\.\d{1,3}){3}\b/g, '«ip»')
    .replace(/\b[a-z0-9-]+\.quickconnect\.to\b/gi, '«nas».quickconnect.to')
    .replace(/(https?:\/\/)[^\s"'<>)\]]+/gi, '$1«host»')
    .replace(/\b(ENOTFOUND|EAI_AGAIN|EAI_FAIL|ECONNREFUSED|EHOSTUNREACH|ENETUNREACH)\s+[^\s,;)]+/g, '$1 «host»')
    .replace(/\b(?:Hostname\/IP|hostname|host|IP address)\s*[:=]\s*[^\s,;)]+/gi, '«host»');
}

/**
 * Options for verifying against one specific certificate.
 *
 * The chain is validated for real — signature, validity, everything — but the
 * hostname check is skipped on purpose: identity comes from the certificate we
 * supplied, and a NAS certificate almost never covers the address we dial (an
 * IP, or a QuickConnect relay address).
 */
function certificateNameOptions(name) {
  return {
    checkServerIdentity: (_host, certificate) => tlsCheckServerIdentity(name, certificate),
  };
}

function trustedCertificateOptions(pem) {
  return { ca: [pem], checkServerIdentity: () => undefined };
}

function isIpLiteral(host) {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(':');
}

/** `AB:CD:…` and `abcd…` are the same fingerprint. */
export function normalizeFingerprint(value) {
  return String(value ?? '')
    .replace(/[^0-9a-fA-F]/g, '')
    .toUpperCase();
}

export class CookieJar {
  #cookies = new Map();
  #origin = null;

  /**
   * A jar belongs to one origin. Without that binding a redirect or an
   * endpoint change would carry the DSM session cookie to another host, or to
   * the same host over plain http after an https response — the two ways a
   * session cookie leaks without anyone noticing.
   */
  constructor(origin = null) {
    this.#origin = origin ? String(origin) : null;
  }

  #allows(origin) {
    if (!this.#origin || !origin) return true;
    return this.#origin === String(origin);
  }

  /** Feed a `set-cookie` header (string or array) back into the jar. */
  absorb(setCookie, origin) {
    if (!setCookie || !this.#allows(origin)) return;
    const list = Array.isArray(setCookie) ? setCookie : [setCookie];
    for (const raw of list) {
      const [pair] = String(raw).split(';');
      const eq = pair.indexOf('=');
      if (eq <= 0) continue;
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      if (!name) continue;
      if (value === '' || value === 'deleted') this.#cookies.delete(name);
      else this.#cookies.set(name, value);
    }
  }

  header(origin) {
    if (!this.#allows(origin)) return undefined;
    if (this.#cookies.size === 0) return undefined;
    return [...this.#cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
  }

  get(name) {
    return this.#cookies.get(name);
  }

  get size() {
    return this.#cookies.size;
  }

  clear() {
    this.#cookies.clear();
  }
}

/**
 * Perform one HTTP request.
 *
 * @returns {Promise<{status:number, headers:object, text:string, json:any,
 *   fingerprint?:string, redirectRefused?:string}>} `redirectRefused` is set
 *   when a redirect was not followed because it left the origin or changed the
 *   scheme; `fingerprint` is the certificate the peer presented.
 */
export function httpRequest(url, options = {}) {
  const {
    method = 'GET',
    headers = {},
    body,
    timeoutMs = 20000,
    allowSelfSigned = false,
    pinnedFingerprint,
    ca,
    serverName,
    jar,
    maxRedirects = 3,
  } = options;

  return new Promise((resolve, reject) => {
    let parsed;
    try {
      parsed = new URL(url);
    } catch (error) {
      reject(new Error(`invalid URL ${url}: ${error.message}`));
      return;
    }

    const isHttps = parsed.protocol === 'https:';
    // Computed before the request so it can also decide connection reuse.
    const expectedPin = normalizeFingerprint(pinnedFingerprint);
    const transport = isHttps ? https : http;
    const requestHeaders = { ...headers };
    const cookie = jar?.header(parsed.origin);
    if (cookie) requestHeaders.Cookie = cookie;
    if (body !== undefined && requestHeaders['Content-Length'] === undefined) {
      requestHeaders['Content-Length'] = Buffer.byteLength(body);
    }

    const request = transport.request(
      {
        protocol: parsed.protocol,
        hostname: parsed.hostname,
        port: parsed.port || (isHttps ? 443 : 80),
        path: `${parsed.pathname}${parsed.search}`,
        method,
        headers: requestHeaders,
        // Synology NAS boxes ship a self-signed certificate by default, and a
        // QuickConnect relay/tunnel address is an IP that no certificate
        // covers. Callers opt in explicitly; it is never silently enabled.
        // Three ways to trust a NAS certificate, strongest first:
        //   ca        verify the chain against that exact certificate
        //   pin       accept the certificate, then require this fingerprint
        //   allow     accept anything (the blunt, warned-about option)
        // A pin has to come with an accepted certificate, otherwise the
        // handshake fails before the fingerprint can be compared at all.
        rejectUnauthorized: ca ? true : !(allowSelfSigned || expectedPin),
        ...(ca ? trustedCertificateOptions(ca) : {}),
        ...(serverName ? certificateNameOptions(serverName) : {}),
        // A pinned certificate must be checked on every connection, so a
        // reused keep-alive socket (the default since Node 19) is not allowed
        // to skip the handshake this check depends on.
        agent: expectedPin ? false : undefined,
        // SNI is a hostname mechanism; Node refuses an IP here outright
        // ("Setting the TLS ServerName to an IP address is not permitted"),
        // which would break every LAN address and every relay route.
        servername: isHttps
          ? serverName || (isIpLiteral(parsed.hostname) ? undefined : parsed.hostname)
          : undefined,
        timeout: timeoutMs,
      },
      (response) => {
        jar?.absorb(response.headers['set-cookie'], parsed.origin);
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          const location = response.headers.location;
          if (
            maxRedirects > 0 &&
            location &&
            [301, 302, 303, 307, 308].includes(response.statusCode) &&
            method === 'GET'
          ) {
            // Only a same-origin, same-scheme redirect is safe to follow: a
            // redirect to another host would hand the session cookie over, and
            // an https -> http redirect would put it on the wire in clear.
            const target = new URL(location, parsed);
            const safe =
              target.origin === parsed.origin && target.protocol === parsed.protocol;
            if (!safe) {
              resolve({
                status: response.statusCode ?? 0,
                headers: response.headers,
                text,
                json: undefined,
                fingerprint: peerFingerprint,
                redirectRefused: target.toString(),
              });
              return;
            }
            httpRequest(target.toString(), { ...options, maxRedirects: maxRedirects - 1 })
              .then(resolve, reject);
            return;
          }
          let json;
          try {
            json = text.trim() === '' ? undefined : JSON.parse(text);
          } catch {
            json = undefined;
          }
          resolve({
            status: response.statusCode ?? 0,
            headers: response.headers,
            text,
            json,
            fingerprint: peerFingerprint,
          });
        });
      },
    );

    // Certificate pinning: with verification off, the certificate is still
    // compared against a fingerprint the user recorded once. That turns
    // "trust anything on this address" into "trust this exact certificate",
    // which is the difference between skipping verification and replacing it.
    let peerFingerprint = null;
    let sent = false;
    const sendBody = () => {
      if (sent) return;
      sent = true;
      if (body !== undefined) request.write(body);
      request.end();
    };

    const checkPeer = (socket) => {
      const certificate = socket.getPeerCertificate?.() ?? {};
      peerFingerprint = normalizeFingerprint(certificate.fingerprint256 ?? certificate.fingerprint);
      if (!expectedPin) return;
      if (peerFingerprint !== expectedPin) {
        request.destroy(
          new Error(
            'certificate fingerprint does not match the one recorded for this NAS ' +
              `(expected ${expectedPin.slice(0, 16)}…, got ${(peerFingerprint || 'none').slice(0, 16)}…)`,
          ),
        );
        return;
      }
      sendBody();
    };

    if (isHttps) {
      request.on('socket', (socket) => {
        // An already-established socket never fires secureConnect again, so
        // check it directly instead of waiting for an event that will not come.
        const certificate = socket.getPeerCertificate?.() ?? {};
        if (Object.keys(certificate).length > 0) {
          checkPeer(socket);
          return;
        }
        socket.once('secureConnect', () => checkPeer(socket));
      });
      if (!expectedPin) sendBody();
    } else {
      sendBody();
    }

    request.on('timeout', () => {
      request.destroy(
        new Error(`request timed out after ${timeoutMs}ms: ${method} ${parsed.pathname}`),
      );
    });
    request.on('error', (error) => {
      // Node's network errors carry the hostname (and TLS errors carry the
      // certificate's expected name). That text ends up in a tool result, so
      // the address is stripped here rather than trusted to stay put.
      const code = String(error?.code ?? '');
      const isTls = /CERT|TLS|SSL|EPROTO|ALTNAME|SELF_SIGNED/i.test(code);
      const hint = isTls
        ? ' — the NAS certificate could not be verified. If this NAS uses a self-signed certificate, ' +
          'turning on "accept a self-signed certificate" skips that verification, which means the DSM ' +
          'password could be read by anything answering on that address. Prefer a hostname with a real ' +
          'certificate.'
        : '';
      const message = sanitizeNetworkMessage(error?.message ?? String(error));
      const wrapped = new Error(`${message}${hint}`);
      if (code) wrapped.code = code;
      reject(wrapped);
    });
  });
}

/** POST a form body. */
export function postForm(url, body, options = {}) {
  return httpRequest(url, {
    ...options,
    method: 'POST',
    body,
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      ...(options.headers ?? {}),
    },
  });
}

/**
 * Build a multipart/form-data body.
 *
 * Note Station uploads an attachment by re-sending `Note.set` as multipart
 * instead of a form body — there is no separate upload endpoint.
 */
export function buildMultipart(fields, files = []) {
  const boundary = `----dsnote${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
  const chunks = [];
  const push = (value) => chunks.push(Buffer.from(value, 'utf8'));

  for (const [name, value] of Object.entries(fields)) {
    if (value === undefined || value === null) continue;
    push(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n`);
    push(String(value));
    push('\r\n');
  }
  for (const file of files) {
    push(
      `--${boundary}\r\nContent-Disposition: form-data; name="${file.name}"; filename="${file.filename}"\r\n` +
        `Content-Type: ${file.contentType ?? 'application/octet-stream'}\r\n\r\n`,
    );
    chunks.push(Buffer.isBuffer(file.data) ? file.data : Buffer.from(file.data));
    push('\r\n');
  }
  push(`--${boundary}--\r\n`);
  return { body: Buffer.concat(chunks), boundary };
}

export function postMultipart(url, { fields, files }, options = {}) {
  const { body, boundary } = buildMultipart(fields, files);
  return httpRequest(url, {
    ...options,
    method: 'POST',
    body,
    headers: {
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
      ...(options.headers ?? {}),
    },
  });
}
