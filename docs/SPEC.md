# reactiveSWR Technical Specification

## Overview

reactiveSWR is a declarative bridge between Server-Sent Events (SSE) and SWR's cache layer. It enables Meteor-style reactive data fetching in modern React applications without the complexity of a full real-time framework.

The library spans both client and server: the client-side SSEProvider manages connections and routes events into SWR's cache, while the server-side `createChannel` broadcasts typed events over SSE to connected clients. A shared `defineSchema()` function ties the two together with a single, frozen type-safe contract.

## Goals

1. **Simplicity** - Minimal API surface, easy to understand and adopt
2. **Transparency** - Components don't know about SSE; they just use `useSWR`
3. **Efficiency** - No redundant API calls when SSE provides full payloads
4. **Flexibility** - Support various update strategies, custom merge logic, and transport mechanisms
5. **Type Safety** - Full TypeScript support with inferred types from shared schemas
6. **Universal** - Server-side channel works on Web standard (Fetch API / edge runtimes) and Node.js

## Non-Goals

1. Not a full Meteor replacement (no client-side query engine)
2. Not a state management solution (use SWR for that)
3. Not a WebSocket library (SSE-focused, though patterns are similar)
4. Not an offline-first solution (pairs well with SWR's existing features)

---

## Architecture

### Data Flow

```
┌─────────────────────────────────────────────────────────────────────┐
│                             Server                                  │
│  ┌─────────────┐     ┌──────────────┐     ┌─────────────────────┐  │
│  │  Database   │────>│  Change      │────>│  createChannel()    │  │
│  │  (Mongo,    │     │  Detection   │     │  .emit(type, data)  │  │
│  │   Postgres) │     │              │     │  .connect(req, res) │  │
│  └─────────────┘     └──────────────┘     └──────────┬──────────┘  │
│                                                       │             │
│                              defineSchema()           │             │
│                              (shared contract)        │             │
└──────────────────────────────────────────────┼────────┘─────────────┘
                                               │
                                     SSE Stream│(text/event-stream)
                                               │
┌──────────────────────────────────────────────┼──────────────────────┐
│                             Client           ▼                      │
│                                                                     │
│  ┌───────────────────────────────────────────────────────────────┐  │
│  │                       Transport Layer                         │  │
│  │  EventSource | createFetchTransport | custom transport        │  │
│  └──────────────────────────┬────────────────────────────────────┘  │
│                              │                                      │
│  ┌───────────────────────────▼───────────────────────────────────┐  │
│  │  SSEProvider  (schema | events)                               │  │
│  │  ┌─────────────────┐     ┌─────────────────┐                 │  │
│  │  │ Connection Mgmt │────>│  Event Router   │                 │  │
│  │  │ (reconnection,  │     │  (config-based) │                 │  │
│  │  │  visibility)    │     └────────┬────────┘                 │  │
│  │  └─────────────────┘              │                          │  │
│  └───────────────────────────────────┼──────────────────────────┘  │
│                                      │                              │
│                       ┌──────────────┼──────────────┐              │
│                       ▼              ▼              ▼              │
│                 ┌──────────┐  ┌──────────┐  ┌──────────┐          │
│                 │ mutate() │  │ mutate() │  │ mutate() │          │
│                 │ key: /a  │  │ key: /b  │  │ key: /c  │          │
│                 └────┬─────┘  └────┬─────┘  └────┬─────┘          │
│                      │             │             │                 │
│                      └─────────────┼─────────────┘                 │
│                                    ▼                               │
│                       ┌─────────────────────┐                      │
│                       │     SWR Cache       │                      │
│                       │  (In-memory store)  │                      │
│                       └──────────┬──────────┘                      │
│                                  │                                 │
│                 ┌────────────────┼────────────────┐                │
│                 ▼                ▼                ▼                │
│           ┌──────────┐    ┌──────────┐    ┌──────────┐            │
│           │Component │    │Component │    │Component │            │
│           │useSWR(/a)│    │useSWR(/b)│    │useSWR(/c)│            │
│           └──────────┘    └──────────┘    └──────────┘            │
│                                                                    │
└────────────────────────────────────────────────────────────────────┘
```

### Key Components

#### 1. defineSchema (shared)

A function that creates a frozen, type-safe schema object shared between server and client. The schema defines event names, SWR cache key mappings, and update strategies. It serves as the single source of truth for the SSE contract.

#### 2. SSEProvider (client)

A React context provider that:
- Establishes and maintains the SSE connection via a transport layer
- Accepts either a `schema` (from `defineSchema`) or manual `events` mapping
- Parses incoming events (both named and unnamed)
- Routes events to the appropriate SWR cache keys via `mutate()`
- Handles reconnection on failure with exponential backoff
- Exposes connection status and a subscribe API to children

#### 3. Transport Layer (client)

An abstraction over EventSource that supports:
- Native `EventSource` for standard GET-based SSE
- `createFetchTransport` for POST requests, custom headers, and request bodies
- Custom transport factories for arbitrary SSE-compatible connections

#### 4. Event Mapping Configuration

A declarative object that defines:
- Which event types to listen for
- How to resolve SWR cache key(s) from event payloads
- What update strategy to use (set, refetch, or custom merge)

#### 5. createChannel (server)

A server-side broadcast pool that:
- Manages persistent SSE connections with heartbeats
- Supports both Web standard (ReadableStream) and Node.js (ServerResponse) runtimes
- Provides scoped request-response emitters for one-shot SSE responses
- Handles dead-client cleanup on broadcast

#### 6. Update Strategies

Three built-in strategies:
- **`set`** - Replace cache with SSE payload (no network request)
- **`refetch`** - Ignore payload, trigger SWR revalidation (for notifications)
- **`(current, payload) => newValue`** - Custom merge function

---

## API Specification

### defineSchema

```typescript
function defineSchema<T extends SchemaDefinition>(
  definition: T,
): SchemaResult<T>

type SchemaDefinition = Record<string, SchemaEventDefinition>

interface SchemaEventDefinition<TPayload = any, TData = any> {
  key: string | string[] | ((payload: TPayload) => string | string[])
  update?: UpdateStrategy<TPayload, TData>
  filter?: (payload: TPayload) => boolean
  transform?: (payload: TPayload) => TPayload
}

type SchemaResult<T extends SchemaDefinition> = Readonly<{
  [K in keyof T]: Required<Pick<T[K], 'key'>> &
    Omit<T[K], 'key'> & { update: NonNullable<T[K]['update']> | 'set' }
}>
```

`defineSchema()` freezes the input and defaults `update` to `'set'` for any event that omits it. The returned object preserves string literal keys for full TypeScript inference and autocomplete.

The schema is consumed by `createChannel()` on the server (for type-safe `emit`) and by SSEProvider on the client (via the `schema` config prop, replacing manual `events` mapping).

### SSEConfig

SSEConfig is a **discriminated union** of three variants. Provide `schema`, `events`, or neither -- but never both. Providing both is a compile error; at runtime, `schema` takes precedence.

```typescript
type SSEConfig =
  | SSEConfigWithSchema
  | SSEConfigWithEvents
  | SSEConfigWithNeither

interface SSEConfigBase {
  /** SSE endpoint URL. Must return Content-Type: text/event-stream. */
  url: string

  /** Custom event parser. Default expects: { type, payload } JSON. */
  parseEvent?: (event: MessageEvent) => ParsedEvent

  /** Called when SSE connection opens. */
  onConnect?: () => void

  /** Called on SSE connection error. */
  onError?: (error: Event) => void

  /** Called when SSE connection closes. */
  onDisconnect?: () => void

  /** Reconnection configuration. */
  reconnect?: ReconnectConfig

  /** Log unhandled events and routing details. */
  debug?: boolean

  /** Called when processing a single event throws. */
  onEventError?: (event: ParsedEvent, error: unknown) => void

  /** HTTP method. Triggers fetch-based transport when set. */
  method?: string

  /** Request body. Triggers fetch-based transport. Plain objects are JSON-serialized. */
  body?: BodyInit | Record<string, unknown>

  /** Additional request headers. Triggers fetch-based transport when set. */
  headers?: Record<string, string>

  /**
   * Custom transport factory. Takes precedence over method/body/headers
   * and over EventSource.
   */
  transport?: (url: string) => SSETransport
}

/** Variant: auto-derive events from a defineSchema() result. */
interface SSEConfigWithSchema extends SSEConfigBase {
  schema: Record<string, any>
  events?: never
}

/** Variant: manual event mapping. */
interface SSEConfigWithEvents extends SSEConfigBase {
  events: Record<string, EventMapping<any, any>>
  schema?: never
}

/** Variant: no mapping. Useful with subscribe() for manual event handling. */
interface SSEConfigWithNeither extends SSEConfigBase {
  events?: never
  schema?: never
}
```

**Transport selection priority** (in SSEProvider and useSSEStream):

1. `transport` factory function, if provided
2. `createFetchTransport` when any of `method`, `body`, or `headers` is set
3. Native `EventSource` (default)

### SSETransport

```typescript
interface SSETransport {
  onmessage: ((event: MessageEvent) => void) | null
  onerror: ((event: Event) => void) | null
  onopen: ((event: Event) => void) | null
  close: () => void
  readyState: number

  /**
   * Add a listener for a named SSE data event.
   * This is ONLY for named SSE data events (e.g., "user.updated"),
   * not for generic DOM events like "open" or "error".
   */
  addEventListener: (
    type: string,
    listener: (event: MessageEvent) => void,
  ) => void

  /**
   * Remove a listener for a named SSE data event.
   */
  removeEventListener: (
    type: string,
    listener: (event: MessageEvent) => void,
  ) => void
}
```

The `SSETransport` interface mirrors the subset of `EventSource` used by the library. Any object conforming to this interface can serve as a transport. The `readyState` property uses the same numeric constants as EventSource: 0 (CONNECTING), 1 (OPEN), 2 (CLOSED).

### SSERequestOptions

```typescript
interface SSERequestOptions {
  method?: string
  body?: BodyInit | Record<string, unknown>
  headers?: Record<string, string>
}
```

### ParsedEvent

```typescript
interface ParsedEvent {
  type: string
  payload: unknown
}
```

### ReconnectConfig

```typescript
interface ReconnectConfig {
  /** Whether to automatically reconnect. Default: true */
  enabled?: boolean

  /** Initial delay before reconnecting (ms). Default: 1000 */
  initialDelay?: number

  /** Maximum delay between attempts (ms). Default: 30000 */
  maxDelay?: number

  /** Multiplier for exponential backoff. Default: 2 */
  backoffMultiplier?: number

  /** Maximum reconnection attempts. Default: Infinity */
  maxAttempts?: number
}
```

### EventMapping

```typescript
interface EventMapping<TPayload = any, TData = any> {
  /**
   * SWR cache key(s) to update when this event is received.
   * Static string, array of strings, or a function deriving key(s) from payload.
   */
  key: string | string[] | ((payload: TPayload) => string | string[])

  /**
   * How to update the cached data.
   * - "set": Replace cache with payload (no refetch)
   * - "refetch": Trigger SWR revalidation (ignores payload)
   * - function: Custom merge (current, payload) => newValue
   * Default: "set"
   */
  update?: UpdateStrategy<TPayload, TData>

  /** Return false to ignore this event. */
  filter?: (payload: TPayload) => boolean

  /** Transform payload before applying update strategy. */
  transform?: (payload: TPayload) => TPayload
}

type UpdateStrategy<TPayload, TData> =
  | 'set'
  | 'refetch'
  | ((current: TData | undefined, payload: TPayload) => TData)
```

### SSEProvider Component

```typescript
interface SSEProviderProps {
  config: SSEConfig
  children?: React.ReactNode
}

function SSEProvider(props: SSEProviderProps): JSX.Element
```

When `config.schema` is provided, SSEProvider derives an `events` record from the schema automatically. Each schema entry's `key`, `update`, `filter`, and `transform` are mapped directly to an `EventMapping`.

SSEProvider registers named event listeners on the transport for every key in the resolved `events` record. Unnamed (generic `message`) events are parsed with `parseEvent` (defaulting to `{ type, payload }` JSON). Named events use the event type as the key and parse `event.data` as the payload.

### createFetchTransport

```typescript
interface FetchTransportOptions {
  method?: string
  body?: BodyInit | Record<string, unknown>
  headers?: Record<string, string>
}

function createFetchTransport(
  url: string,
  options?: FetchTransportOptions,
): SSETransport
```

Creates a fetch-based SSE transport for scenarios where EventSource is insufficient (POST requests, custom headers, request bodies). Behavior:

- Plain object bodies are JSON-serialized with `Content-Type: application/json` auto-set
- When `body` is provided without `method`, defaults to POST
- Uses `createSSEParser` internally to parse the chunked SSE wire format from the response body stream
- Reads the response body via `ReadableStream.getReader()`, scheduling each read as a macrotask (`setTimeout(readNext, 0)`) so external code can interleave
- On stream end or error, transitions to `readyState: 2` (CLOSED) and fires `onerror`
- Supports `abort` via `AbortController` when `close()` is called

### Hooks

```typescript
/**
 * Returns the current SSE connection status.
 * Must be used within an SSEProvider.
 */
function useSSEStatus(): SSEStatus

interface SSEStatus {
  connected: boolean
  connecting: boolean
  error: Error | null
  reconnectAttempt: number
}

/**
 * Imperatively subscribe to raw SSE events.
 * Useful for events that don't map to SWR cache.
 * Must be used within an SSEProvider.
 */
function useSSEEvent<T = unknown>(
  eventType: string,
  handler: (payload: T) => void,
): void

/**
 * Direct SSE stream subscription (independent of SSEProvider).
 * Creates its own connection for dedicated streams.
 * Supports transport options for POST/custom connections.
 */
function useSSEStream<T = unknown>(
  url: string,
  options?: UseSSEStreamOptions<T>,
): UseSSEStreamResult<T>

interface UseSSEStreamOptions<T> {
  /** Transform incoming data before storing. Does NOT cause reconnection on change. */
  transform?: (data: unknown) => T
  /** HTTP method. When body is provided without method, defaults to POST. */
  method?: string
  /** Request body. Triggers fetch-based transport. */
  body?: BodyInit | Record<string, unknown>
  /** Additional request headers. Triggers fetch-based transport. */
  headers?: Record<string, string>
  /** Custom transport factory. Takes precedence over method/body/headers. */
  transport?: (url: string) => SSETransport
}

interface UseSSEStreamResult<T> {
  data: T | undefined
  error: Error | undefined
}
```

`useSSEStream` maintains a global connection pool keyed by URL + serialized options. Connections are reference-counted: multiple hook instances with the same key share one transport, and the transport is closed when the last subscriber unmounts. The `transform` function uses a ref pattern internally so changing its reference does not trigger a reconnection.

---

## SSE Wire Format

### Named Events

```
event: order:updated
data: {"id": "123", "status": "shipped"}

```

The SSE `event:` field sets the event type. The client receives this on a named listener, not on `onmessage`. SSEProvider registers `addEventListener` for each event type in the `events` config.

### Unnamed Events

```
data: {"type": "order:updated", "payload": {"id": "123", "status": "shipped"}}

```

Unnamed events fire on `onmessage`. The default parser expects `{ type, payload }` JSON. Override via `parseEvent` for other formats.

### Format Helpers

```typescript
/** Format a named SSE event: `event: type\ndata: json\n\n` */
function formatSSEEvent(type: string, payload: unknown): string

/** Format an unnamed SSE data message: `data: json\n\n` */
function formatSSEData(data: unknown): string
```

### SSE Parser

```typescript
interface SSEEvent {
  data: string
  event: string      // defaults to "message" for unnamed events
  id: string
  retry?: number
}

interface SSEParserCallbacks {
  onEvent: (event: SSEEvent) => void
  onRetry?: (ms: number) => void
}

interface SSEParser {
  feed(chunk: string): void
  reset(): void
}

function createSSEParser(callbacks: SSEParserCallbacks): SSEParser
```

`createSSEParser` is a standalone, stateful SSE wire format parser designed for custom transports (used internally by `createFetchTransport`). It handles:

- Chunked input (call `feed()` with each chunk as it arrives)
- BOM stripping at stream start
- All line ending styles: `\r\n`, `\r`, `\n`
- Trailing `\r` at chunk boundaries (deferred resolution)
- `retry:` field with integer validation
- Comment lines (`:` prefix) silently ignored
- Multi-line `data:` fields joined with `\n`
- Unknown fields ignored per the SSE specification

### Event ID and Reconnection

SSE supports automatic reconnection with last event ID:

```
id: 1001
event: order:updated
data: {"id": "123", "status": "shipped"}

id: 1002
event: order:updated
data: {"id": "124", "status": "pending"}
```

On reconnection, the browser sends `Last-Event-ID` header, allowing the server to replay missed events.

---

## Server-Side Channel

### createChannel

```typescript
import { createChannel } from 'reactive-swr/server'

function createChannel(
  schema: Record<string, any>,
  options?: ChannelOptions,
): Channel

interface ChannelOptions {
  /** Heartbeat interval in ms. Default: 30000 */
  heartbeatInterval?: number
}
```

The schema parameter is used for TypeScript type inference only -- the runtime does not inspect it. Passing the schema lets TypeScript enforce that `emit()` calls use event types and payloads that match the schema definition.

### Channel Interface

```typescript
interface Channel {
  /**
   * Persistent SSE connection.
   * Web standard: returns a Response with a ReadableStream body.
   * Node.js: writes SSE headers to res and returns undefined.
   */
  connect(request: Request): Response
  connect(req: NodeRequest, res: NodeResponse): undefined

  /**
   * Scoped request-response SSE emitter.
   * Web standard: returns { response, emitter }.
   * Node.js: writes SSE headers to res and returns a ScopedEmitter.
   */
  respond(request: Request): { response: Response; emitter: ScopedEmitter }
  respond(req: NodeRequest, res: NodeResponse): ScopedEmitter

  /** Broadcast a typed event to all connected clients. Dead clients are cleaned up. */
  emit(type: string, payload: unknown): void

  /** Graceful shutdown: close all client connections and stop heartbeat. */
  close(): void

  /** Check if channel has been closed. */
  isClosed(): boolean
}

interface ScopedEmitter {
  emit(type: string, payload: unknown): void
  close(): void
}
```

### Behavior

- **`connect()`** adds the client to a broadcast pool and starts a heartbeat timer. Sends a `: connected\n\n` comment on initial connection. Web clients use `ReadableStream`; Node.js clients use `ServerResponse.write()`.
- **`respond()`** creates an isolated emitter not added to the broadcast pool. Used for one-shot SSE responses (e.g., streaming query results).
- **`emit()`** broadcasts to all pooled clients. Failed writes cause dead-client removal. When the pool empties, the heartbeat timer stops.
- **`close()`** closes all client connections, clears the pool, and stops the heartbeat. Subsequent `connect()` or `respond()` calls throw.
- Heartbeats send `: heartbeat\n\n` comments at the configured interval to keep connections alive and detect dead clients.

### Dual Runtime Support

```typescript
// Web standard (Fetch API / edge runtimes)
export function GET(request: Request) {
  return channel.connect(request)
}

// Node.js HTTP
import http from 'http'
http.createServer((req, res) => {
  channel.connect(req, res)
})
```

---

## Update Strategy Details

### Strategy: `set`

Directly replaces the cached value with the event payload.

```typescript
// Config
'order:updated': {
  key: (p) => `/api/orders/${p.id}`,
  update: 'set',
}

// Event received
{ type: 'order:updated', payload: { id: '123', status: 'shipped', items: [...] } }

// Result: SWR cache for /api/orders/123 is now the full payload
// No API call is made
```

**When to use:**
- SSE payload contains the complete updated resource
- You want zero latency updates

### Strategy: `refetch`

Ignores the payload and triggers SWR revalidation.

```typescript
// Config
'cache:invalidate': {
  key: (p) => p.keys,  // Array of keys to invalidate
  update: 'refetch',
}

// Event received
{ type: 'cache:invalidate', payload: { keys: ['/api/users', '/api/stats'] } }

// Result: Both keys are revalidated (fetched fresh from server)
```

**When to use:**
- SSE is a notification without full data
- Data is too large to send over SSE
- You need server-computed derived data

### Strategy: Custom Function

Merge payload with existing cached data.

```typescript
// Config
'comment:added': {
  key: (p) => `/api/posts/${p.postId}/comments`,
  update: (current, payload) => {
    if (!current) return [payload.comment]
    return [...current, payload.comment]
  },
}

// Event received
{ type: 'comment:added', payload: { postId: '456', comment: { id: '789', text: 'Hello' } } }

// Result: Comment is appended to existing array
```

**When to use:**
- Appending to lists
- Incrementing counters
- Partial updates (patching)
- Complex merge logic

---

## Connection Management

### Lifecycle

```
┌──────────┐     onConnect()     ┌───────────┐
│          │────────────────────>│           │
│  Closed  │                     │ Connected │
│          │<────────────────────│           │
└──────────┘     onDisconnect()  └───────────┘
     ^                                 │
     │                                 │
     │         onError()               │
     │                                 v
     │                           ┌───────────┐
     └───────────────────────────│           │
           (after max retries)   │ Retrying  │
                                 │           │
                                 └───────────┘
                                       │
                                       │ (retry succeeds)
                                       v
                                 ┌───────────┐
                                 │ Connected │
                                 └───────────┘
```

### Transport Creation

SSEProvider and useSSEStream follow the same transport selection logic:

1. If a `transport` factory is provided, call it. If it throws, install a no-op closed sentinel and report the error via `onEventError` with `{ type: 'transport_error', payload: null }`.
2. If `method`, `body`, or `headers` are set, use `createFetchTransport`.
3. Otherwise, use `new EventSource(url)`.

The unified reconnection logic applies to all transport types: on error with `readyState === CLOSED`, schedule a reconnection attempt using exponential backoff.

### Reconnection Behavior

1. On connection error, wait `initialDelay` ms
2. Attempt reconnection
3. On failure, multiply delay by `backoffMultiplier`
4. Cap delay at `maxDelay`
5. Continue until `maxAttempts` reached or connection succeeds
6. On success, reset retry counter and delay

Formula: `min(initialDelay * (backoffMultiplier ^ attemptNumber), maxDelay)`

### maxAttempts Exhaustion

When the attempt counter reaches `maxAttempts`, reconnection stops silently. No additional error callback is fired at the point of exhaustion — `onError` fires on each failed attempt, but there is no dedicated "gave up" notification.

To detect this condition, monitor `useSSEStatus()`:

```typescript
const { connected, error, reconnectAttempt } = useSSEStatus()

// connected: false — no active connection
// error: populated with the last connection error
// reconnectAttempt: equals maxAttempts (or close to it)
```

When these three signals align — `connected` is `false`, `error` is set, and no further `reconnectAttempt` increments are observed — the provider has stopped retrying. At that point you can display a manual reconnect UI or surface the error to the user.

The visibility handler (tab focus) applies the **same** `maxAttempts` guard. After exhaustion, switching back to a hidden-then-visible tab will **not** trigger another reconnect attempt. If you need unlimited reconnection on tab focus regardless of prior failures, set `maxAttempts: Infinity` (the default) or reset the page.

### Browser Tab Visibility

When the browser tab becomes hidden:
- SSE connection may be throttled by the browser
- On tab focus, connection is checked and re-established if needed, subject to the `maxAttempts` limit
- Pending reconnect timers are cancelled before immediate reconnection to avoid duplicate connections

### Error Handling

#### Connection Errors

```typescript
const config: SSEConfig = {
  url: '/api/events',
  events: { ... },

  onError: (error) => {
    captureException(error)
  },

  onDisconnect: () => {
    toast.warning('Real-time updates disconnected. Reconnecting...')
  },

  onConnect: () => {
    toast.success('Real-time updates restored')
  },
}
```

#### Per-Event Error Handling

If processing a single event throws, the error is caught and reported via `onEventError`. The provider continues processing subsequent events.

```typescript
const config: SSEConfig = {
  url: '/api/events',
  events: { ... },

  onEventError: (event, error) => {
    console.error(`Error processing event ${event.type}:`, error)
    captureException(error)
  },
}
```

This callback also fires for:
- JSON parse failures (with `type: 'parse_error'`)
- Transport factory errors (with `type: 'transport_error'`)

#### Invalid Events

Events that don't match any mapping are silently ignored by default. Enable debug mode to log them:

```typescript
const config: SSEConfig = {
  url: '/api/events',
  debug: true,  // Logs unhandled events, routing details, and parse failures
  ...
}
```

---

## TypeScript Support

### Schema-Driven Type Safety

```typescript
import { defineSchema } from 'reactive-swr'
import { createChannel } from 'reactive-swr/server'

// Shared schema -- single source of truth
const schema = defineSchema({
  'user.updated': {
    key: (p: { id: string }) => `/api/users/${p.id}`,
    update: 'set',
  },
  'order.placed': {
    key: (p: { id: string }) => `/api/orders/${p.id}`,
  },
})

// Server: type-safe emit
const channel = createChannel(schema)
channel.emit('user.updated', { id: '42', name: 'Alice' })

// Client: schema-driven config (no manual events mapping)
const config: SSEConfig = {
  url: '/api/events',
  schema,
}
```

### Typed Event Configurations (manual)

```typescript
interface OrderUpdatedPayload {
  id: string
  status: 'pending' | 'shipped' | 'delivered'
  updatedAt: string
}

interface CommentAddedPayload {
  postId: string
  comment: {
    id: string
    author: string
    text: string
  }
}

const config: SSEConfig = {
  url: '/api/events',
  events: {
    'order:updated': {
      key: (p: OrderUpdatedPayload) => `/api/orders/${p.id}`,
      update: 'set',
    } satisfies EventMapping<OrderUpdatedPayload>,

    'comment:added': {
      key: (p: CommentAddedPayload) => `/api/posts/${p.postId}/comments`,
      update: (current: Comment[] | undefined, p: CommentAddedPayload) => {
        return [...(current ?? []), p.comment]
      },
    } satisfies EventMapping<CommentAddedPayload, Comment[]>,
  },
}
```

---

## Performance Considerations

### Memory

- One SSE connection per provider instance (single connection per provider still applies with transports)
- One SSE connection per unique URL+options key in `useSSEStream` (reference-counted)
- Event mappings are stored once in the provider
- SWR handles cache memory management

### CPU

- Event parsing: O(1) JSON parse per event
- Key resolution: O(1) for static keys, O(n) for array keys
- Cache update: Delegated to SWR's `mutate()`
- SSE wire format parsing (for fetch transport): streaming, O(n) per chunk

### Network

- Single persistent HTTP connection for all events per provider
- No polling overhead
- Automatic browser reconnection with last event ID (EventSource transport)
- Full payloads eliminate redundant API calls
- Server-side heartbeats keep connections alive and detect dead clients

### Bundle Size

Target: < 2KB gzipped (excluding SWR peer dependency)

Server-side code (`reactive-swr/server`) is a separate entry point and not included in client bundles.

---

## Testing

### Unit Testing Components

Components using `useSWR` can be tested normally -- they don't know about SSE:

```typescript
import { SWRConfig } from 'swr'

function renderWithSWR(ui: React.ReactElement, initialData = {}) {
  return render(
    <SWRConfig value={{ provider: () => new Map(Object.entries(initialData)) }}>
      {ui}
    </SWRConfig>
  )
}

test('displays order status', () => {
  renderWithSWR(<OrderStatus orderId="123" />, {
    '/api/orders/123': { id: '123', status: 'shipped' },
  })

  expect(screen.getByText('Status: shipped')).toBeInTheDocument()
})
```

### Integration Testing with mockSSE

`mockSSE` intercepts both `EventSource` and `fetch` so it works with all transport types (native EventSource, fetch-based transport, and custom transports that use fetch internally).

```typescript
import { SSEProvider } from 'reactive-swr'
import { mockSSE } from 'reactive-swr/testing'

test('updates order when SSE event received', async () => {
  const mock = mockSSE('/api/events')

  render(
    <SSEProvider config={sseConfig}>
      <OrderStatus orderId="123" />
    </SSEProvider>
  )

  // Simulate SSE event (dispatches to both EventSource and fetch streams)
  mock.sendEvent({
    type: 'order:updated',
    payload: { id: '123', status: 'shipped' },
  })

  await waitFor(() => {
    expect(screen.getByText('Status: shipped')).toBeInTheDocument()
  })

  mock.close()
  mockSSE.restore()  // Call in afterEach to prevent test pollution
})
```

### mockSSE API

```typescript
function mockSSE(url: string): MockSSEControls

interface MockSSEControls {
  /** Dispatch a typed event to both EventSource and fetch-based connections. */
  sendEvent: (event: { type: string; payload: unknown }) => void

  /** Send raw SSE wire format text to fetch-based connections. */
  sendRaw: (text: string) => void

  /** Send an unnamed data message (convenience for `data: json\n\n`). */
  sendSSE: (data: unknown) => void

  /** Simulate connection close/error. */
  close: () => void

  /** Access the underlying MockEventSource instance. */
  getConnection: () => MockEventSource | undefined
}

/** Restore original EventSource, fetch, and Request. Call in afterEach. */
mockSSE.restore: () => void
```

`mockSSE` also patches `globalThis.Request` to support relative URLs for registered mock URLs, preventing errors in environments where `Request` requires absolute URLs.

---

## Exports

### Main entry (`reactive-swr`)

- `SSEProvider`, `useSSEContext`
- `useSSEStatus`, `useSSEEvent`, `useSSEStream`
- `defineSchema`
- `createSSEParser`, `formatSSEEvent`, `formatSSEData`
- Types: `SSEConfig`, `SSEProviderProps`, `SSETransport`, `SSERequestOptions`, `SSEStatus`, `EventMapping`, `UpdateStrategy`, `ParsedEvent`, `ReconnectConfig`, `SchemaDefinition`, `SchemaEventDefinition`, `SchemaResult`, `UseSSEStreamOptions`, `UseSSEStreamResult`

### Server entry (`reactive-swr/server`)

- `createChannel`

### Testing entry (`reactive-swr/testing`)

- `mockSSE`
- Types: `MockSSEControls`, `SSEEventData`

---

## Troubleshooting

### Connection stuck in "connecting" state

**Check the SSE endpoint response.**
The server must respond with HTTP 200 and `Content-Type: text/event-stream`. Any other status code or content type causes the connection to fail silently or loop.

```
# Verify with curl
curl -v -N -H "Accept: text/event-stream" http://localhost:3000/api/events
# Look for: < HTTP/1.1 200 OK
#           < Content-Type: text/event-stream
```

**Check for CORS errors.**
Open the browser devtools Network tab. If the SSE request is blocked, you will see a CORS error in the console. Ensure the server sets `Access-Control-Allow-Origin` for your client origin.

**Check credentials configuration.**
If your endpoint requires cookies or auth headers, the native `EventSource` does not send credentials by default. Switch to the fetch transport and set the appropriate headers:

```typescript
const config: SSEConfig = {
  url: '/api/events',
  headers: { Authorization: `Bearer ${token}` },
  // or for cookies:
  // credentials: 'include' requires a custom transport
  events: { ... },
}
```

---

### Events not arriving

**Confirm events are terminated with `\n\n`.**
SSE requires each event block to end with a double newline. A single `\n` is a field separator, not an event boundary. The server must write:

```
data: {"type":"order:updated","payload":{...}}\n\n
```

Use `formatSSEEvent` or `formatSSEData` from the library to avoid this mistake.

**Enable debug mode** to log every received event and routing decision:

```typescript
const config: SSEConfig = {
  url: '/api/events',
  debug: true,
  events: { ... },
}
// Console will show: [reactiveSWR] Event received: { type: "...", payload: ... }
// And for unmatched events: [reactiveSWR] Unhandled event type: "..."
```

**Verify `parseEvent` returns the correct shape.**
The default parser expects unnamed events to contain JSON with `{ type: string, payload: unknown }`. If your server sends a different format, provide a custom `parseEvent`:

```typescript
parseEvent: (event) => ({
  type: event.type || 'message',   // must be a non-empty string
  payload: JSON.parse(event.data), // payload can be any value
})
```

If `parseEvent` throws or returns an object missing `type`, the event is silently dropped (or logged with `debug: true`).

---

### Memory usage grows over time

**Ensure `useSSEEvent` cleanup functions are called.**
`useSSEEvent` registers a handler inside `SSEProvider`. In custom hooks that call `useSSEEvent` directly, verify the enclosing component unmounts cleanly. If you ever call the subscribe API from `useSSEContext` manually, save and invoke the returned cleanup function:

```typescript
const { subscribe } = useSSEContext()
useEffect(() => {
  const cleanup = subscribe('order:updated', handleOrderUpdate)
  return cleanup  // required — omitting this leaks the handler
}, [subscribe])
```

**Check `useSSEStream` with non-serializable bodies.**
`useSSEStream` uses reference counting to share and close connections. When the `body` option is a non-serializable type (`Blob`, `FormData`, `ArrayBuffer`, `ReadableStream`), each hook call gets its own connection key. Verify the component unmounts fully (no leaked component trees) so the refCount reaches zero and the transport closes.

---

### Reconnection not working

**Check whether `maxAttempts` has been reached.**
The default is `Infinity`, but if you set a finite limit the provider stops retrying after that many failures. Check `useSSEStatus().reconnectAttempt` against your configured `maxAttempts`:

```typescript
const { reconnectAttempt, connecting, connected } = useSSEStatus()
// reconnectAttempt increments on each retry
```

**Inspect the `onError` callback for the error type.**
Network-level errors (DNS failure, server down) arrive as a DOM `Event` on the `onerror` handler — they do not carry a descriptive message. Log the event to confirm the connection is actually closing:

```typescript
const config: SSEConfig = {
  url: '/api/events',
  onError: (event) => {
    console.error('SSE error event:', event)
  },
  onDisconnect: () => {
    console.warn('SSE disconnected, reconnection scheduled')
  },
  onConnect: () => {
    console.info('SSE reconnected successfully')
  },
  events: { ... },
}
```

If `onDisconnect` never fires after `onError`, the transport's `readyState` did not transition to `CLOSED` (2). This can happen with custom transports that do not call `onerror` after closing — ensure your transport implementation sets `readyState` to `2` and fires `onerror` when the stream ends unexpectedly.

---

## Future Considerations

### Potential Enhancements

1. **Optimistic Updates** - Pair with SWR mutations for optimistic UI
2. **Offline Queue** - Buffer events when offline, replay on reconnect
3. **Selective Subscriptions** - Send subscribe/unsubscribe messages to server
4. **DevTools** - Browser extension for debugging event flow
5. **Middleware** - Pluggable event processing pipeline

### Out of Scope

1. Client-side query engine (like Minimongo)
2. Conflict resolution for concurrent edits
3. WebSocket transport (may add as separate package)
