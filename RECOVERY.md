# Source recovery notes

Recovered on 2026-07-29 from the healthy `pi-wechat-agent` container and image.

## What was recovered

- `dist/`: exact runtime JavaScript, declarations, and source maps from `/app/dist`
- `src-recovered/`: readable, unminified JavaScript source reconstructed from `dist`
- `webui-legacy/`: exact browser assets from `/app/webui`
- `package.json` and `package-lock.json`: exact dependency manifests (before the
  recovery-only build script was added)
- `Dockerfile.recovered` and `docker-compose.recovered.yml`: deployment rebuilt
  from Docker image history and container configuration

The original TypeScript text, tests, README, and docs were not present in the
runtime image. Source maps name the original `.ts` files but do not embed
`sourcesContent`, so type annotations and comments cannot be reproduced exactly.

## Open-source core merge

The transport-independent TypeScript core and tests were restored from the
sibling `Projects/pi-bot` repository. The normal `npm run build` now compiles
`src/` and overlays the recovered private administration and WeChat adapter
modules from `private-runtime/`. The untouched container artifacts remain in
`src-recovered/` for forensic comparison; use `npm run build:recovered` only
when an exact rollback to those JavaScript files is required.

## Standardized WeChat integration

The private transports are registered through the same public adapter contract
as the open-source core:

- `src/adapters/definitions.ts` owns the versioned `wechat-ipad` and
  `wx-hook-http` manifests and registry.
- `src/admin/supervisor.js` creates channels through that registry instead of
  importing transport factories directly.
- `src/wechat-emoji-compat.ts` contains WeChat-only compatibility metadata; the
  generic emoji collector remains transport independent.
- `GET /api/adapters` reports available manifests and configured instances.

The open-source React/Vite console now lives in `webui/` and is the complete
administration surface. Generic Core modules use a typed Admin client and
versioned Console manifest; private WeChat management is registered as an
Adapter Console extension. The recovered HTML application remains bundled
under `webui/public/legacy/` only as a rollback aid and is not linked by the
React Console. See `docs/console-architecture.md`.

## Editing, testing, and running

Use `src/` for maintained core TypeScript and `private-runtime/` for recovered
private JavaScript modules. When a private runtime module is also required by
source-level tests, keep its `src/` JavaScript copy in sync. `src-recovered/`
is a forensic snapshot and should not be edited for normal development.

```sh
npm ci
npm run typecheck
npm test
npm run webui:check
npm run build
```

Run the recovered application with `npm start`. For Docker recovery builds, keep
the locally tagged recovery base image and use:

```sh
docker compose -f docker-compose.recovered.yml build
```

Copy `.env.example` to `.env` and fill secrets before replacing the currently
running container. The existing `data/` directory was not modified.

The complete Console image is `pi-wechat-agent-console-v2:20260730`. It was
verified against a copied data directory with both Bot instances disabled, then
deployed as the `pi-wechat-agent` Compose service on 2026-07-30. The immediately
preceding image remains `pi-wechat-agent-standardized:20260730`; consistent
SQLite backups plus container, Compose, and image metadata are stored under
`deployment-backups/pre-console-v2-20260730-121504/` for rollback.
