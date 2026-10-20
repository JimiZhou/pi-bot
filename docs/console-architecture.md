# Console architecture

The React Console is the primary administration surface for Pi Bot v0.3. It
manages the transport-independent Core and shows externally registered Adapter
manifests; it does not contain a platform login flow or protocol client.

## Layers

1. **Console shell** — navigation, authentication, layout, theme and loading
   states.
2. **Core admin modules** — Bot lifecycle, Provider/model profiles, knowledge,
   MCP, personas, plugins, conversations, evaluation, settings, logs and
   runtime status.
3. **External Adapter** — a trusted module loaded with
   `PI_CHANNEL_ADAPTER_MODULE`. Its manifest and runtime instance are displayed
   by the Adapter page, while its opaque `channel.settings` are edited as JSON
   in the Bot page.

The server advertises the contract through `GET /api/v1/console-manifest` and
`GET /api/adapters`. The default registry is empty by design. Registering an
Adapter is an explicit deployment decision; installing or importing a package
does not silently activate it.

## Adapter boundary

The external Adapter owns login/session state, raw event conversion, outbound
platform calls, media resolution, health checks, callbacks, reconnects and
platform-specific administration. Core owns durable conversation state,
memory, model execution, plugin orchestration and reliable outbox semantics.

This means wxhook, iPad protocol clients, QR/login UI, cookies, signatures and
platform credentials are intentionally absent from the public project. A
platform-specific Console can be shipped by the Adapter package if needed,
without adding that protocol to the Core repository.

## Updating the Console

When changing a generic Admin endpoint:

1. Update the server implementation and its declaration.
2. Update `webui/src/lib/admin-client.ts` and the affected module.
3. Add or update an API contract test.
4. Run `npm run check`.

Keep `src/` and `webui/src/` as source of truth. `dist/` and `webui/dist/`
are generated output and should not be edited manually.
