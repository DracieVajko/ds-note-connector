/**
 * Keeping the NAS's identity out of what an agent can see.
 *
 * A tool result is read by a model and often by a third-party provider. The
 * NAS address, the QuickConnect ID, the relay IP and the DSM serial are none of
 * its business: they describe the user's private infrastructure, not the task.
 *
 * Two rules, applied at the worker boundary — the single place where anything
 * crosses from the plugin into the sandbox and on to the agent:
 *
 *  1. **Do not emit them.** The status tool reports a route, not an address.
 *     Nothing returns the account, the host or the serial.
 *  2. **Scrub what slips through.** Error text is where addresses leak
 *     (timeouts, TLS mismatches, DNS failures), so it is redacted.
 *
 * Note bodies are deliberately left alone. Two reasons, and the second one is
 * the important one:
 *
 *  - Replacing the string "192.168.1.10" inside a note the user wrote would
 *    corrupt their data to protect a value they put there themselves.
 *  - A redactor that rewrites note text also hides real content from the
 *    agent, which then reports a note it did not actually read. Observed in
 *    practice: a note that happened to contain a password-shaped string was
 *    shown as «redacted».
 *
 * The trade-off is stated plainly rather than papered over: if a user keeps a
 * credential inside a note, the agent can read that note. The plugin protects
 * the connection, not the user's filing habits.
 */

/** Fields that are the user's own content and are never rewritten. */
const CONTENT_KEYS = new Set([
  'title',
  'markdown',
  'content',
  'brief',
  'snippet',
  'comment',
  'text',
  'noteTitle',
  'note_title',
]);

/** Anything that looks like infrastructure, regardless of configuration. */
const PATTERNS = [
  [/\b\d{1,3}(?:\.\d{1,3}){3}\b/g, '«ip»'],
  [/\b[a-z0-9-]+\.direct\.quickconnect\.to\b/gi, '«nas».direct.quickconnect.to'],
  [/\b[a-z0-9-]+\.quickconnect\.to\b/gi, '«nas».quickconnect.to'],
  [/(https?:\/\/)[^\s"'<>)\]]+/gi, '$1«host»'],
];

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * @param {object} options
 * @param {string[]} options.always   replaced in every string (password, QuickConnect ID)
 * @param {string[]} options.inErrors replaced only in error/message/hint text (account, host)
 */
export function createRedactor({ always = [], inErrors = [] } = {}) {
  const build = (values) =>
    values
      .filter((value) => typeof value === 'string' && value.trim().length >= 3)
      .map((value) => value.trim())
      .sort((a, b) => b.length - a.length)
      .map((value) => new RegExp(escapeRegExp(value), 'gi'));

  const alwaysPatterns = build(always);
  const errorPatterns = [...alwaysPatterns, ...build(inErrors)];

  const applyPatterns = (text, patterns) => {
    let output = text;
    for (const pattern of patterns) output = output.replace(pattern, '«redacted»');
    return output;
  };

  /**
   * Error text gets both the configured values and the address patterns.
   * Everything else gets only the always-secrets, so a note that mentions an
   * IP address or a URL keeps the user's own words.
   */
  const redactString = (text, { errors = false } = {}) => {
    let output = applyPatterns(String(text), errors ? errorPatterns : alwaysPatterns);
    if (errors) {
      for (const [pattern, replacement] of PATTERNS) output = output.replace(pattern, replacement);
    }
    return output;
  };

  const ERROR_KEYS = new Set(['error', 'message', 'hint', 'reason', 'detail', 'stack']);

  /** Deep redaction. `error`-ish keys get the broader treatment, content keys none. */
  function redactValue(value, depth = 0) {
    if (depth > 12) return value;
    if (typeof value === 'string') return redactString(value);
    if (Array.isArray(value)) return value.map((entry) => redactValue(entry, depth + 1));
    if (value && typeof value === 'object') {
      const output = {};
      for (const [key, entry] of Object.entries(value)) {
        if (CONTENT_KEYS.has(key)) {
          output[key] = entry;
        } else if (typeof entry === 'string' && ERROR_KEYS.has(key)) {
          output[key] = redactString(entry, { errors: true });
        } else {
          output[key] = redactValue(entry, depth + 1);
        }
      }
      return output;
    }
    return value;
  }

  return { redactString, redactValue };
}

/**
 * Build a redactor for one connection.
 *
 * The password and the QuickConnect ID are distinctive enough to scrub
 * everywhere. The account name and the host are not — an account called "home"
 * would wreck a note that mentions home — so they are scrubbed from error text
 * only, where they realistically appear.
 */
export function redactorForConfig(config = {}) {
  return createRedactor({
    always: [config.password, config.quickConnectId].filter(Boolean),
    inErrors: [config.host, config.account].filter(Boolean),
  });
}
