# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

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

### Changed
- `defineSchema()` now accepts an optional `resources` key alongside explicit event definitions; explicit definitions take precedence over generated resource events (#WI-245)
- `channel.close()` now stops all watched adapters in addition to closing client connections (#WI-246)
- Build script updated to compile individual adapter entry points for tree-shakeable imports (#WI-251)
- `tsconfig.emit.json` updated to include adapter source files for declaration generation (#WI-251)

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
