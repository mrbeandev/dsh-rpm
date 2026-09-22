# Local setup

This document is for local development. It intentionally does not contain
machine-specific paths or private session data.

## Normal profile installation

Stop the current DSH Web process with Ctrl+C, then install from this checkout:

```bash
npm_config_cache="$PWD/.cache/npm" \
  dsh plugin --profile web add "/absolute/path/to/dsh-rpm"
dsh web --no-open --port 3080
```

Refresh http://127.0.0.1:3080, open Settings → Models, and use the
**Rate limit (requests per minute)** row on a provider card. Custom providers
on the pi-ai card family show the row beneath *Use short tool-call IDs* when
`dsh-short-tool-ids` is also installed. Every provider defaults to unlimited.

Keep the package folder in place: the profile manager installs this checkout
as a link. After editing `client/index.mjs`, run `npm run build` and restart
the profile.
