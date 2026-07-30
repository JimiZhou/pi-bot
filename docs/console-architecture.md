# Console architecture

The React Console is the primary administration surface. The recovered legacy
HTML application remains packaged only as a rollback aid; the React navigation
does not link to it.

## Merge boundary

The Console is intentionally split into three layers so the repository can keep
following the public `pi-bot` project without re-applying WeChat-specific edits
throughout upstream components.

1. **Console shell** — navigation, authentication, layout, theme, loading states,
   and the `ConsoleModule` registry. This is the upstream-friendly layer.
2. **Core admin modules** — Bot orchestration, Adapter manifests, Provider/model
   profiles, knowledge, MCP, personas, plugins, conversations, evaluation,
   settings, logs, and runtime status. These depend only on the typed Admin API.
3. **WeChat Console extension** — wx_hook/iPad configuration editors, login,
   identity, contacts, Moments, group administration, and emoji management.
   These live below `webui/src/extensions/wechat` and
   `webui/src/features/wechat`.

The server advertises enabled extension families at
`GET /api/v1/console-manifest`. The client registers the WeChat modules only
when the manifest contains `wechat`. Adapter runtime contracts and Admin UI
contracts remain separate:

- `ChannelAdapter` and its manifest own message transport and runtime
  capabilities.
- `AdapterAdminExtension` owns only configuration fields, defaults, and
  form-to-config conversion.

This prevents browser concerns from entering the standard Bot runtime while
still allowing an Adapter package to supply a complete management experience.

## Upstream update workflow

The local `wechat-console-v2` branch is based directly on public revision
`4997b3677863233cd20ec7adb4a8e6ab5b19a9c3`. The `upstream` remote is configured
as fetch-only so the private runtime cannot be pushed to the public repository
by accident.

When merging a newer public `pi-bot` revision:

1. Merge changes to the shell, console primitives, design tokens, and generic
   core pages first.
2. Keep `AdminClient`, `ConsoleModule`, and `AdapterAdminExtension` contracts
   stable or update them in one compatibility commit.
3. Rebase the files under `extensions/wechat` and `features/wechat` only when a
   contract changes; they should not require edits for visual-only upstream
   updates.
4. Run `npm run check`, build an isolated candidate image, and verify the
   Console against a copied data directory before replacing the production
   container.

## Legacy coverage

The React Console now owns all legacy navigation domains:

- Bot lifecycle and complete Bot configuration
- Provider, model, knowledge, MCP, persona, plugin, and global settings
- Adapter manifests and instances
- Group configuration, history/send, scheduled tasks, memories, and native
  WeChat group administration
- Emoji library and participation-quality review
- WeChat login, identity, contacts/labels, and Moments automation
- Logs and runtime health

Any future Admin endpoint must be added to `AdminClient` (or a typed extension
client), exposed through a registered module, and covered by an API contract
test before the legacy rollback surface can be removed.
