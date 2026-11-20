# Connecting to a NAS, and logging in

Two independent decisions: **where** the NAS is, and **how** to authenticate.
They interact, which is why they are documented together.

Everything below is either captured from a stock client, documented by a
third-party protocol write-up, or marked as unverified. `docs/API.md` explains
the trust levels.

---

## 1. Where — connection modes

### `auto` — the recommended one

A list of addresses, tried together, plus a QuickConnect ID as the last resort:

```
mode: auto
hosts: [192.168.1.10, 100.64.0.5, nas.example.com]
port: 5001
certificateName: nas.example.com
quickConnectId: mynas
```

Every address is probed with the **real** TLS options, so a route that only
answers because verification was skipped never wins. The first address in the
list that answers is used; if none do, QuickConnect is asked, and the portal is
the final fallback.

That gives one configuration that behaves correctly at home, over a VPN and
away from both: the LAN address is used when it is there, the VPN address
otherwise, and QuickConnect only when neither works. The probes run in parallel
and are bounded by a deadline, so a dead address does not cost the user a wait
before a working one.

### `direct`

A LAN address, a DDNS name, a reverse proxy, a VPN address (Tailscale,
WireGuard), or a QuickConnect relay tunnel. All of these behave identically on
the wire, so they share one mode.

```
mode: direct, host: 192.168.1.10, port: 5001, https: true
```

- Fastest option, and the only one with no third party in the path.
- **TLS verification is on by default, for every host and every route.** A bare
  IP or a relay address will therefore fail until the user turns verification
  off, on purpose, in the settings — where the cost is spelled out: the NAS's
  identity is not checked, so anything answering on that address could receive
  the DSM password. A hostname with a real certificate avoids the choice
  entirely, and is what the error message recommends.
- Plain HTTP is allowed only when the user picks it, and the settings page says
  that the password then crosses the network in clear text.

### `quickconnect`

Given only a QuickConnect ID, ask Synology's coordinator where the NAS is,
probe the candidates, and take the first one that answers.

```
mode: quickconnect, quickConnectId: mynas
```

The protocol (`nullvoidptr/qcon`, `protocol.md`):

1. `POST https://global.quickconnect.to/Serv.php` with `get_server_info` →
   LAN addresses, external IP, DDNS/FQDN, ports, and `serverID`.
2. Candidates are probed at `/webman/pingpong.cgi?action=cors&quickconnect=true`.
   A candidate only counts if `ezid` equals **MD5(serverID)** — otherwise we
   would happily talk to a different NAS on the same address.
3. If nothing answers, `request_tunnel` returns `relay_ip:relay_port`, a raw
   TCP tunnel to the DSM port.
4. If even that fails, the portal is the last resort.

Priority used by `core/quickconnect.mjs`: LAN IPv4/IPv6 → smart DNS LAN →
FQDN → DDNS → WAN external/IP → relay.

### `portal`

Force `https://<id>.quickconnect.to`. Always reachable, always a valid
certificate, but it is a **web portal**, not a plain reverse proxy — see the
login flavour below. Slower, and it is still unverified whether it forwards the
package-local `/notestation/webapi/…` path at all.

### Why the portal and the tunnel are not interchangeable

| | portal | relay tunnel |
|---|---|---|
| URL | `https://<id>.quickconnect.to` | `https://<relay_ip>:<relay_port>` |
| What it is | Synology reverse proxy / web portal | raw TCP tunnel to the DSM port |
| Certificate | Synology's own `*.quickconnect.to` | **the NAS's own**, end to end |
| Package-local paths | **unverified** | work (it is a full tunnel) |
| Login | cookie bootstrap + `entry.cgi` POST | plain `auth.cgi` |
| Can answer with HTML | yes — this is a real failure mode | no |
| Throughput | shared relay | shared relay |

**A correction worth knowing.** The relay was assumed to terminate TLS with a
Synology certificate, which made a relay route look impossible to verify. It
does not: the relay passes the TLS session through to the NAS. What looked
self-signed was DSM serving its **default** certificate because the client sent
no SNI. Set `certificateName` and the NAS answers with the certificate issued
for that name, so a relay route verifies exactly like a direct one. Verified
live: the same NAS answered with its Let's Encrypt certificate once SNI was
sent.

The relay still routes through Synology and is slower than a LAN or VPN path,
so `auto` prefers those. But it is not a security downgrade on its own.

**Recommendation:** prefer `direct` or `auto`. Treat a portal answer that is
HTML instead of JSON as "wrong endpoint", not "wrong password" — the code does
exactly that.

### Security note about QuickConnect IDs

Anyone who knows a QuickConnect ID can query the public coordinator **without
authenticating** and learn the NAS's IP addresses, hostnames and relay details.
Use a non-guessable ID. This is a property of the service, not of this project.

