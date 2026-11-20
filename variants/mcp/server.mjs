#!/usr/bin/env node
/**
 * MCP stdio server for Synology Note Station.
 *
 * Newline-delimited JSON-RPC 2.0 on stdin/stdout. No dependencies, so it runs
 * anywhere Node 18+ does: Claude Code, Codex CLI, Cursor, Windsurf, Cline,
 * Zed, Gemini CLI, Cindy, or a hand-written client.
 *
 * The connection to the NAS is lazy: the server starts instantly, reports a
 * useful error on the first tool call if the configuration is wrong, and
 * retries on the next call once it is fixed.
 *
 * Configuration, in precedence order:
 *   1. --config <path to a JSON file>
 *   2. environment variables (see variants/mcp/README.md)
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createNoteStation } from '../../core/index.mjs';
import { VERSION } from '../../core/version.mjs';
import { createToolCatalog } from '../../core/tools.mjs';

const SERVER_INFO = { name: 'ds-note-connector', version: VERSION };
const SUPPORTED_PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const DEFAULT_PROTOCOL = SUPPORTED_PROTOCOLS[0];

function log(...args) {
  // stdout belongs to the protocol; diagnostics go to stderr.
  console.error('[ds-note]', ...args);
}

function readConfigFromArgs(argv) {
  const index = argv.indexOf('--config');
  if (index === -1) return null;
  const path = argv[index + 1];
  if (!path) throw new Error('--config needs a path');
  return JSON.parse(readFileSync(path, 'utf8'));
}

function configFromEnv(env = process.env) {
  const bool = (value, fallback = false) =>
    value === undefined ? fallback : /^(1|true|yes|on)$/i.test(String(value));

  const config = {
    account: env.DS_NOTE_ACCOUNT,
    password: env.DS_NOTE_PASSWORD,
    otpCode: env.DS_NOTE_OTP,
    deviceId: env.DS_NOTE_DEVICE_ID,
    deviceName: env.DS_NOTE_DEVICE_NAME,
    allowPurge: bool(env.DS_NOTE_ALLOW_PURGE),
    allowRaw: bool(env.DS_NOTE_ALLOW_RAW),
    timeoutMs: env.DS_NOTE_TIMEOUT ? Number(env.DS_NOTE_TIMEOUT) : undefined,
  };
  if (env.DS_NOTE_INSECURE !== undefined) config.allowSelfSigned = bool(env.DS_NOTE_INSECURE);
  if (env.DS_NOTE_CERTIFICATE_NAME) config.certificateName = env.DS_NOTE_CERTIFICATE_NAME;
  if (env.DS_NOTE_CERTIFICATE) config.certificate = env.DS_NOTE_CERTIFICATE;

  if (env.DS_NOTE_HOSTS) {
    // One configuration that works at home, over a VPN and away from both:
    // the addresses are tried in order, then QuickConnect.
    config.mode = 'auto';
    config.hosts = env.DS_NOTE_HOSTS.split(/[\n,]+/).map((entry) => entry.trim()).filter(Boolean);
    config.port = env.DS_NOTE_PORT ? Number(env.DS_NOTE_PORT) : 5001;
    config.https = env.DS_NOTE_HTTPS === undefined ? true : bool(env.DS_NOTE_HTTPS, true);
    config.quickConnectId = env.DS_NOTE_QUICKCONNECT || undefined;
  } else if (env.DS_NOTE_QUICKCONNECT) {
    config.mode = 'quickconnect';
    config.quickConnectId = env.DS_NOTE_QUICKCONNECT;
  } else if (env.DS_NOTE_URL) {
    const url = new URL(env.DS_NOTE_URL);
    config.mode = 'direct';
    config.host = url.hostname;
    config.port = url.port ? Number(url.port) : url.protocol === 'https:' ? 5001 : 5000;
    config.https = url.protocol === 'https:';
  } else {
    config.mode = env.DS_NOTE_MODE ?? 'direct';
    config.host = env.DS_NOTE_HOST;
    config.port = env.DS_NOTE_PORT ? Number(env.DS_NOTE_PORT) : 5001;
    config.https = env.DS_NOTE_HTTPS === undefined ? true : bool(env.DS_NOTE_HTTPS, true);
  }
  return config;
}

export function validateConfig(config) {
  const missing = [];
  if (!config.account) missing.push('DS_NOTE_ACCOUNT');
  if (config.password === undefined) missing.push('DS_NOTE_PASSWORD');
  if (config.mode === 'auto' && !config.hosts?.length && !config.quickConnectId) {
    missing.push('DS_NOTE_HOSTS (or DS_NOTE_QUICKCONNECT as the fallback)');
  }
  if (config.mode === 'direct' && !config.host) missing.push('DS_NOTE_HOST (or DS_NOTE_URL)');
  if ((config.mode === 'quickconnect' || config.mode === 'portal') && !config.quickConnectId) {
    missing.push('DS_NOTE_QUICKCONNECT');
  }
  if (missing.length > 0) {
    throw new Error(
      `Note Station is not configured. Missing: ${missing.join(', ')}. ` +
        'See variants/mcp/README.md for the full list.',
    );
  }
}

export function startServer({ config, stdin = process.stdin, write } = {}) {
  const emit = write ?? ((line) => process.stdout.write(line));
  const send = (message) => emit(`${JSON.stringify(message)}\n`);
  const reply = (id, result) => send({ jsonrpc: '2.0', id, result });
  const replyError = (id, code, message, data) =>
    send({ jsonrpc: '2.0', id, error: { code, message, ...(data ? { data } : {}) } });

  let apiPromise = null;
  let lastError = null;

  const getApi = async () => {
    if (!apiPromise) {
      validateConfig(config);
      apiPromise = createNoteStation({
        ...config,
        logger: { debug: () => {}, warn: (message) => log(message) },
      }).catch((error) => {
        lastError = error;
        apiPromise = null; // let the next call try again
        throw error;
      });
    }
    return apiPromise;
  };

  const catalog = createToolCatalog({ getApi, allowRaw: config.allowRaw === true });

  const handle = async (message) => {
    const { id, method, params } = message;
    const isNotification = id === undefined || id === null;

    switch (method) {
      case 'initialize': {
        const requested = params?.protocolVersion;
        const protocolVersion = SUPPORTED_PROTOCOLS.includes(requested) ? requested : DEFAULT_PROTOCOL;
        reply(id, {
          protocolVersion,
          capabilities: { tools: { listChanged: false } },
          serverInfo: SERVER_INFO,
          instructions:
            "Synology Note Station on the user's own NAS. Search before reading, read before editing, " +
            'and treat delete as "move to the recycle bin". Note bodies are Markdown here, HTML on the server.',
        });
        return;
      }
      case 'notifications/initialized':
      case 'initialized':
        return;
      case 'ping':
        if (!isNotification) reply(id, {});
        return;
      case 'tools/list':
        reply(id, { tools: catalog.listForProtocol() });
        return;
      case 'tools/call': {
        const name = params?.name;
        const args = params?.arguments ?? {};
        const outcome = await catalog.invoke(name, args);
        reply(id, {
          content: [{ type: 'text', text: JSON.stringify(outcome.ok ? outcome.result : outcome, null, 2) }],
          isError: !outcome.ok,
        });
        return;
      }
      case 'resources/list':
        reply(id, { resources: [] });
        return;
      case 'prompts/list':
        reply(id, { prompts: [] });
        return;
      default:
        if (isNotification) return;
        replyError(id, -32601, `method not found: ${method}`);
    }
  };

  let buffer = '';
  stdin.setEncoding('utf8');
  stdin.on('data', (chunk) => {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line === '') continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch (error) {
        replyError(null, -32700, `parse error: ${error.message}`);
        continue;
      }
      Promise.resolve(handle(message)).catch((error) => {
        log('handler failed:', error.message);
        if (message?.id !== undefined) replyError(message.id, -32603, error.message);
      });
    }
  });

  return {
    getLastError: () => lastError,
    close: async () => {
      if (apiPromise) {
        const api = await apiPromise.catch(() => null);
        await api?.close();
      }
    },
  };
}

const invokedDirectly =
  process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];

if (invokedDirectly) {
  let config;
  try {
    config = readConfigFromArgs(process.argv.slice(2)) ?? configFromEnv();
  } catch (error) {
    log(`configuration error: ${error.message}`);
    process.exit(2);
  }
  const server = startServer({ config });
  process.stdin.on('end', () => {
    server.close().finally(() => process.exit(0));
  });
}
