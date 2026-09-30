# Local setup

This document is for local development. It intentionally does not contain
machine-specific paths or private session data.

## Profile installation from this checkout

Stop the current DSH Web process with Ctrl+C, then install from this checkout:

```bash
npm_config_cache="$PWD/.cache/npm" \
  dsh plugin --profile web add "/absolute/path/to/dsh-rpm"
dsh web --no-open --port 3080
```

Refresh http://127.0.0.1:3080 and open **Settings → Rate limits**. Every
provider defaults to unlimited.

On DSH 0.1.7 and later the limits live in this entry's volatile Config
(profile patch, entry `dsh-rpm`); on 0.1.5 they live in the `dsh-rpm` settings
namespace (`settings.yaml`). See README.md for the tested DSH versions and the
`allowUntestedHarness` override.

The profile manager installs this checkout as a link, so keep the folder in
place. After editing `client/index.mjs`, run `npm run build` and restart the
profile.

## Local regression command

```bash
DSH_TEST_HARNESS_ENTRY="$(realpath "$(which dsh)")" npm run test:integration
```
