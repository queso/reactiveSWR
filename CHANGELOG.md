# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.2.2] - 2026-11-26

### Fixed
- `mockSSE(...).sendEvent()` delivers each event once, as the named event `createChannel` sends (`event: <type>`, data is the payload). In 0.2.1 it called `onmessage` with `{ type, payload }` and also dispatched a named event carrying that same `{ type, payload }` JSON, so for a type in your schema or `events` the cache ended up holding `{ type, payload }` instead of the payload (#11)
- The `'refetch'` update strategy revalidates without clearing the cached value. In 0.2.1 it wrote `undefined` to the cache first, so without `keepPreviousData` the screen blanked on every refetch event, and with it `isLoading` went true as if on a first load (#12)
- `SSEProvider` keeps its connection under React StrictMode (on by default in `next dev`). In 0.2.1 StrictMode's extra effect cleanup closed the stream and nothing reopened it, and the tab-visibility reconnect listener was lost the same way. The connection now opens in an effect after mount instead of during render (#13)
- Connections no longer leak when a child of `SSEProvider` suspends. In 0.2.1 each render attempt of a suspended tree opened a connection during render that was never closed (three on one mount in our test, six on one page load in an app) (#13)
- Unmounting `SSEProvider` after a reconnect or a URL change closes the current connection. In 0.2.1 it closed the first connection and left the newer one open (#13)

### Changed
- **This can change a passing test.** `sendEvent` no longer calls `onmessage` on the mock `EventSource`. A test that reads events through `onmessage`, or through `useSSEEvent` for a type that is not in the provider's schema or `events`, stops receiving them, as it would against `createChannel`. If your server sends unnamed `{ type, payload }` messages, use `mockSSE(url, { eventFormat: 'unnamed' })` (#11)
- Custom and fetch transports no longer open during server rendering. In 0.2.1 `SSEProvider` opened a custom `transport`, or the fetch transport selected by `method`, `body` or `headers`, during render, so it also ran on the server; the fetch transport called `fetch` there. Now nothing opens during server rendering for any transport. On the client the first render still reports `connecting: true`; a transport factory that throws now reports its error on the render after mount instead of the first (#13)
- `onDisconnect` on unmount is called only if the connection had opened. In 0.2.1 it was also called when unmounting while still connecting, without a matching `onConnect` (#13)

### Added
- `mockSSE(url, { eventFormat: 'unnamed' })` option, and the `MockSSEOptions` and `MockEventFormat` types from `reactive-swr/testing` (#11)

## [0.2.1] - 2026-11-26

### Fixed
- The published client bundle no longer uses the development JSX runtime. 0.2.0 imported `jsxDEV` from `react/jsx-dev-runtime`, which production React leaves undefined, so `SSEProvider` crashed in production builds (`jsxDEV is not a function`) and failed `next build` while prerendering. The build now pins `NODE_ENV=production` (#6)
- `defineSchema` can be imported in a Next.js App Router route handler. In 0.2.0 it was exported only from the package root, which loads SWR's hooks, and the route handler build failed with `The export useSWRConfig was not found` (#7)

### Added
- `reactive-swr/schema` entry point with `defineSchema` and the schema types. It loads no React or SWR code (#7)
- `defineSchema` and the schema types re-exported from `reactive-swr/server` (#7)
- `scripts/check-dist.ts`, run at the end of `bun run build`: fails when a built file uses the development JSX runtime, when a `package.json` export points at a file that was not built, or when `dist/schema.js` or anything under `dist/server/` imports `react` or `swr` (#6, #7)
- `bun run check:next`: packs the package and runs `next build` on `fixtures/next-app` (a route handler that imports the schema and `createChannel`, and a client page that renders `SSEProvider`). Runs in CI (#6, #7)

### Changed
- `typescript` is a dev dependency. The build and typecheck used whichever `tsc` was on the machine before

## [0.2.0] - 2026-03-04

### Added
- `SSEAdapter` interface and `AdapterMapping` type for building database/event source adapters (`reactive-swr/server`) (#WI-244)
- `channel.watch(adapter)` method to connect adapters to SSE channels with idempotent cleanup (#WI-246)
- `createPrismaAdapter(prisma, mapping)` adapter for automatic SSE emission from Prisma `$use()` middleware (#WI-247)
- `createMongoAdapter(collection, mapping)` adapter for MongoDB Change Streams with resume token support (#WI-248)
- `createPgAdapter(client, mapping)` adapter for PostgreSQL LISTEN/NOTIFY with SQL identifier quoting (#WI-249)
- `createEmitterAdapter(emitter, mapping)` adapter for bridging any `on`/`off`-compatible event emitter (#WI-250)
- Schema `resources` field in `defineSchema()` that auto-expands CRUD event triplets (`<resource>.created`, `<resource>.updated`, `<resource>.deleted`) (#WI-245)
- `ResourceDefinition` and `ResourceOperationDefinition` types for schema resource definitions (#WI-245)
- Subpath exports for individual adapters: `reactive-swr/server/adapters/prisma`, `reactive-swr/server/adapters/mongodb`, `reactive-swr/server/adapters/pg`, `reactive-swr/server/adapters/emitter` (#WI-251)
- Barrel export file for all adapters at `src/server/adapters/index.ts` (#WI-251)
- `SSEProviderError` class with typed error codes (`TRANSPORT`, `NETWORK`, `PARSE`) for structured error handling
- `SSEErrorCode` type exported from main entry point
- `setLatency(ms)` and `resetLatency()` methods on `mockSSE` controls for simulating network delays in tests
- `formatSSEData` and `formatSSEEvent` re-exported from `reactive-swr/server` entry point
- Troubleshooting section in SPEC.md covering connection issues, missing events, memory growth, and reconnection
- Documentation for `maxAttempts` exhaustion behavior and tab visibility interaction

### Fixed
- `SchemaResult` type now includes resource-expanded event keys (`.created`/`.updated`/`.deleted`) for proper TypeScript inference
- `defineSchema()` logs a `console.warn` when an explicit event overrides a resource-generated event
- MongoDB adapter `start()` is now properly async (awaits stream setup instead of fire-and-forget)
- MongoDB reconnect counter only resets on fresh `start()`, not on every event emission
- PostgreSQL adapter sets `started = true` after LISTEN queries succeed, not before
- PostgreSQL adapter always quotes identifiers to handle reserved keywords like `select`
- PostgreSQL adapter warns when client lacks `off()`/`removeListener()` for cleanup
- Prisma adapter propagates `$use()` registration errors and resets state on failure
- EventEmitter adapter defers `started = true` until all listeners are registered; `off()` calls wrapped in try/catch
- EventEmitter adapter resets `started = false` in `stop()` to allow restart
- `channel.watch()` clears stopped state on re-watch so the same adapter can be reused
- Channel error messages now include operation context (e.g., "Cannot connect: channel is closed")
- Race condition during rapid URL changes — added re-entrancy guard and generation counter to prevent overlapping `createConnection()` calls and out-of-order `onConnect`/`onDisconnect` callbacks
- Non-Error throws in custom `parseEvent` callbacks now properly wrapped in `Error` instances
- `SSEProviderError` always preserves the original thrown value as `cause` for debugging
- Transport errors passed to `onEventError` now use the same `SSEProviderError` instance as `updateStatus`

### Changed
- `defineSchema()` now accepts an optional `resources` key alongside explicit event definitions; explicit definitions take precedence over generated resource events (#WI-245)
- `channel.close()` now stops all watched adapters in addition to closing client connections (#WI-246)
- Build script updated to compile individual adapter entry points for tree-shakeable imports (#WI-251)
- `tsconfig.emit.json` updated to include adapter source files for declaration generation (#WI-251)
- `SSEConfigWithSchema.schema` type tightened from `Record<string, any>` to `Record<string, unknown>`
- `mockSSE` send methods (`sendEvent`, `sendRaw`, `sendSSE`) now return `Promise<void>` to support latency simulation

### Removed
- Redundant build pipeline test that duplicated CI build step verification

## [0.1.0] - 2026-02-22

### Added
- `defineSchema()` function for shared, type-safe event definitions consumed by both server and client (#WI-037)
- `createChannel(schema)` server-side SSE channel with dual Web/Node.js signatures, heartbeats, broadcast, and disconnect cleanup (#WI-039)
- `reactive-swr/server` subpath export for tree-shakeable server-side imports (#WI-036)
- `schema` prop on `SSEProvider` to auto-derive `events` mapping from a `defineSchema()` result (#WI-040)
- `sendSSE(data)` convenience method on `mockSSE` controls for simpler test assertions (#WI-038)
- `channel.connect()` for persistent SSE connections with initial `connected` event and configurable heartbeat interval
- `channel.respond()` for scoped request-response SSE emitters (no broadcast pool, no heartbeats)
- `channel.emit()` for type-safe broadcast to all connected clients with automatic dead-client cleanup
- `channel.close()` for graceful shutdown of all connections and heartbeat timers
- `SchemaDefinition`, `SchemaEventDefinition`, and `SchemaResult` types exported from main entry point
- `prepare` script (`bun run build`) for automatic builds on `link:` installs (#WI-036)
- `tsconfig.emit.json` for `.d.ts` declaration generation across all entry points (#WI-036)

### Changed
- Build script now compiles all three entry points (`index`, `testing`, `server`) with external peer deps (#WI-036)
- Mock fetch in testing module cast as `typeof globalThis.fetch` for `@types/node` 24+ compatibility (#WI-036)
- `SSEConfig` now accepts either `events` (manual) or `schema` (auto-derived), mutually exclusive at the type level (#WI-040)

### Previous

#### Added (Transport Abstraction)
- Transport abstraction layer for non-GET SSE connections (#WI-216, #WI-218, #WI-219, #WI-220)
- POST SSE support via `method` and `body` options in `useSSEStream` and `SSEProvider`
- Custom HTTP headers for SSE connections via `headers` option
- Custom transport factory via `transport` option for full control over SSE connections
- Automatic JSON serialization for plain object request bodies with `Content-Type: application/json`
- Body-implies-POST behavior: providing `body` without `method` defaults to POST
- `SSETransport` interface for building custom transport implementations (#WI-216)
- `SSERequestOptions` type for method/body/headers grouping (#WI-216)
- `createSSEParser` export for advanced users building custom transports (#WI-217, #WI-222)
- Spec-compliant SSE wire format parser with chunked input support (#WI-217)
- Fetch-based SSE transport using `fetch()` + `ReadableStream` (#WI-218)
- Shared reconnection utilities with exponential backoff (#WI-223)
- Unified reconnection for all transport types in SSEProvider (#WI-220)
- Composite connection keys in `useSSEStream` for proper connection reuse across different request configurations (#WI-219)
- Dual EventSource + fetch interception in `mockSSE` test utility (#WI-221)
- `sendRaw()` method on `mockSSE` controls for testing SSE parser edge cases (#WI-221)
