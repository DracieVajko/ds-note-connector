/**
 * DSM error codes, and the small amount of meaning we are willing to attach
 * to them.
 *
 * A code is only "known" here when a public source states it or we saw it.
 * Everything else is reported as an unknown code with the raw response kept
 * intact, so a caller can act on evidence instead of a guess.
 */

export class DsmError extends Error {
  constructor(message, { code, api, method, status, body } = {}) {
    super(message);
    this.name = 'DsmError';
    this.code = code;
    this.api = api;
    this.method = method;
    this.status = status;
    this.body = body;
  }
}

export class NoteStationConfigError extends Error {
  constructor(message, details) {
    super(message);
    this.name = 'NoteStationConfigError';
    this.details = details;
  }
}

/** `SYNO.API.Auth` login failures. */
export const AUTH_ERRORS = {
  400: 'No such account, or wrong password',
  401: 'Account is disabled',
  402: 'Permission denied',
  403: 'Two-factor code required',
  404: 'Two-factor code failed',
  406: 'Two-factor authentication is enforced for this account',
  407: 'Blocked by IP auto-block',
  409: 'Password has expired',
  410: 'Password must be changed before logging in',
};

/**
 * Session-level failures. These are the ones worth retrying after a fresh
 * login: they all mean "the session, not the request, is the problem".
 */
export const SESSION_ERROR_CODES = new Set([105, 106, 107, 119]);

export const API_ERRORS = {
  100: 'Unknown error',
  101: 'Invalid parameter',
  102: 'The API does not exist',
  103: 'The method does not exist',
  104: 'The API version is not supported',
  105: 'Insufficient permission, or not logged in',
  106: 'Session timeout',
  107: 'Duplicate login',
  119: 'Session invalid, or missing CSRF token',
};

export function describeCode(code) {
  return API_ERRORS[code] ?? AUTH_ERRORS[code] ?? null;
}

export function isSessionError(error) {
  return error instanceof DsmError && SESSION_ERROR_CODES.has(error.code);
}

/**
 * Turn a `{success:false, error:{code}}` envelope into a DsmError that says
 * what is known and keeps the raw envelope for debugging.
 */
export function errorFromEnvelope(envelope, { api, method, status } = {}) {
  const code = envelope?.error?.code;
  const known = describeCode(code);
  const where = [api, method].filter(Boolean).join('.');
  const message = known
    ? `${where || 'DSM call'} failed: ${known} (code ${code})`
    : `${where || 'DSM call'} failed with undocumented code ${code ?? '?'}`;
  return new DsmError(message, { code, api, method, status, body: envelope });
}
