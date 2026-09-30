# Release checklist

## Current release: 0.2.0

Prepared and pushed to `https://github.com/mrbeandev/dsh-rpm`. **Not yet
published to npm** (0.1.0 was never published either); the owner publishes
manually. The package name `dsh-rpm` was unclaimed on npm when last checked;
verify ownership while logged into the intended npm account before publishing.

0.2.0 highlights: DSH 0.1.5 through 0.2.x support (`settings.register` on
0.1.5, volatile plugin Config on 0.1.7+), a dedicated **Settings → Rate
limits** tab (`configForms` with a `settingsScope` fallback, the same pattern
as dsh-short-tool-ids 0.4.0), abort-aware queuing, and the profile entry id
`dsh-rpm`.

## Gates

1. License: MIT (LICENSE and package.json agree).
2. Repository, bugs and homepage metadata point to `mrbeandev/dsh-rpm`.
3. `npm run build`, then `npm test` (unit tests).
4. `DSH_TEST_HARNESS_ENTRY="$(realpath "$(which dsh)")" npm run test:integration`
   on every DSH version listed as tested in README.md.
5. Install the checkout into a profile, restart, and verify the Settings →
   Rate limits tab and real throttling (set a limit such as 2 on one provider,
   then send several quick messages to it).
6. `npm run pack:check`: inspect every packed file. No credentials, private
   session history, caches or absolute user paths. Source, build scripts and
   tests are intentionally included.
7. Publish only on explicit owner instruction:

```bash
npm publish --access public
```

Users then install it with:

```bash
dsh plugin --profile web add dsh-rpm
```

`prepublishOnly` refuses publication if the license is missing or
`UNLICENSED`. `prepack` rebuilds `lib/client.js` from `client/index.mjs` and
runs the tests, so a stale browser bundle cannot be packed.
