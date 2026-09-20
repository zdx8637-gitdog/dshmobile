# @zdx8637/dshmobile-bridge

[中文文档](./README.zh.md)

**Zero-friction remote bridge for your phone**: one command to install, no networking
configuration, no local patches — after restarting dsh, a persistent QR panel appears in the
left sidebar (cross-platform, immune to DSH upgrades).

- **Persistent QR** (arrow popup at the bottom of the web sidebar): always scannable, independent
  of login state —
  · PC logged in → the phone (even logged out) scans to log into the same account;
  · PC logged out → the phone (logged in) scans to grant access and the PC logs in automatically;
- **Bridge daemon**: username/password mode or phone-granted token mode (passwordless, 401
  auto-refresh);
- One QR, three uses: WeChat scan = download the App, camera scan = open the App for pairing,
  in-App scan = direct login / grant.

<p align="center"><img src="https://raw.githubusercontent.com/zdx8637-gitdog/dshmobile/main/docs/images/plugin-panel.jpg" width="480" alt="DSH plugin panel (persistent QR in the left sidebar)"/></p>

## Install

```sh
npx -y @deepseek-ai/dsh plugin --profile web add @zdx8637/dshmobile-bridge@latest
# after restarting dsh, a ▶ arrow appears at the bottom of the web sidebar — click to open the panel
```

Prerequisite: `pnpm` (the `dsh plugin` subcommand depends on it; `corepack enable` or
`npm i -g pnpm`).

Phone App: scan the panel QR → download the APK from the landing page (or from the
[releases page](https://github.com/zdx8637-gitdog/dshmobile/releases)).

## Patch-free: the panel uses a local channel

DSH 0.1.0-rc.6 does not expose third-party settings namespaces to the browser (upstream marks
this as deferred work). This plugin **does not depend on that channel**: the panel talks to the
host over local HTTP at `127.0.0.1:17653` (status polling + action dispatch, CORS restricted to
local origins), therefore

- install-and-go with one command, **no local patches**;
- Windows/macOS/Linux;
- DSH upgrades cannot break it (historical versions ≤ 0.1.0-beta.3 needed the deprecated
  `scripts/expose-settings-namespace.ps1` patch).

## DSH v0.1.5+ adaptation (legacy DSH support removed)

Since v0.1.5 DSH added browser-session auth to the local web service (the URL printed by
`dsh web` carries a process-level launch token → the browser exchanges it for a session Cookie,
and every `/api` request is validated), and upgraded the RPC protocol to Typert endpoints
(`session/list`, `{args}` payloads, `/api/remote.mux` stream multiplexing, `$events`
approval/question waterfalls). The plugin adapts automatically since 0.1.0-beta.17:

- the host half obtains the launch token via `ctx.connection.authenticatedUrl()` and hands it to
  the bridge child process;
- the bridge exchanges the token for a Cookie once (HMAC-signed, valid 30 days), caches it in the
  state directory, re-mints on 401, and attaches it to every `/api` request and WS upgrade;
- session/workspace/command endpoints are mapped to the new protocol; events flow through
  `/api/remote.mux` (`session/follow` + `workspace/follow` + `session/control`); approvals and
  questions flow through `$events` + `$events/result`.

> ⚠️ **Legacy DSH support (≤ v0.1.0-rc.6) was removed in 0.1.0-beta.23**: the former
> dual-protocol auto-detection (dot endpoints, raw payloads, `events.mux`/`events.host`,
> `/api/respond`, no auth) is gone — one protocol path removed: **adapter −283 lines /
> dsh −59 / main −21 / host −8**, plus the whole "simulated legacy DSH" smoke script.
> **DSH ≥ v0.1.5 is now required.** If the bridge cannot reach DSH it logs a clear
> message in `bridge.log`:
> "v2 协议握手失败：请确认 DSH 正在运行（dsh web）；本插件版本已不再支持旧版 DSH（≤0.1.5-rc.6）".

Self-check scripts: `node scripts/smoke-dsh-v2.mjs` (full pipeline against a simulated new DSH),
`node scripts/probe-real-dsh.mjs` (read-only verification against a running real DSH; requires
having logged into the web panel once in this browser to generate the signing secret),
`node scripts/archive-session.mjs <sessionId>` (archive temp sessions created by the probes).

## relay

The plugin connects to `https://www.deepseek-claudex.cn` by default (author-operated relay:
account registration, device management, message routing). You can also self-host: see the
`relay/` directory and `dsh-remote/docs/04-operations.md` in the main repo, then point the panel
at your own relay URL.

## Development

```sh
npm install
node scripts/build.mjs                  # produces lib/index.js + lib/client.js
node scripts/smoke-host.mjs <u> <p>     # username/password smoke test
node scripts/smoke-grant.mjs <u> <p>    # phone-grant smoke test
```

The complete three-part stack (phone App / relay / protocol) lives in the main repo
[zdx8637-gitdog/dshmobile](https://github.com/zdx8637-gitdog/dshmobile).

## License

MIT
