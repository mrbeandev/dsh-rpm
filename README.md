# dsh-rpm

Per-provider **requests-per-minute (RPM) rate limiting** for DeepSeek Harness.

Model requests to a provider beyond its configured limit are **delayed until
the next one-minute window** instead of failing — covering interactive chat,
subagents, and retries alike, since enforcement sits in the `llm/stream`
waterfall that wraps every streaming model call.

## Features

- Durable per-provider limits in the `dsh-rpm` settings namespace
  (`providers[routeId] = rpm`); changes apply live, no restart.
- A **Rate limit (requests per minute)** input on provider cards in
  **Settings → Models**:
  - DeepSeek official card: rendered directly by this plugin.
  - Custom providers on the `llm-pi-ai` card cell (9router, cloudflare-…):
    rendered by [`dsh-short-tool-ids`](https://github.com/mrbeandev/dsh-short-tool-ids)
    beneath its *Use short tool-call IDs* toggle, when that plugin is
    installed alongside. The provider-card cell is single-occupant per
    settings namespace, so exactly one plugin renders each card's extension
    area; the composite lives there to keep both controls visible.
- `0` or an empty field means unlimited (the default for every provider).

## Installation

```bash
dsh plugin --profile web add "/absolute/path/to/dsh-rpm"
# restart the web profile afterwards
dsh web --no-open --port 3080
```

The client bundle is generated: edit `client/index.mjs`, then `npm run build`.

## Development

```bash
npm run build   # generate lib/client.js from client/index.mjs
npm test        # limiter unit tests
npm run pack:check
```

## How it works

- Host (`index.mjs`) registers the `dsh-rpm` settings namespace and listens to
  the host `llm/stream` event. Routes without a configured limit pass through
  with zero overhead; limited routes queue on a fixed-window counter
  (`limiter.mjs`, independently unit-tested).
- Client (`client/index.mjs`) binds the settings transport's `settingsScope`
  service and renders the per-card control into `settings.models.provider-card`.
