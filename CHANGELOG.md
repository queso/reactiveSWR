# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

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
