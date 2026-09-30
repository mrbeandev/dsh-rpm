# dsh-rpm

Per-provider **requests-per-minute (RPM) rate limiting** for DeepSeek Harness
(DSH), with its own **Settings → Rate limits** tab.

Model requests to a provider beyond its limit are **delayed until the next
one-minute window** instead of failing. That covers interactive chat,
subagents and retries alike, because enforcement sits in the `llm/stream`
waterfall that wraps every streaming model call.

[Source repository](https://github.com/mrbeandev/dsh-rpm)

**Contents:** [Supported DSH versions](#supported-dsh-versions) ·
[Install](#install-from-npm) · [Settings tab](#the-settings-tab) ·
[How limiting works](#how-limiting-works) · [Upgrading](#upgrading-from-01x) ·
[Development](#development)

## Supported DSH versions

**Supported range: DSH `0.1.5-rc.1` up to (not including) `0.3.0`**, with
dsh-rpm `0.2.0` or later. Check yours with `dsh --version`.

| DSH version | Status | Where the limits are stored |
|---|---|---|
| `0.2.0-rc.2` | ✅ Tested | this plugin's entry in the profile patch (`cordis.patch.yml`) |
| `0.2.0-rc.1` | ✅ Tested | this plugin's entry in the profile patch (`cordis.patch.yml`) |
| `0.1.7-rc.2` | ✅ Tested | this plugin's entry in the profile patch (`cordis.patch.yml`) |
| `0.1.5-rc.1` – `0.1.5-rc.3` | ✅ Tested | `settings.yaml`, section `dsh-rpm` |
| other releases from `0.1.5-rc.1` up to `0.3.0` (not included) | ⚠️ Untested but should work: loads with a warning if the settings API check passes | detected automatically |
| older than `0.1.5-rc.1` | ❌ Not supported | — |
| `0.3.0` and newer (prereleases included) | ❌ Refused until tested (override with `allowUntestedHarness: true`) | — |

**Node.js:** `^22.19.0` or `>=24.0.0`.

**Which plugin version do I need?**

| dsh-rpm | Works with DSH |
|---|---|
| `0.2.0` and later | `0.1.5-rc.1` up to `0.3.0` (not included). Own Settings tab. |
| `0.1.0` | only DSH 0.1.5 (`settings.register`). **Fails to load on 0.1.7 and 0.2** because those releases no longer offer `settings.register`. |

A refused plugin logs a clear error at startup and does not load; the Settings
tab then says the host plugin is not running. It never half-loads.

## Install from npm

```bash
dsh plugin --profile web add dsh-rpm
```

Restart DSH Web, then open **Settings → Rate limits**.

## The Settings tab

*Rate limits* lists every registered model provider, each with a
requests-per-minute field and an **Apply** button:

- Every provider is **unlimited by default**.
- Enter a whole number (for example `20`) and press **Apply** to cap that
  provider. Enter `0` or clear the field to remove the limit.
- Changes apply to every session immediately, with no restart.
- A provider that was removed but still has a stored limit keeps its row, so
  the limit can be cleared.

The tab uses whichever settings API the running DSH offers: `configForms`
(0.1.7+, this plugin's own Config entry `include:dsh-rpm`) or `settingsScope`
(0.1.5, namespace `dsh-rpm`).

## How limiting works

- Each provider route has its own fixed one-minute window. Requests under the
  limit go straight through; the rest queue until the window resets and then
  proceed in order, never exceeding the limit in any window.
- Stopping a chat while its request is queued removes it from the queue at
  once; it never reaches the provider and never uses a slot.
- Routes without a limit pass through untouched, with no added latency.
- The limit counts **requests started**, not tokens, and is per DSH process.

## Upgrading from 0.1.x

- The limit field moved from the provider cards in *Settings → Models* to the
  new *Settings → Rate limits* tab. dsh-rpm no longer occupies the
  provider-card slot, and it no longer needs dsh-short-tool-ids (whose
  `0.4.0` also dropped the combined card row). Both plugins are fully
  independent.
- The profile entry id changed from `rpm-limits` to `dsh-rpm`. On DSH 0.1.5
  the stored limits (`settings.yaml`, section `dsh-rpm`) carry over. On DSH
  0.1.7 and later, 0.1.0 never loaded, so there is nothing to migrate.

## Development

The browser entry (`lib/client.js`) is generated from `client/index.mjs`:
edit the source, then rebuild.

```bash
npm run build       # generate lib/client.js from client/index.mjs
npm test            # limiter, version-gate, host and client tests
DSH_TEST_HARNESS_ENTRY="$(realpath "$(which dsh)")" npm run test:integration
npm run pack:check  # inspect the exact published file set
```

`test/plugin.test.mjs` mounts the host plugin on the installed DSH (when
`DSH_TEST_HARNESS_ENTRY` is set) and checks pass-through, queuing,
cancellation and live limit changes through the real settings API.

## License

MIT