---

## 2. How — authentication

### There is no OAuth, no API key, no app password

DSM offers no third-party credential for this. A DSM account is the only way
in. That makes credential handling the most sensitive part of this project.

Recommended setup, in order of how much each one buys:

1. **Do not send the password through Synology.** QuickConnect relay traffic
   goes through Synology's infrastructure by design. A VPN (Tailscale,
   WireGuard) or a LAN route keeps the whole exchange between your machine and
   your NAS, and lets you put a real certificate on a DDNS name so verification
   never has to be turned off. This is the single biggest improvement.
2. **Give the plugin the NAS certificate.** Export it from DSM (Control Panel →
   Security → Certificate → Export) and point the setting at the file. The
   plugin then verifies the TLS chain against that certificate with normal
   verification on: no "accept anything", no bypass, and an expired certificate
   is caught. Scope, stated exactly: **the chain is validated against your file;
   the hostname is not checked**, because the file you supplied is the identity
   and a NAS certificate rarely covers the address you dial (an IP, or a
   QuickConnect relay address). If you need the address checked too, use a
   hostname with a real certificate ("verify by name") instead.
   `dsnote_status` reports `certificate.hostnameChecked` and a `scope` line so
   this is visible rather than assumed. This is the strongest option that does
   not require touching the network.
3. **Pin the fingerprint** (`certificateFingerprint`) if exporting a file is not
   convenient. Same idea, weaker: trust on first use, one certificate accepted,
   but the check is a comparison rather than real chain validation. The panel
   shows the fingerprint the NAS presented.
4. **A dedicated DSM user whose only permission is Note Station**, with a
   password used nowhere else.
5. **Two-factor on that account.** A stolen password is then not enough on its
   own. DSM issues a trusted-device token (`did`) after an OTP login, which the
   client sends as `device_id` afterwards.
6. Never reuse an admin account.

What cannot be fixed: DSM offers no OAuth, no API key and no app-specific
password for third-party clients, so a password has to reach the worker at
login time. It is held in memory for the session, never written by the worker,
and never returned to the agent.

### Login flavours

**Direct** (`auth.cgi`):

```
api=SYNO.API.Auth&version=7&method=login
&account=<user>&passwd=<pass>&session=NoteStation&format=sid
&enable_syno_token=yes&enable_device_token=yes&device_name=…
[&otp_code=…] [&device_id=…]
```

**Portal** (`entry.cgi`, after a cookie bootstrap):

```
GET  https://<id>.quickconnect.to/                     ← collects relay cookies
POST https://<id>.quickconnect.to/webapi/entry.cgi
api=SYNO.API.Auth&version=7&method=login&…
&logintype=local&client=browser&rememberme=0&enable_syno_token=yes
```

`session=NoteStation` matters: a session opened for another package is not
accepted by the Note Station APIs.

### Two-factor, and why it does not have to be painful

`enable_device_token=yes` makes the NAS return a `did` on a successful
OTP login. Storing that `did` and sending it as `device_id` marks this client
as a trusted device, so the code is asked **once**, not on every run.

- `403` on login = two-factor required.
- `404` = the code was wrong.

If the stored `did` is rejected, drop it and ask for a fresh code — do not
retry forever.

### Session lifecycle

- `sid` + `synotoken` are held in memory for the life of the client.
- On `105`, `106`, `107` or `119` the client logs in again and retries the call
  **once**. Those four mean "the session is the problem", not "the request is".
- `logout` is best-effort.

### Where the password lives

Not in this repository, and not in code. The plugin and the MCP server take it
from their own secret store (OS keychain / plugin settings), the CLI takes it
from `DS_NOTE_PASSWORD` or a prompt. Logs redact `passwd`, `otp_code`, `_sid`
and `synotoken`.

---

## 3. Failure modes worth recognising

| Symptom | Actual cause |
|---|---|
| HTML page instead of JSON | portal endpoint, or a portal session that needs repair. Not a password problem |
| `105` on writes only | missing `X-SYNO-TOKEN` |
| `119` on everything | `_sid` missing, or the session was never opened for `NoteStation` |
| `102` on a Note Station call | called the core `/webapi/entry.cgi` instead of `/notestation/webapi/entry.cgi` |
| Writes silently not applied | sent bare form values to a `requestFormat: JSON` API |
| TLS error on a relay address | an IP cannot be covered by a certificate. Turning verification off is the blunt fix; recording the fingerprint is the precise one |
| `certificate fingerprint does not match` | something answered that is not your NAS, or the NAS certificate was replaced. Check before trusting the new one |
| Note body stripped after editing in the app | content used HTML outside the vocabulary in `docs/API.md` |
