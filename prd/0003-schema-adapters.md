# PRD-0003: Schema Adapters

**Author:** Josh
**Date:** 2026-02-16
**Status:** Draft (Roadmap)
**Depends on:** PRD-0002 (Schema & Channel)

## Problem Statement

PRD-0002 introduces `defineSchema()` and `createChannel(schema)`, giving reactiveSWR a shared contract between server and client and a clean API for emitting SSE events. But `channel.emit()` is still manual — the developer must call it at the right time, in response to the right data change. This is the last piece of boilerplate standing between the developer and Meteor-style reactivity: automatically emitting SSE events when the underlying data changes.

Database systems already provide change notification mechanisms — MongoDB Change Streams, PostgreSQL LISTEN/NOTIFY, Prisma middleware hooks. An adapter layer that bridges these mechanisms to `channel.emit()` completes the reactive pipeline: **data change → adapter → channel.emit() → SSE → SWR cache update**.

## Business Context

- **Closes the automation gap:** PRD-0002 makes emission type-safe but still manual. Adapters make it automatic.
- **Familiar model:** This is Meteor's Oplog tailing pattern, but pluggable — developers bring their own database client and reactiveSWR provides the glue.
- **Ecosystem play:** Per-adapter packages (or tree-shakeable imports) let the community contribute adapters without bloating the core.
- **Zero vendor lock-in:** Each adapter accepts a pre-configured client instance. reactiveSWR never imports a database driver directly.

## Goals & Success Metrics

| Goal | Metric | Target |
|------|--------|--------|
| Automatic emission from data changes | Developer connects an adapter and `channel.emit()` fires on data mutations | Works end-to-end with at least one adapter |
| Zero direct DB driver dependencies | Adapter accepts a client instance, never `import`s a driver | `reactive-swr/server` `package.json` has no DB driver deps |
| Tree-shakeable adapters | Importing one adapter doesn't pull in others | Bundle analysis confirms dead-code elimination |
| Enhanced schema resources | CRUD grouping reduces boilerplate for common patterns | `orders: { created, updated, deleted }` generates three event types from one declaration |

## User Stories

- **As a** developer with a Prisma-based app, **I want** to plug a Prisma middleware adapter into my channel **so that** SSE events fire automatically on create/update/delete — without manual `channel.emit()` calls.
- **As a** developer with a MongoDB app, **I want** to connect a Change Streams adapter **so that** document changes are automatically broadcast to connected clients.
- **As a** developer with a PostgreSQL app, **I want** a LISTEN/NOTIFY adapter **so that** I can trigger SSE events from database triggers or application-level notifications.
- **As a** developer with a custom event source (Redis pub/sub, AMQP, etc.), **I want** a generic EventEmitter adapter **so that** I can bridge any event source to `channel.emit()`.
- **As a** schema author, **I want** to define CRUD resource groups in my schema **so that** `orders.created`, `orders.updated`, and `orders.deleted` events are generated from a single `orders` resource definition.

## Scope

### In Scope

- **`SSEAdapter` interface** — standard contract for adapters: `start()`, `stop()`, and a callback hook for emitting events.
- **`channel.watch(adapter)`** — method on the channel object (from PRD-0002) that connects an adapter and routes its events through `channel.emit()`.
- **Prisma adapter** — wraps Prisma middleware `$use()` to intercept create/update/delete operations and emit corresponding events.
- **MongoDB adapter** — wraps a MongoDB `Collection.watch()` Change Stream and maps `insert`, `update`, `replace`, `delete` operations to schema events.
- **PostgreSQL adapter** — wraps `pg` client `LISTEN`/`NOTIFY` and maps notification payloads to schema events.
- **Generic EventEmitter adapter** — wraps any Node.js `EventEmitter` (or compatible interface) and maps named events to schema events.
- **Enhanced schema `resources`** — a `resources` field in `defineSchema()` that expands `orders: { ... }` into `orders.created`, `orders.updated`, `orders.deleted` event definitions with appropriate payload types.
- **Tree-shakeable imports** — each adapter importable from `reactive-swr/server/adapters/<name>` or as named exports from `reactive-swr/server` with tree-shaking.

### Out of Scope

- Bidirectional sync (client writes back through the channel)
- Conflict resolution or CRDT-based merging
- Adapter-level filtering (e.g., only watch certain collections) — use the schema `filter` from PRD-0002
- Connection pooling or database client management — adapters accept pre-configured clients
- Real-time query subscriptions (Meteor `Tracker`-style) — this is cache invalidation, not live queries

## Requirements

### `SSEAdapter` Interface

1. The `SSEAdapter` interface shall define:
   - `start(emit: (eventType: string, payload: unknown) => void): void | Promise<void>` — begins watching for changes, calling `emit` when they occur.
   - `stop(): void | Promise<void>` — stops watching and cleans up resources.
2. Adapters shall be stateless with respect to the channel — the channel provides the `emit` callback, the adapter calls it.
3. Adapters shall handle their own reconnection logic for the underlying data source (e.g., Change Stream resume tokens).

