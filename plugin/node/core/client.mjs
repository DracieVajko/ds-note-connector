/**
 * The DSM transport: one `entry.cgi` call, done correctly.
 *
 * Three things here are load-bearing and easy to get wrong:
 *
 *  1. Path. `SYNO.NoteStation.*` lives at `/notestation/webapi/entry.cgi`.
 *     Calling it on the core endpoint fails.
 *  2. Encoding. NoteStation APIs take JSON literals, core APIs take bare
 *     form fields. See encoding.mjs.
 *  3. Version. We pin a version per method instead of taking the advertised
 *     maximum: `SYNO.NoteStation.Note` advertises up to v4, but `list` at v4
 *     takes a different parameter shape than the v3 every capture shows.
 *     "Newest" is not the same as "the one that works".
 */
import { encodeJsonValue, encodeNoteStationBody, encodePlainBody } from './encoding.mjs';
import { entryPathFor, coreQueryPath } from './endpoint.mjs';
import { DsmError, errorFromEnvelope, isSessionError } from './errors.mjs';
import { httpRequest, postForm, postMultipart } from './http.mjs';
import { AuthSession } from './auth.mjs';

/**
 * Version per (api, method). Anything absent falls back to `defaultVersion`
 * below rather than to the server's advertised maximum.
 */
export const PINNED_VERSIONS = {
  'SYNO.NoteStation.Notebook': { list: 2, create: 2, update: 2, delete: 2, default: 2 },
  'SYNO.NoteStation.Note': { list: 3, get: 3, create: 3, set: 3, delete: 3, restore: 3, copy: 3, download: 3, default: 3 },
  'SYNO.NoteStation.Tag': { list: 2, create: 2, default: 2 },
  'SYNO.NoteStation.Todo': { list: 2, create: 2, set: 2, delete: 1, default: 2 },
  'SYNO.NoteStation.FTS': { search: 1, default: 1 },
  'SYNO.NoteStation.Note.Version': { list: 2, restore: 2, default: 2 },
  'SYNO.NoteStation.Info': { get: 2, default: 2 },
  'SYNO.NoteStation.Smart': { list: 1, create: 1, default: 1 },
  'SYNO.NoteStation.Stack': { list: 1, default: 1 },
  'SYNO.NoteStation.Shortcut': { list: 1, default: 1 },
  'SYNO.NoteStation.Setting': { get: 1, init: 1, default: 1 },
  'SYNO.NoteStation.Shard.Link': { get: 1, default: 1 },
  'SYNO.NoteStation.Share.Priv': { list: 2, default: 2 },
  'SYNO.NoteStation.Note.Encrypt': { create: 1, check: 1, default: 1 },
  'SYNO.API.Info': { query: 1, default: 1 },
  'SYNO.API.Auth': { login: 7, logout: 1, default: 7 },
  'SYNO.DSM.Info': { getinfo: 2, default: 2 },
};

/**
 * Codes that mean the connection was never established, so nothing was sent.
 *
 * A reset, a pipe error or a timeout is deliberately absent: the request may
 * already have reached the NAS, and replaying it could create the note or the
 * task twice.
 */
const NEVER_CONNECTED_CODES = new Set([
  'ECONNREFUSED', 'EHOSTUNREACH', 'ENETUNREACH', 'ENOTFOUND', 'EAI_AGAIN', 'ENETDOWN', 'EHOSTDOWN',
]);

export function neverConnected(error) {
  if (!error) return false;
  if (error.code && NEVER_CONNECTED_CODES.has(String(error.code))) return true;
  return /ECONNREFUSED|could not connect|getaddrinfo/i.test(error.message || '');
}

/**
 * True when the route looks dead (worth re-resolving and reporting), which is a
 * wider set than "safe to retry".
 */
export function isUnreachable(error) {
  if (neverConnected(error)) return true;
  if (!error) return false;
  if (error.code && ['ECONNRESET', 'ECONNABORTED', 'ETIMEDOUT', 'EPIPE'].includes(String(error.code))) {
    return true;
  }
  return /socket hang up|socket was closed|connection reset|TLS handshake/i.test(error.message || '');
}

