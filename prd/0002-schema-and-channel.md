# PRD-0002: Schema & Channel

**Author:** Josh
**Date:** 2026-02-16
**Status:** Draft

## Problem Statement

reactiveSWR's client side works well — `SSEProvider`, `useSSEEvent`, `useSSEStream`, and `createSSEParser` all integrate cleanly into consumer apps (confirmed by the [data-ops integration friction log](../docs/integration-friction-notes.md)). But the server side is entirely DIY. Every consumer must hand-roll SSE endpoint boilerplate: `text/event-stream` headers, `data: ...\n\n` formatting, heartbeats, connection cleanup, and event-type serialization.

There is no shared contract between server and client. Event type strings, payload shapes, and cache key mappings are duplicated on both sides and drift silently. This is the gap Meteor closed with its Oplog → DDP → MiniMongo pipeline — a single schema drove both publication and subscription. reactiveSWR needs the same: a shared schema that drives both server-side SSE emission and client-side SWR cache updates.

Additionally, the [integration friction log](../docs/integration-friction-notes.md) surfaced four build-pipeline issues (items #1–#4) that block clean consumption of the package. These must be fixed first as prerequisites.

## Business Context

- **Server-side gap:** Every consumer must write the same SSE boilerplate. A first-party `createChannel()` API closes the loop and makes reactiveSWR a complete client-server solution.
- **Type-safety gap:** Without a shared schema, event type strings and payload types are duplicated and can drift. `defineSchema()` eliminates this class of bug.
- **Build-pipeline blockers:** The friction log items (#1–#4) prevent clean `link:` consumption and npm publishing. These are prerequisites for any new feature work.
- **Competitive positioning:** Libraries like Supabase Realtime and Convex provide end-to-end reactive contracts. A schema-driven approach puts reactiveSWR in the same category without the vendor lock-in.
- **Timing:** At v0.0.1 with no external consumers yet, this is the right time to establish the server-side API shape before publishing.

## Goals & Success Metrics

| Goal | Metric | Target |
|------|--------|--------|
| Fix build pipeline | All four friction log items resolved | `bun run build` produces JS + `.d.ts` for all entry points; `prepare` script works |
| Shared schema | Single `defineSchema()` call produces types consumed by both server and client | Zero duplicated type strings or payload types across server/client |
| Server-side channel | `createChannel(schema)` provides a complete SSE endpoint | Works with Web standard `Request`/`Response` and Node.js `http` — no framework dependencies |
| SSEProvider schema integration | `schema` prop auto-derives `events` mapping | Existing manual `events` prop still works; `schema` and `events` are mutually exclusive |
| Testing convenience | `mockSSE.sendSSE(data)` helper for `createSSEParser` consumers | One-liner replaces manual `sendRaw(\`data: ...\n\n\`)` calls |
| No new runtime dependencies | Server channel uses only Web/Node built-ins | `package.json` dependency count unchanged |

**Negative metric:** Existing client-only usage (no schema, manual `events` prop) shall not be affected.

## User Stories

- **As a** full-stack developer, **I want** to define my event types and payload shapes in one place **so that** my server endpoints and client subscriptions stay in sync without manual duplication.
- **As a** backend developer, **I want** `createChannel(schema)` to handle SSE wire formatting, heartbeats, and connection cleanup **so that** I don't hand-roll SSE boilerplate in every endpoint.
- **As a** developer using SSEProvider, **I want** to pass a `schema` prop instead of manually writing `events` mappings **so that** cache key mappings and update strategies are derived automatically from the schema.
- **As a** developer linking reactiveSWR locally, **I want** `bun run build` to produce complete output (JS + `.d.ts` for all entry points) **so that** I can consume the package without manual build steps.
- **As a** developer writing tests with `createSSEParser`, **I want** a `mockSSE.sendSSE(data)` helper **so that** I don't need to manually construct SSE wire format strings in every test.
- **As a** developer with a Node.js server (Express, Fastify, raw `http`), **I want** `channel.connect()` to accept Node.js request/response objects **so that** I'm not forced into a specific framework.
- **As a** developer with a Cloudflare Workers or Deno server, **I want** `channel.connect()` to accept a Web standard `Request` and return a `Response` **so that** it works in edge runtimes.

## Scope

### In Scope

#### Build Pipeline Fixes (Prerequisites)

1. **Fetch type cast fix** — Fix `src/testing/index.ts:186` where the mock fetch function is missing the `preconnect` property required by `@types/node` 24's `typeof fetch`. Cast the assignment to satisfy `tsc`. *(Friction log item #1)*
2. **`prepare` script** — Add `"prepare": "bun run build"` to `package.json` so that `link:` consumers get a working `dist/` automatically. *(Friction log item #2)*
3. **Multi-entrypoint build with `.d.ts` generation** — Update the `build` script to compile all entry points (`src/index.ts`, `src/testing/index.ts`, and the new `src/server/index.ts`) and run `tsc` for declaration files. Add `tsconfig.emit.json`. *(Friction log item #3)*
4. **`./server` subpath export** — Add `"./server"` to `package.json` `exports` field pointing to `dist/server/index.js` and `dist/server/index.d.ts`. *(Supports `createChannel` import path)*

#### `defineSchema()`

5. A function that accepts a schema definition object and returns a frozen schema object consumed by both `createChannel()` (server) and `SSEProvider` (client).
6. Schema definition includes: event type names, payload TypeScript types, cache key mappings (`string | string[] | (payload) => string | string[]`), update strategies (`'set' | 'refetch' | merge function`), and optional `filter` / `transform` per event.
7. The schema object provides full TypeScript inference — consumers get autocomplete for event names and type-checked payloads on both sides.
8. Exported from the main `reactive-swr` entry point (it's framework-agnostic, pure types + data).

#### `createChannel(schema)` (`reactive-swr/server`)

9. Factory function that accepts a schema and returns a `channel` object.
10. **`channel.connect(req, res?)`** — Establishes a persistent SSE connection.
    - Web standard signature: `(request: Request) => Response` — returns a streaming `Response` with `text/event-stream` headers.
    - Node.js signature: `(req: IncomingMessage, res: ServerResponse) => void` — writes headers and holds the connection open.
    - Sends an initial `connected` event on open.
    - Sends heartbeat comments (`: heartbeat\n\n`) at a configurable interval (default 30s).
    - Tracks connected clients for broadcast.
    - Cleans up on client disconnect.
11. **`channel.respond(req, res?)`** — Creates a scoped SSE emitter for request-response patterns (like `POST /api/query` that streams results and closes).
    - Same dual signature as `connect()`.
    - Returns an emitter with `emit()` and `close()`.
    - Does NOT add the client to the broadcast pool.
    - Does NOT send heartbeats (response-scoped, short-lived).
12. **`channel.emit(eventType, payload)`** — Broadcasts a type-safe event to all connected clients.
    - `eventType` is constrained to the schema's event names.
    - `payload` is type-checked against the schema's payload type for that event.
    - Formats the event as SSE wire format (`event: <type>\ndata: <json>\n\n`).
    - Skips disconnected clients, cleans up stale connections.
13. **`channel.close()`** — Closes all connections and stops heartbeat timers.
14. No framework dependencies — works with raw `http.createServer`, Express, Fastify, Hono, Cloudflare Workers, Deno.

#### SSEProvider `schema` Prop

15. `SSEProviderProps` accepts an optional `schema` prop (output of `defineSchema()`).
16. When `schema` is provided, the `events` mapping is auto-derived from the schema's event definitions (key mappings, update strategies, filters, transforms).
17. `schema` and manual `events` are mutually exclusive — providing both is a TypeScript error (discriminated union or overloaded prop types).
18. The `url` prop remains required (the schema does not encode endpoint URLs).

#### `mockSSE.sendSSE(data)` Testing Helper

19. New method on `MockSSEControls`: `sendSSE(data: unknown)` — sends `data: ${JSON.stringify(data)}\n\n` via the existing `sendRaw()` path. *(Friction log item #7)*
20. Convenience for testing `createSSEParser` consumers who work with raw SSE wire format.

### Out of Scope

- Database adapters and `channel.watch()` (PRD-0003)
- CRUD resource grouping in schema (PRD-0003)
- WebSocket transport
- Authentication/authorization middleware
- Client-side offline/optimistic updates
- Compression (gzip/deflate on SSE stream)
- Friction log item #4 (Vitest resolve aliases) — this is a consumer-side workaround for `link:` protocol, not fixable in reactiveSWR itself. Will be resolved when the package is published to npm. Document the workaround in the README.
- Friction log item #5 (imperative `createSSEParser` pattern) — already works, just needs README documentation
- Friction log item #6 (lazy SSEProvider connection) — separate concern, can be addressed independently

## Requirements

### Functional Requirements

#### Build Pipeline

1. The mock fetch in `src/testing/index.ts` shall be cast as `typeof globalThis.fetch` to satisfy `tsc` declaration generation with `@types/node` 24+.
2. `package.json` shall include a `"prepare": "bun run build"` script.
3. The `build` script shall compile all entry points (`src/index.ts`, `src/testing/index.ts`, `src/server/index.ts`) and generate `.d.ts` files via a `tsc` step.
4. `package.json` `exports` shall include a `"./server"` subpath:
   ```json
   "./server": {
     "import": "./dist/server/index.js",
     "types": "./dist/server/index.d.ts"
   }
   ```
5. `bun run build` shall produce a working package that can be consumed via `link:` protocol without manual steps.

#### `defineSchema()`

6. `defineSchema(definition)` shall accept a definition object where keys are event type names and values describe payload type, cache key mapping, update strategy, and optional filter/transform.
7. The return value shall be a frozen object that carries full TypeScript type information for event names and payload shapes.
8. The schema object shall be importable from `reactive-swr` (main entry point) since it contains no server-only or client-only code.
9. Event names in the schema shall be string literals (not `string`) so that `channel.emit()` and `SSEProvider` get autocomplete.
10. Each event definition shall support:
    - `payload`: TypeScript type (via generic inference, not a runtime value)
    - `key`: `string | string[] | ((payload: TPayload) => string | string[])` — the SWR cache key(s) to update
    - `update`: `'set' | 'refetch' | ((current: TData | undefined, payload: TPayload) => TData)` — defaults to `'set'`
    - `filter`: `(payload: TPayload) => boolean` — optional client-side filter
    - `transform`: `(payload: TPayload) => TPayload` — optional client-side transform

#### `createChannel(schema)`

11. `createChannel(schema)` shall accept a schema object returned by `defineSchema()` and return a channel object.
12. `channel.connect()` shall accept either a Web standard `Request` (returning a `Response`) or Node.js `IncomingMessage` + `ServerResponse` (returning `void`).
13. `channel.connect()` shall set response headers: `Content-Type: text/event-stream`, `Cache-Control: no-cache`, `Connection: keep-alive`.
14. `channel.connect()` shall send an initial event indicating successful connection.
15. `channel.connect()` shall send heartbeat comments at a configurable interval (default 30 seconds).
16. `channel.connect()` shall detect client disconnection and clean up resources.
17. `channel.respond()` shall have the same dual signature as `connect()` but return a scoped emitter `{ emit(type, payload), close() }`.
18. `channel.respond()` emitters shall NOT be added to the broadcast client pool.
19. `channel.respond()` emitters shall NOT send heartbeats.
20. `channel.emit(eventType, payload)` shall broadcast to all clients connected via `connect()`.
21. `channel.emit()` shall format events as SSE wire format: `event: <type>\ndata: <json>\n\n`.
22. `channel.emit()` shall type-check `eventType` against schema event names and `payload` against the corresponding payload type.
23. `channel.close()` shall close all connections, stop all heartbeat timers, and release all resources.
24. The server module shall import zero framework-specific dependencies.

#### SSEProvider `schema` Prop

25. `SSEConfig` shall accept an optional `schema` property.
26. When `schema` is provided, the `events` property shall be automatically derived from the schema — the consumer does not provide `events`.
27. Providing both `schema` and `events` shall be a TypeScript compile error.
28. The auto-derived `events` mapping shall use the schema's `key`, `update`, `filter`, and `transform` definitions for each event type.
29. The `parseEvent` callback shall remain configurable even when using `schema`.
30. All existing SSEProvider behavior (reconnection, status, debug) shall be unaffected.

#### `mockSSE.sendSSE(data)`

31. `MockSSEControls` shall expose a `sendSSE(data: unknown): void` method.
32. `sendSSE(data)` shall call `sendRaw(\`data: ${JSON.stringify(data)}\n\n\`)` internally.
33. Existing `sendEvent()` and `sendRaw()` methods shall remain unchanged.

### Non-Functional Requirements

1. The `reactive-swr/server` entry point shall be tree-shakeable — importing `reactive-swr` (client) shall not pull in server code.
2. `createChannel` shall handle at least 1000 concurrent SSE connections without degradation (no per-client timers — use a single shared heartbeat interval).
3. All new public types shall be fully typed with TypeScript and exported from their respective entry points.
4. The server module shall work in Node.js 18+, Deno, and Cloudflare Workers (Web standard APIs).
5. `defineSchema()` shall add zero bytes to the runtime bundle when only types are used — the runtime cost shall be limited to the schema object creation.

## Edge Cases & Error States

- **Schema with zero events:** `defineSchema({})` shall return a valid (empty) schema. `channel.emit()` will have no valid event types (TypeScript error). `SSEProvider` with this schema will have no event mappings (no-op).
- **`channel.emit()` with no connected clients:** Shall be a no-op (no error thrown).
- **Client disconnects during `channel.emit()`:** The write to the disconnected client shall fail silently. The client shall be removed from the pool. Remaining clients shall still receive the event.
- **`channel.connect()` called after `channel.close()`:** Shall throw an error indicating the channel is closed.
- **`channel.respond()` emitter used after `close()`:** `emit()` after `close()` shall be a no-op or throw — consistent with the `connect()` post-close behavior.
- **Multiple `channel.connect()` calls from same client (browser tab refresh):** Each call creates a new connection. The old connection's disconnect handler cleans it up from the pool. No deduplication.
- **`schema` and `events` both provided to SSEProvider:** TypeScript compile error. If somehow bypassed at runtime, `schema` takes precedence and a console warning is emitted in debug mode.
- **Heartbeat write fails (client silently disconnected):** The failed write triggers the disconnect handler, removing the client from the pool.
- **Web standard `Request` body not consumed:** `channel.connect()` does not read the request body (it's a persistent GET). `channel.respond()` does not read the body either — the consumer reads it before calling `respond()`.
- **Node.js response already ended:** If `res.writableEnded` is true when `connect()` is called, it shall throw immediately.
- **`sendSSE()` with non-serializable data:** `JSON.stringify()` throws — the error propagates to the test (this is correct behavior, not something to swallow).

## Implementation Order

This is the recommended order for `/ateam plan`:

1. **Build pipeline fixes** (friction log items #1–#3 + `./server` subpath) — unblocks everything else
2. **`defineSchema()`** — pure types + frozen object, no dependencies
3. **`mockSSE.sendSSE()`** — small addition to testing module
4. **`createChannel(schema)`** — server-side, depends on schema
5. **SSEProvider `schema` prop** — client-side, depends on schema

Items 2 and 3 can be parallelized. Item 4 and 5 can be parallelized after 2 completes.

## Dependencies

- **Internal:** `src/types.ts` — `EventMapping`, `UpdateStrategy`, `SSEConfig` types need extension
- **Internal:** `src/SSEProvider.tsx` — needs `schema` prop support
- **Internal:** `src/testing/index.ts` — needs fetch type cast fix and `sendSSE()` method
- **Internal:** `package.json`, `tsconfig.json` — build pipeline changes
- **Runtime (server):** Node.js `http` module (for Node.js signature), Web standard `ReadableStream` + `Response` (for Web signature)
- **No new external dependencies**

## Risks & Open Questions

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Dual Web/Node signature adds complexity | Medium | API surface harder to test | Test both signatures explicitly; use runtime detection (`instanceof Request`) |
| Schema type inference too complex for TypeScript | Low | Poor DX, `any` fallback | Prototype the generic types early; keep schema definition shape simple |
| `prepare` script slows `npm install` for published package | Low | Minor annoyance | `prepare` only runs for git-based installs, not registry installs |
| Heartbeat across 1000+ connections | Low | Memory/CPU pressure | Single `setInterval` iterates the pool, no per-client timers |

### Open Questions

1. **Heartbeat interval configuration:** Should this be on `createChannel(schema, options)` or `channel.connect(req, res, options)`? Recommendation: `createChannel` options, since heartbeat is channel-wide.
2. **`channel.respond()` naming:** Alternative names considered: `channel.stream()`, `channel.scoped()`. `respond()` was chosen to match the request-response mental model. Open to bikeshedding.
