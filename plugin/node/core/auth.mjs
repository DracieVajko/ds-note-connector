/**
 * DSM login, in both flavours, plus the two-factor story.
 *
 * Facts this file is built on (see docs/AUTH.md for sources):
 *  - `session=NoteStation` matters: a session opened for another package is
 *    not accepted by the Note Station APIs.
 *  - `enable_syno_token=yes` returns a CSRF token that must ride as the
 *    `X-SYNO-TOKEN` header on every write, or writes fail with 105/119.
 *  - `enable_device_token=yes` returns a `did` trusted-device token, so 2FA is
 *    asked once instead of on every login.
 *  - The portal flavour needs a cookie bootstrap against `/` and the login
 *    posted to `entry.cgi` with `logintype=local&client=browser`, because
 *    `auth.cgi` behind the portal answers with the portal HTML page.
 */
import { CookieJar, httpRequest, postForm } from './http.mjs';
import { coreAuthPath, corePath } from './endpoint.mjs';
import { AUTH_ERRORS, DsmError, NoteStationConfigError } from './errors.mjs';
import { encodePlainBody } from './encoding.mjs';

export const AUTH_SESSION_NAME = 'NoteStation';

function buildLoginParams({ account, password, otpCode, deviceId, deviceName }, flavor) {
  const params = {
    api: 'SYNO.API.Auth',
    version: '7',
    method: 'login',
    account,
    passwd: password,
    session: AUTH_SESSION_NAME,
    format: 'sid',
    enable_syno_token: 'yes',
    enable_device_token: 'yes',
    device_name: deviceName || 'DS Note Connector',
  };
  if (otpCode) params.otp_code = otpCode;
  if (deviceId) params.device_id = deviceId;
  if (flavor === 'portal') {
    // The portal only accepts the web client's own login shape.
    params.logintype = 'local';
    params.client = 'browser';
    params.rememberme = '0';
  }
  return params;
}

function loginError(envelope, { flavor }) {
  const code = envelope?.error?.code;
  const known = AUTH_ERRORS[code];
  const hint =
    code === 403 && flavor === 'portal'
      ? ' — the portal answered a login challenge; a saved device token or a fresh OTP code is needed'
      : '';
  return new DsmError(
    known
      ? `DSM login failed: ${known} (code ${code})${hint}`
      : `DSM login failed with undocumented code ${code ?? '?'}`,
    { code, api: 'SYNO.API.Auth', method: 'login', body: envelope },
  );
}

/**
 * A reusable DSM session.
 *
 * `login()` is explicit rather than lazy so a caller can report a bad
 * credential immediately instead of on the first data call.
 */
export class AuthSession {
  #loginInFlight = null;
  #sid = null;
  #synotoken = null;
  #deviceId = null;

  constructor({ endpoint, credentials, tls = {}, timeoutMs = 20000, logger, request = httpRequest, post = postForm }) {
    if (!credentials?.account) throw new NoteStationConfigError('credentials.account is required');
    if (credentials.password === undefined) throw new NoteStationConfigError('credentials.password is required');
    this.endpoint = endpoint;
    this.credentials = credentials;
    this.tls = {
      allowSelfSigned: tls.allowSelfSigned ?? endpoint.allowSelfSigned ?? false,
      pinnedFingerprint: tls.pinnedFingerprint,
      serverName: tls.serverName,
      ca: tls.ca,
    };
    this.peerFingerprint = null;
    this.timeoutMs = timeoutMs;
    this.logger = logger;
    // Bound to this endpoint: a jar that answered another origin would be a
    // session leak, and a redirect can never widen it (see http.mjs).
    this.jar = new CookieJar(new URL(endpoint.url).origin);
    this.request = request;
    this.post = post;
  }

  get sid() {
    return this.#sid;
  }

  get synotoken() {
    return this.#synotoken;
  }

  get deviceId() {
    return this.#deviceId;
  }

  get isAuthenticated() {
    return this.#sid !== null;
  }

  #options() {
    return { timeoutMs: this.timeoutMs, ...this.tls, jar: this.jar };
  }

  async #bootstrapPortal() {
    try {
      await this.request(`${this.endpoint.url}/`, {
        ...this.#options(),
        timeoutMs: Math.min(this.timeoutMs, 10000),
      });
      this.logger?.debug?.('auth: portal bootstrap done');
    } catch (error) {
      // A portal bootstrap that fails is not fatal on its own; the login POST
      // below is what actually decides.
      this.logger?.debug?.(`auth: portal bootstrap did not answer (${error.message})`);
    }
  }

  async login() {
    // Concurrent callers share one login instead of racing three sessions into
    // existence and invalidating each other.
    if (this.#loginInFlight) return this.#loginInFlight;
    this.#loginInFlight = this.#login().finally(() => {
      this.#loginInFlight = null;
    });
    return this.#loginInFlight;
  }

  async #login() {
    const flavor = this.endpoint.loginFlavor ?? 'direct';
    if (flavor === 'portal') await this.#bootstrapPortal();

    const params = buildLoginParams(
      { ...this.credentials, deviceId: this.credentials.deviceId ?? this.#deviceId },
      flavor,
    );
    const url = flavor === 'portal' ? corePath(this.endpoint) : coreAuthPath(this.endpoint);
    const response = await this.post(url, encodePlainBody(params), this.#options());
    if (response.fingerprint) this.peerFingerprint = response.fingerprint;

    const envelope = response.json;
    if (!envelope) {
      const looksLikeHtml = /^\s*</.test(response.text ?? '');
      throw new DsmError(
        looksLikeHtml
          ? 'DSM login returned an HTML page instead of JSON — the endpoint is a portal, not an API. ' +
            'This is what an unrepaired QuickConnect portal session looks like.'
          : 'DSM login returned a non-JSON response',
        { status: response.status, api: 'SYNO.API.Auth', method: 'login' },
      );
    }
    if (!envelope.success) throw loginError(envelope, { flavor });

    this.#sid = envelope.data?.sid ?? this.jar.get('id') ?? null;
    this.#synotoken = envelope.data?.synotoken ?? null;
    const did = envelope.data?.did ?? envelope.data?.device_id ?? envelope.data?.device_token;
    if (did) this.#deviceId = did;

    if (!this.#sid) {
      throw new DsmError('DSM login succeeded but returned no session id', {
        api: 'SYNO.API.Auth',
        method: 'login',
        body: envelope,
      });
    }
    if (!this.#synotoken) {
      // Reads may still work; writes will not. Say so once, clearly.
      this.logger?.warn?.(
        'auth: DSM returned no CSRF token; writes will likely fail with 105/119. ' +
          'Check that enable_syno_token=yes is accepted by this DSM version.',
      );
    }
    return { sid: this.#sid, synotoken: this.#synotoken, deviceId: this.#deviceId };
  }

  /** Log in again if the session is gone; otherwise return the current one. */
  async ensure() {
    if (!this.#sid) await this.login();
    return { sid: this.#sid, synotoken: this.#synotoken, deviceId: this.#deviceId };
  }

  async logout() {
    if (!this.#sid) return;
    try {
      const params = new URLSearchParams({
        api: 'SYNO.API.Auth',
        version: '1',
        method: 'logout',
        session: AUTH_SESSION_NAME,
        _sid: this.#sid,
      });
      await this.request(`${corePath(this.endpoint)}?${params.toString()}`, this.#options());
    } catch (error) {
      this.logger?.debug?.(`auth: logout failed (${error.message})`);
    } finally {
      this.#sid = null;
      this.#synotoken = null;
      this.jar.clear();
    }
  }
}