### `channel.watch(adapter)`

4. `channel.watch(adapter)` shall accept an `SSEAdapter` instance and call `adapter.start()` with a bound `channel.emit()` callback.
5. `channel.watch()` shall return a cleanup function that calls `adapter.stop()`.
6. `channel.close()` shall stop all watched adapters.
7. Multiple adapters can be watched simultaneously on the same channel.

### Prisma Adapter

8. `createPrismaAdapter(prisma, mapping)` shall accept a Prisma client instance and a mapping from Prisma model names to schema event types.
9. The adapter shall use Prisma's `$use()` middleware to intercept `create`, `update`, and `delete` operations.
10. The adapter shall emit events after the operation completes (post-middleware), not before.

### MongoDB Adapter

11. `createMongoAdapter(collection, mapping)` shall accept a MongoDB `Collection` and a mapping from Change Stream operation types to schema event types.
12. The adapter shall use `collection.watch()` to open a Change Stream.
13. The adapter shall persist resume tokens so that reconnection picks up where it left off.

### PostgreSQL Adapter

14. `createPgAdapter(client, mapping)` shall accept a `pg` `Client` instance and a mapping from NOTIFY channel names to schema event types.
15. The adapter shall call `client.query('LISTEN channel_name')` for each mapped channel.
16. The adapter shall parse the NOTIFY payload as JSON and pass it to `emit`.

### Generic EventEmitter Adapter

17. `createEmitterAdapter(emitter, mapping)` shall accept any object with `on(event, listener)` and `off(event, listener)` methods.
18. The mapping shall map emitter event names to schema event types.

### Enhanced Schema Resources

19. `defineSchema()` shall accept an optional `resources` field alongside `events`.
20. Each resource key (e.g., `orders`) shall expand into `<resource>.created`, `<resource>.updated`, and `<resource>.deleted` event definitions.
21. Resource definitions shall support custom payload types per operation.
22. The expanded events shall be merged with any explicitly defined `events` — explicit definitions take precedence over generated ones.

### Non-Functional Requirements

1. Each adapter shall be importable independently without pulling in other adapters' code.
2. Adapters shall not import database driver packages — they accept pre-configured client instances typed with `typeof` the driver's client class.
3. The `SSEAdapter` interface shall be exported from `reactive-swr/server` for third-party adapter authors.

## Edge Cases & Error States

- **Adapter `start()` throws:** `channel.watch()` shall propagate the error to the caller.
- **Adapter emits unknown event type:** `channel.emit()` already type-checks at the TypeScript level. At runtime, unknown event types shall be logged as warnings (when `debug: true`) and dropped.
- **Database connection lost mid-watch:** Each adapter is responsible for its own reconnection. The `SSEAdapter` contract does not mandate reconnection — it's adapter-specific.
- **`channel.watch()` called after `channel.close()`:** Shall throw, consistent with PRD-0002's post-close behavior.
- **Prisma middleware ordering:** The adapter's middleware runs after all other middleware in the chain. Document that it should be registered last.
- **MongoDB Change Stream invalidation:** The adapter shall handle `invalidate` events by reopening the stream.
- **PostgreSQL NOTIFY payload too large (8000 byte limit):** Document the limitation. The adapter does not work around it — the developer must keep payloads small or use a different adapter.

## Dependencies

- **PRD-0002:** `defineSchema()`, `createChannel()`, `channel.emit()` — all must be implemented first.
- **Runtime (per adapter):**
  - Prisma: `@prisma/client` (peer, typed via `typeof`)
  - MongoDB: `mongodb` (peer, typed via `typeof`)
  - PostgreSQL: `pg` (peer, typed via `typeof`)
  - EventEmitter: Node.js built-in or any object with `on`/`off`

## Risks & Open Questions

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Adapter maintenance burden | Medium | Each adapter needs updates when DB drivers change | Minimal API surface (just `start`/`stop`); accept client instances, not version-specific APIs |
| Prisma `$use()` deprecated in future Prisma versions | Medium | Adapter breaks | Monitor Prisma changelog; `$use()` is stable today but Prisma is moving toward extensions |
| TypeScript generics complexity with resources + adapters | Medium | Poor DX | Keep the type-level expansion simple; test with real-world schema sizes |
| Scope creep into query subscriptions | Low | Conflates cache invalidation with live queries | Explicitly out of scope; document the difference |

### Open Questions

1. **Adapter package structure:** Should adapters live in `reactive-swr/server/adapters/prisma` (subpath exports) or in separate packages (`@reactive-swr/adapter-prisma`)? Subpath exports are simpler to start; separate packages allow independent versioning.
2. **Resource CRUD customization:** Should `resources` support custom operation names beyond `created/updated/deleted`? E.g., `orders: { operations: ['placed', 'shipped', 'cancelled'] }`. Leaning toward keeping it simple with the standard three and letting explicit `events` handle custom cases.
3. **Adapter priority ordering:** When multiple adapters emit the same event type, should there be a priority system or does last-write-win? Recommendation: no priority — events are independent and broadcast in order received.
