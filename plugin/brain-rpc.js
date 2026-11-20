/*
 * Talking to the plugin brain from a page.
 *
 * The panel and the settings page both need the same thing: wake the brain,
 * send a request over a BroadcastChannel, and keep re-sending until it answers,
 * because a freshly opened page cannot know whether the brain is listening yet.
 *
 * That client used to exist twice, with different names and a hardcoded 500 ms
 * where the other had a constant. It is one file now, loaded by both pages.
 */
(function () {
  const CHANNEL = 'ds-note';
  const RESEND_MS = 500;
  const DEFAULT_TIMEOUT_MS = 45000;

  const channel = new BroadcastChannel(CHANNEL);

  function newId() {
    if (globalThis.crypto?.randomUUID) return crypto.randomUUID();
    return `req-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }

  async function wake() {
    try {
      await fetch('cindy-ghost://ds-note/wake');
    } catch {
      // Not fatal: the brain may already be running, and the resend loop
      // covers the rest.
    }
  }

  /**
   * Send one request and resolve with its result.
   * The brain drops duplicate `reqId`s, so a resend can never become a second
   * write.
   */
  function call(tool, args = {}, timeoutMs = DEFAULT_TIMEOUT_MS) {
    const reqId = newId();
    return new Promise((resolve, reject) => {
      let timer = null;
      let timeout = null;

      const onMessage = (event) => {
        const message = event.data;
        if (!message || message.type !== 'panel-result' || message.reqId !== reqId) return;
        cleanup();
        if (message.ok) resolve(message.result);
        else {
          const error = new Error(message.error || 'the request failed');
          error.kind = message.kind;
          error.code = message.code;
          error.hint = message.hint;
          reject(error);
        }
      };

      const cleanup = () => {
        channel.removeEventListener('message', onMessage);
        clearInterval(timer);
        clearTimeout(timeout);
      };

      channel.addEventListener('message', onMessage);
      const send = () => channel.postMessage({ type: 'panel-call', reqId, tool, args });
      send();
      timer = setInterval(send, RESEND_MS);
      timeout = setTimeout(() => {
        cleanup();
        reject(new Error('no answer from the plugin — is DS Note enabled?'));
      }, timeoutMs);
    });
  }

  globalThis.dsNoteBrain = { channel, call, wake };
})();