export function versionFor(api, method) {
  const table = PINNED_VERSIONS[api];
  if (!table) return 1;
  return table[method] ?? table.default ?? 1;
}

export class DsmClient {
  #apis = null;
  /**
   * Which base path this NAS actually serves the NoteStation APIs on.
   *
   * Captured traffic shows `/notestation/webapi/entry.cgi`, and that is what
   * the stock client uses. But a QuickConnect relay (and possibly some DSM
   * builds) does not forward the package-local path and answers with an HTML
   * page, while the same APIs are served fine on the core endpoint. Rather
   * than pick a side, try the documented one and fall back to the other,
   * then remember which answered. Guessing wrong costs one round trip, once.
   */
  #notePath = null;

  constructor({
    endpoint,
    credentials,
    tls = {},
    timeoutMs = 20000,
    logger,
    request = httpRequest,
    post = postForm,
    session,
    reconnect,
  }) {
    this.endpoint = endpoint;
    // In auto mode the NAS can answer on a different address tomorrow (DHCP,
    // VPN, a relay). The owner of the configuration supplies this hook so a
    // dead route is re-resolved instead of being retried forever.
    this.reconnect = reconnect;
    this.timeoutMs = timeoutMs;
    this.logger = logger;
    this.request = request;
    this.post = post;
    this.tls = {
      allowSelfSigned: tls.allowSelfSigned ?? endpoint.allowSelfSigned ?? false,
      pinnedFingerprint: tls.pinnedFingerprint,
      serverName: tls.serverName,
      ca: tls.ca,
    };
    this.session =
      session ??
      new AuthSession({
        endpoint,
        credentials,
        tls: this.tls,
        timeoutMs,
        logger,
        request,
        post,
      });
  }

  async connect() {
    await this.session.login();
    return this;
  }

  /** Candidate URLs for a NoteStation call, most likely first. */
  #noteStationUrls() {
    const packageUrl = `${this.endpoint.url}/notestation/webapi/entry.cgi`;
    const coreUrl = `${this.endpoint.url}/webapi/entry.cgi`;
    if (this.#notePath === 'core') return [coreUrl, packageUrl];
    return [packageUrl, coreUrl];
  }

