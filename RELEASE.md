# Release checklist

The package is prepared for the initial public repository push. No npm
publication has been performed.

The repository URL is configured as
`https://github.com/mrbeandev/dsh-rpm`. The package is licensed under
MIT. `prepublishOnly` still stops a publish if the license is missing or
`UNLICENSED`. The package name was unpublished on npm when last checked;
verify ownership while logged into the intended npm account before publishing.

1. Choose the package name/scope and verify npm availability/ownership.
2. Distribution license: MIT (done; LICENSE and package.json agree).
3. Confirm the repository, bugs and homepage metadata in package.json.
4. Confirm supported DSH versions (built against the same host as
   dsh-short-tool-ids: settings + llm services, settingsScope client surface).
5. Run `npm run build` and `npm test`.
6. Verify the Models settings row and real throttling using the installed
   package (set a small limit such as 2, then chat with that provider).
7. Run `npm run pack:check` and inspect every packed file: no credentials,
   private session history, caches, or absolute user paths. Source/build
   scripts and unit tests are intentionally included.
8. Bump the version. Publish only on explicit owner instruction.

After those gates are complete, publish the public package with:

```bash
npm publish --access public
```

Users can then install it into the Web profile with:

```bash
dsh plugin --profile web add dsh-rpm
```

`prepublishOnly` refuses publication if the distribution license is missing or
`UNLICENSED`. The repository metadata is already configured.
The browser entry (`lib/client.js`) is generated from `client/index.mjs` by
`scripts/build-client.mjs`; always rebuild and re-verify before packing.
