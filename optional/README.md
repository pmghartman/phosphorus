# Optional apps

Each folder here is one app an admin can install from the Apps page; none of it is in the core.

```
optional/<id>/
  package.json        @phosphorus/app-<id>
  web/index.html      the page, opened in its own desktop window (@phosphorus/app-sdk/web)
  web/static/         copied as is; icon.svg is the app's icon
  server/index.ts     optional: register(ctx) run inside phosphorus (@phosphorus/app-sdk)
```

Its catalogue entry is a `firstParty({ id, ... })` in `packages/mesh/webapps/src/index.ts`; `server: true` when it has a server half.
`bun run app <id> OUT VERSION` builds the signed bundle and its feed entry; the release publishes every app here.