  async #send(url, body, { api, method, allowSelfSigned } = {}) {
    const response = await this.post(url, body, {
      timeoutMs: this.timeoutMs,
      ...this.tls,
      allowSelfSigned: allowSelfSigned ?? this.tls.allowSelfSigned,
      jar: this.session.jar,
      headers: this.session.synotoken ? { 'X-SYNO-TOKEN': this.session.synotoken } : {},
    });
    if (!response.json) {
      if (response.redirectRefused) {
        const refused = new DsmError(
          `${api}.${method}: the NAS answered with a redirect to ${response.redirectRefused}, which this client refuses to follow ` +
            'because it would send the DSM session cookie to another origin or over plain http.',
          { api, method, status: response.status },
        );
        refused.kind = 'redirect';
        throw refused;
      }
      const looksLikeHtml = /^\s*</.test(response.text ?? '');
      const error = new DsmError(
        looksLikeHtml
          ? `${api}.${method} returned an HTML page instead of JSON — this endpoint does not serve the package API`
          : `${api}.${method} returned a non-JSON response (HTTP ${response.status})`,
        { api, method, status: response.status, body: response.text?.slice(0, 400) },
      );
      if (looksLikeHtml) error.kind = 'html';
      throw error;
    }
    return response;
  }

  /**
   * Call one API method.
   *
   * `json: true` (the default for NoteStation APIs) encodes values as JSON
   * literals. Pass `json: false` for core APIs.
   */
  async call(api, method, params = {}, options = {}) {
    try {
      return await this.#callOnce(api, method, params, options);
    } catch (error) {
      // Only a connection that never opened is replayed; a reset or a timeout
      // may have delivered the write already.
      if (!this.reconnect || !neverConnected(error)) throw error;
      this.logger?.debug?.(`${api}.${method}: route stopped answering (${error.code || error.message}); re-resolving`);
      await this.reconnect(this, error);
      return await this.#callOnce(api, method, params, options);
    }
  }

  async #callOnce(api, method, params = {}, options = {}) {
    const {
      version = versionFor(api, method),
      json = String(api).startsWith('SYNO.NoteStation.'),
      // Kept for embedders of core/: the tests and the probe rely on it.
      retryOnSessionError = true,
      allowSelfSigned,
      /** Return the whole envelope instead of `data` (used by diagnostics). */
      raw = false,
    } = options;

    const isNoteStation = String(api).startsWith('SYNO.NoteStation.');
    const urls = options.url
      ? [options.url]
      : isNoteStation
        ? this.#noteStationUrls()
        : [entryPathFor(api, this.endpoint)];

    await this.session.ensure();

    const build = () => {
      const envelope = { api, version, method, _sid: this.session.sid };
      return json ? encodeNoteStationBody(envelope, params) : encodePlainBody({ ...envelope, ...params });
    };

    let lastError = null;
    for (let index = 0; index < urls.length; index += 1) {
      const url = urls[index];
      const hasAnother = index < urls.length - 1;
      let response;
      try {
        response = await this.#send(url, build(), { api, method, allowSelfSigned });
      } catch (error) {
        // An HTML answer means "this path is not the API here", so the other
        // candidate is worth one try before reporting a failure.
        if (error.kind === 'html' && hasAnother) {
          lastError = error;
          continue;
        }
        // A transport failure (timeout, reset) says nothing about the session,
        // and the server may already have applied the write. Replaying it would
        // risk doing it twice, so it is reported as it is.
        throw error;
      }

      const envelope = response.json;
      if (!envelope.success) {
        const error = errorFromEnvelope(envelope, { api, method, status: response.status });
        // "API does not exist" on this path is the same signal as HTML.
        if (error.code === 102 && hasAnother) {
          lastError = error;
          continue;
        }
        if (retryOnSessionError && isSessionError(error)) {
          this.logger?.debug?.(`${api}.${method} session error ${error.code}, re-authenticating`);
          await this.session.login();
          const retry = await this.#send(url, build(), { api, method, allowSelfSigned });
          if (!retry.json.success) {
            throw errorFromEnvelope(retry.json, { api, method, status: retry.status });
          }
          if (isNoteStation) this.#notePath = url.includes('/notestation/') ? 'package' : 'core';
          return raw ? retry.json : retry.json.data;
        }
        throw error;
      }

      if (isNoteStation) this.#notePath = url.includes('/notestation/') ? 'package' : 'core';
      return raw ? envelope : envelope.data;
    }
    throw lastError ?? new DsmError(`${api}.${method} failed on every known endpoint`, { api, method });
  }

  /**
   * A multipart call.
   *
   * An attachment is uploaded by re-sending `Note.set` as multipart/form-data;
   * there is no separate upload endpoint. This one call puts the envelope on
   * the query string instead of the body, which is what the stock client does.
   */
  async callMultipart(api, method, options = {}) {
    try {
      return await this.#callMultipartOnce(api, method, options);
    } catch (error) {
      if (!this.reconnect || !neverConnected(error)) throw error;
      await this.reconnect(this, error);
      return await this.#callMultipartOnce(api, method, options);
    }
  }

  async #callMultipartOnce(api, method, { params = {}, files = [], version = versionFor(api, method) } = {}) {
    await this.session.ensure();
    // The session and the CSRF token ride on the query string for this call as
    // well as in the body. A reverse proxy in front of the NAS (QuickConnect
    // relay) does not always forward the header, and a missing token reads as
    // error 105 "not logged in".
    const query = encodePlainBody({
      api,
      version,
      method,
      _sid: this.session.sid,
      ...(this.session.synotoken ? { SynoToken: this.session.synotoken } : {}),
    });
    const fields = { _sid: this.session.sid };
    for (const [key, value] of Object.entries(params)) {
      const encoded = encodeJsonValue(value);
      if (encoded !== undefined) fields[key] = encoded;
    }

    let lastError = null;
    const urls = this.#noteStationUrls();
    for (let index = 0; index < urls.length; index += 1) {
      const url = `${urls[index]}?${query}`;
      // A transport failure is reported as-is: an upload is a write that may
      // already have landed, so it is never re-posted to the other path.
      const response = await postMultipart(
        url,
        { fields, files },
        {
          timeoutMs: Math.max(this.timeoutMs, 60000),
          ...this.tls,
          jar: this.session.jar,
          headers: this.session.synotoken ? { 'X-SYNO-TOKEN': this.session.synotoken } : {},
        },
      );
      if (!response.json) {
        if (response.redirectRefused) {
          const refused = new DsmError(
            `${api}.${method}: the NAS answered the upload with a redirect to ${response.redirectRefused}, ` +
              'which this client refuses to follow because it would send the DSM session cookie to another origin or over plain http.',
            { api, method, status: response.status },
          );
          refused.kind = 'redirect';
          throw refused;
        }
        // Only "this path is not the API here" (an HTML page) is worth the
        // other candidate; anything else stays a report, because the upload is
        // a write that may have been applied.
        if (/^\s*</.test(response.text ?? '') && index < urls.length - 1) continue;
        throw new DsmError(`${api}.${method} returned a non-JSON response to an upload (HTTP ${response.status})`, {
          api,
          method,
          status: response.status,
          body: response.text?.slice(0, 400),
        });
      }
      if (!response.json.success) {
        const error = errorFromEnvelope(response.json, { api, method, status: response.status });
        if (error.code === 102 && index < urls.length - 1) {
          lastError = error;
          continue;
        }
        throw error;
      }
      this.#notePath = urls[index].includes('/notestation/') ? 'package' : 'core';
      return response.json.data;
    }
    throw lastError ?? new DsmError(`${api}.${method} upload failed`, { api, method });
  }

  /** The certificate the NAS presented, so the user can record it. */
  get peerFingerprint() {
    return this.session.peerFingerprint ?? null;
  }

  /** Which base path answered, for diagnostics. Not sensitive. */
  get noteStationPath() {
    return this.#notePath ?? 'unknown';
  }

  /**
   * After a route change everything learned from the old address is void: the
   * package path and the API discovery both describe the NAS we left.
   */
  forgetNotePath() {
    this.#notePath = null;
    this.#apis = null;
  }

  /** Which NoteStation APIs this NAS actually exposes. */
  async discover() {
    if (this.#apis) return this.#apis;
    await this.session.ensure();
    const params = new URLSearchParams({
      api: 'SYNO.API.Info',
      version: '1',
      method: 'query',
      query: 'all',
      _sid: this.session.sid,
    });
    const response = await this.request(`${coreQueryPath(this.endpoint)}?${params.toString()}`, {
      timeoutMs: this.timeoutMs,
      ...this.tls,
      jar: this.session.jar,
    });
    if (!response.json?.success) {
      throw errorFromEnvelope(response.json ?? {}, { api: 'SYNO.API.Info', method: 'query' });
    }
    const all = response.json.data ?? {};
    this.#apis = Object.fromEntries(
      Object.entries(all).filter(([name]) => name.startsWith('SYNO.NoteStation.')),
    );
    return this.#apis;
  }

  /** The DSM's own version string, useful in a status report. */
  async dsmInfo() {
    try {
      return await this.call('SYNO.DSM.Info', 'getinfo', {}, { json: false });
    } catch (error) {
      this.logger?.debug?.(`dsmInfo failed: ${error.message}`);
      return null;
    }
  }

  async logout() {
    await this.session.logout();
  }
}
