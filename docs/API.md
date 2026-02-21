# API Reference

Complete API documentation for reactiveSWR.

## Table of Contents

- [Main Entry Point (`reactive-swr`)](#main-entry-point-reactive-swr)
  - [SSEProvider](#sseprovider)
  - [useSSEContext](#usessecontext)
  - [useSSEEvent](#usesseevent)
  - [useSSEStatus](#usessestatus)
  - [useSSEStream](#usessestream)
  - [defineSchema](#defineschema)
  - [createSSEParser](#createssparser)
- [Server Entry Point (`reactive-swr/server`)](#server-entry-point-reactive-swrserver)
  - [createChannel](#createchannel)
- [Testing Entry Point (`reactive-swr/testing`)](#testing-entry-point-reactive-swrtesting)
  - [mockSSE](#mocksse)
- [Types](#types)
  - [SSEConfig](#sseconfig)
  - [EventMapping](#eventmapping)
  - [UpdateStrategy](#updatestrategy)
  - [ReconnectConfig](#reconnectconfig)
  - [ParsedEvent](#parsedevent)
  - [SSEStatus](#ssestatus)
  - [SSETransport](#ssetransport)
  - [SSERequestOptions](#sserequestoptions)
  - [SSEProviderProps](#sseproviderprops)
  - [SchemaDefinition and SchemaResult](#schemadefinition-and-schemaresult)
  - [SSEEvent and SSEParser](#sseevent-and-sseparser)
  - [UseSSEStreamOptions and UseSSEStreamResult](#usessestreamoptions-and-usessestreamresult)

---

## Main Entry Point (`reactive-swr`)

### SSEProvider

Provider component that establishes and manages the SSE connection. Handles event dispatching, SWR cache mutations, reconnection with exponential backoff, and visibility-based reconnection.

```tsx
import { SSEProvider } from 'reactive-swr'

function App() {
  return (
    <SWRConfig value={{ fetcher }}>
      <SSEProvider config={sseConfig}>
        <Dashboard />
      </SSEProvider>
    </SWRConfig>
  )
}
```

**Props:**

| Prop | Type | Description |
|------|------|-------------|
| `config` | [`SSEConfig`](#sseconfig) | Configuration for the SSE connection and event handling |
| `children` | `ReactNode` | Child components |

**Behavior:**

- Must be wrapped in SWR's `SWRConfig` provider
- Only one `SSEProvider` should be active per SSE endpoint
- Automatically reconnects on tab visibility change when the connection is lost
- Supports three transport modes: native `EventSource` (default), fetch-based (when `method`, `body`, or `headers` are set), and custom (via `transport` factory)
- When `schema` is provided in config, event mappings are derived automatically

---

### useSSEContext

Low-level hook that returns the SSE context value. Most consumers should use `useSSEStatus` or `useSSEEvent` instead.

```typescript
import { useSSEContext } from 'reactive-swr'

function MyComponent() {
  const { status, subscribe, config } = useSSEContext()
}
```

**Returns:** `{ status: SSEStatus, subscribe: (eventType, handler) => unsubscribe, config: SSEConfig }`

**Throws:** `Error` if used outside an `SSEProvider`.

---

### useSSEEvent

Subscribe to raw SSE events of a specific type. Allows components to react to events imperatively, outside the declarative `events` config.

```typescript
function useSSEEvent<T = unknown>(
  eventType: string,
  handler: (payload: T) => void
): void
```

**Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `eventType` | `string` | The event type to subscribe to |
| `handler` | `(payload: T) => void` | Callback invoked when a matching event is received |

**Usage:**

```tsx
import { useSSEEvent } from 'reactive-swr'

function NotificationToast() {
  useSSEEvent<{ title: string; body: string }>('notification', (payload) => {
    showToast(payload.title, payload.body)
  })

  return null
}
```

**Notes:**

- Handler is called for all events of the given type, regardless of `config.events`
- Uses the "latest ref" pattern so handler identity changes do not cause resubscription
- Multiple components can subscribe to the same event type independently
- Must be used within an `SSEProvider`

---

### useSSEStatus

Returns the current SSE connection status.

```typescript
function useSSEStatus(): SSEStatus
```

**Returns:** An [`SSEStatus`](#ssestatus) object.

**Usage:**

```tsx
import { useSSEStatus } from 'reactive-swr'

function ConnectionBanner() {
  const { connected, connecting, error, reconnectAttempt } = useSSEStatus()

  if (error) return <div>Error: {error.message}</div>
  if (connecting) return <div>Reconnecting (attempt {reconnectAttempt})...</div>
  if (connected) return <div>Connected</div>
  return <div>Disconnected</div>
}
```

**Throws:** `Error` if used outside an `SSEProvider`.

---

### useSSEStream

Create an independent SSE connection for a dedicated stream. Does not require `SSEProvider`.

```typescript
function useSSEStream<T = unknown>(
  url: string,
  options?: UseSSEStreamOptions<T>
): UseSSEStreamResult<T>
```

**Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `url` | `string` | The SSE endpoint URL |
| `options` | [`UseSSEStreamOptions<T>`](#usessestreamoptions-and-usessestreamresult) | Optional configuration |

**Usage:**

```tsx
import { useSSEStream } from 'reactive-swr'

function StockTicker({ symbol }: { symbol: string }) {
  const { data, error } = useSSEStream<{ price: number }>(
    `/api/stocks/${symbol}/stream`,
    { transform: (raw) => raw as { price: number } }
  )

  if (error) return <span>--</span>
  if (!data) return <span>Loading...</span>
  return <span>${data.price.toFixed(2)}</span>
}
```

**POST request example:**

```tsx
const { data } = useSSEStream<Result>('/api/query', {
  method: 'POST',
  body: { query: 'SELECT * FROM users' },
  headers: { Authorization: `Bearer ${token}` },
  transform: (raw) => raw as Result,
})
```

**Custom transport example:**

```tsx
const { data } = useSSEStream<Result>('/api/stream', {
  transport: (url) => myCustomTransport(url),
})
```

**Notes:**

- Connections are shared across components using the same URL and options
- Connection closes automatically when all subscribers unmount
- URL or transport option changes close the old connection and open a new one
- The `transform` function uses a ref pattern so changing its reference does not cause reconnection
- When `body` or `headers` are provided without an explicit `method`, a fetch-based transport is used automatically

---

### defineSchema

Define a shared, frozen schema object consumed by both `createChannel()` (server) and `SSEProvider` (client). Provides TypeScript inference for event types and payloads.

```typescript
function defineSchema<T extends SchemaDefinition>(
  definition: T
): SchemaResult<T>
```

**Usage:**

```typescript
import { defineSchema } from 'reactive-swr'

const schema = defineSchema({
  'user.updated': {
    key: '/api/users',
    update: 'set',
  },
  'order.placed': {
    key: (p: { id: string }) => `/api/orders/${p.id}`,
  },
  'stats.changed': {
    key: ['/api/stats/daily', '/api/stats/weekly'],
    update: 'refetch',
  },
})
```

The returned schema object is frozen with `Object.freeze()`. Each entry defaults `update` to `'set'` when not specified.

**Using with SSEProvider:**

```tsx
<SSEProvider config={{ url: '/api/events', schema }}>
  <App />
</SSEProvider>
```

**Using with createChannel:**

```typescript
const channel = createChannel(schema)
```

---

### createSSEParser

Create a streaming SSE wire-protocol parser. Useful for building custom transports that consume raw SSE text.

```typescript
function createSSEParser(callbacks: SSEParserCallbacks): SSEParser
```

**Callbacks:**

```typescript
interface SSEParserCallbacks {
  onEvent: (event: SSEEvent) => void
  onRetry?: (ms: number) => void
}
```

**Returns:**

```typescript
interface SSEParser {
  feed(chunk: string): void
  reset(): void
}
```

**SSEEvent:**

```typescript
interface SSEEvent {
  data: string
  event: string  // defaults to "message" for unnamed events
  id: string
  retry?: number
}
```

**Usage:**

```typescript
import { createSSEParser } from 'reactive-swr'

const parser = createSSEParser({
  onEvent(event) {
    console.log(event.event, event.data)
  },
  onRetry(ms) {
    console.log('Server requested retry interval:', ms)
  },
})

// Feed raw SSE text chunks as they arrive
parser.feed('event: user.updated\n')
parser.feed('data: {"id":42}\n\n')
// onEvent fires with { event: "user.updated", data: '{"id":42}', id: "" }

parser.reset() // Clear internal state for reuse
```

**Notes:**

- Handles `\r\n`, `\r`, and `\n` line endings
- Strips BOM at the start of the stream
- Comment lines (starting with `:`) are silently ignored
- Multi-line `data` fields are joined with `\n`

---

## Server Entry Point (`reactive-swr/server`)

### createChannel

Create a server-side SSE channel that broadcasts typed events to connected clients. Supports both Web standard (Fetch API / edge runtimes) and Node.js HTTP environments.

```typescript
import { createChannel } from 'reactive-swr/server'

function createChannel(
  schema: Record<string, any>,
  options?: { heartbeatInterval?: number }
): Channel
```

**Parameters:**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `schema` | schema object | (required) | Schema from `defineSchema()`. Used for TypeScript type inference only; not inspected at runtime. |
| `options.heartbeatInterval` | `number` | `30000` | Milliseconds between heartbeat comments sent to keep connections alive |

**Channel methods:**

| Method | Description |
|--------|-------------|
| `connect(request: Request): Response` | Web standard. Returns a streaming `Response` for the client. |
| `connect(req, res): void` | Node.js. Writes SSE headers and streams to the `ServerResponse`. |
| `respond(request: Request): { response, emitter }` | Web standard. Returns a `Response` and a scoped `ScopedEmitter` for request-scoped streaming. |
| `respond(req, res): ScopedEmitter` | Node.js. Writes SSE headers and returns a scoped `ScopedEmitter`. |
| `emit(type, payload): void` | Broadcast an event to all clients connected via `connect()`. |
| `close(): void` | Close all connections and stop the heartbeat timer. |
| `isClosed(): boolean` | Returns `true` if the channel has been closed. |

**ScopedEmitter:**

```typescript
interface ScopedEmitter {
  emit(type: string, payload: unknown): void
  close(): void
}
```

A scoped emitter writes only to the single client it was created for (via `respond()`), unlike `channel.emit()` which broadcasts to all `connect()` clients.

**Web standard usage (e.g., Next.js Route Handlers, Cloudflare Workers):**

```typescript
import { createChannel } from 'reactive-swr/server'

const channel = createChannel(schema)

// Broadcast endpoint — long-lived connection
export function GET(request: Request) {
  return channel.connect(request)
}

// Request-scoped endpoint — stream results then close
export async function POST(request: Request) {
  const body = await request.json()
  const { response, emitter } = channel.respond(request)

  emitter.emit('result', { rows: await queryDB(body.query) })
  emitter.close()

  return response
}
```

**Node.js usage:**

```typescript
import http from 'node:http'
import { createChannel } from 'reactive-swr/server'

const channel = createChannel(schema)

http.createServer((req, res) => {
  if (req.url === '/events') {
    // Broadcast — long-lived connection
    channel.connect(req, res)
  } else if (req.url === '/query') {
    // Request-scoped
    const emitter = channel.respond(req, res)
    emitter.emit('result', { rows: queryDB() })
    emitter.close()
  }
})

// Broadcast to all connected clients from anywhere
channel.emit('user.updated', { id: 42, name: 'Alice' })

// Graceful shutdown
channel.close()
```

**Notes:**

- Heartbeat comments (`: heartbeat\n\n`) keep connections alive and are sent to all `connect()` clients at the configured interval
- The heartbeat timer starts when the first client connects and stops when the last client disconnects
- Dead clients (closed streams, ended responses) are automatically pruned during broadcast and heartbeat cycles
- `connect()` sends an initial `: connected\n\n` comment when a client connects
- Throws `Error('Channel is closed')` if `connect()`, `respond()`, or `emit()` are called after `close()`

---

## Testing Entry Point (`reactive-swr/testing`)

### mockSSE

Create a mock SSE connection for testing. Intercepts both the global `EventSource` constructor and `fetch` so that connections to registered URLs return controllable mocks.

```typescript
import { mockSSE } from 'reactive-swr/testing'

function mockSSE(url: string): MockSSEControls
```

**Returns:**

```typescript
interface MockSSEControls {
  sendEvent(event: SSEEventData): void
  sendRaw(text: string): void
  sendSSE(data: unknown): void
  close(): void
  getConnection(): MockEventSource | undefined
}

interface SSEEventData {
  type: string
  payload: unknown
}
```

**Methods:**

| Method | Description |
|--------|-------------|
| `sendEvent({ type, payload })` | Dispatch a typed event to both the `MockEventSource` (as a `MessageEvent`) and any fetch-based streams (as formatted SSE wire text). |
| `sendRaw(text)` | Send raw text directly to fetch-based streams. Does not affect `EventSource` listeners. |
| `sendSSE(data)` | Send data as `data: <json>\n\n` format to fetch-based streams. Does not affect `EventSource` listeners. |
| `close()` | Simulate a connection close. Fires the error handler on the `MockEventSource` and closes fetch streams. |
| `getConnection()` | Get the `MockEventSource` instance for the registered URL, if one has been created. |

**Static Methods:**

| Method | Description |
|--------|-------------|
| `mockSSE.restore()` | Restore the original `EventSource`, `fetch`, and `Request` globals. Closes all mock instances and streams. Call this in `afterEach`. |

**Usage:**

```typescript
import { mockSSE } from 'reactive-swr/testing'
import { render, screen, waitFor } from '@testing-library/react'

describe('OrderStatus', () => {
  afterEach(() => {
    mockSSE.restore()
  })

  it('updates when order event received', async () => {
    const mock = mockSSE('/api/events')

    render(
      <SWRConfig value={{ provider: () => new Map() }}>
        <SSEProvider config={{ url: '/api/events', schema }}>
          <OrderStatus orderId="123" />
        </SSEProvider>
      </SWRConfig>
    )

    mock.sendEvent({
      type: 'order.updated',
      payload: { id: '123', status: 'shipped' },
    })

    await waitFor(() => {
      expect(screen.getByText('shipped')).toBeInTheDocument()
    })
  })
})
```

**Testing fetch-based transports:**

```typescript
it('works with POST SSE streams', async () => {
  const mock = mockSSE('/api/query')

  render(<StreamingResults url="/api/query" body={{ q: 'test' }} />)

  // sendEvent dispatches to both EventSource and fetch listeners
  mock.sendEvent({ type: 'row', payload: { id: 1 } })

  // sendRaw sends raw SSE wire text to fetch streams only
  mock.sendRaw('event: row\ndata: {"id":2}\n\n')

  // sendSSE sends unnamed data messages to fetch streams only
  mock.sendSSE({ id: 3 })
})
```

**Notes:**

- The first call to `mockSSE(url)` installs global overrides for `EventSource`, `fetch`, and `Request`
- Multiple URLs can be registered before `restore()` is called
- `mockSSE.restore()` must be called after each test to prevent cross-test pollution
- The mock `Request` constructor handles relative URLs for registered mock URLs by prefixing `http://localhost`
- After `restore()` is called, `sendEvent`, `sendRaw`, and `sendSSE` become no-ops

---

## Types

All types are exported from the main entry point:

```typescript
import type {
  EventMapping,
  ParsedEvent,
  ReconnectConfig,
  SchemaDefinition,
  SchemaEventDefinition,
  SchemaResult,
  SSEConfig,
  SSEProviderProps,
  SSERequestOptions,
  SSEStatus,
  SSETransport,
  UpdateStrategy,
  UseSSEStreamOptions,
  UseSSEStreamResult,
} from 'reactive-swr'
```

Testing types:

```typescript
import type { MockSSEControls, SSEEventData } from 'reactive-swr/testing'
```

---

### SSEConfig

Configuration for the SSE connection and event handling. This is a discriminated union with three variants:

```typescript
type SSEConfig =
  | SSEConfigWithSchema   // has `schema`, no `events`
  | SSEConfigWithEvents   // has `events`, no `schema`
  | SSEConfigWithNeither  // neither (for manual event handling via useSSEEvent)
```

Provide either `events` (manual mapping) or `schema` (auto-derived from `defineSchema` output), but not both. Providing both is a TypeScript compile error. At runtime, if both are somehow provided, `schema` takes precedence and a warning is logged when `debug: true`.

**Shared properties (all variants):**

| Property | Type | Required | Description |
|----------|------|----------|-------------|
| `url` | `string` | Yes | The SSE endpoint URL |
| `parseEvent` | `(event: MessageEvent) => ParsedEvent` | No | Custom event parser. Default expects `{ type, payload }` JSON for unnamed events. For named events, `data` is parsed as JSON for the payload. |
| `reconnect` | [`ReconnectConfig`](#reconnectconfig) | No | Reconnection settings |
| `debug` | `boolean` | No | Enable `console.debug` logging for event processing |
| `onConnect` | `() => void` | No | Called when the connection opens |
| `onDisconnect` | `() => void` | No | Called when the connection closes |
| `onError` | `(error: Event) => void` | No | Called on connection error |
| `onEventError` | `(event: ParsedEvent, error: unknown) => void` | No | Called when event processing fails |
| `method` | `string` | No | HTTP method. Triggers fetch-based transport when set. |
| `body` | `BodyInit \| Record<string, unknown>` | No | Request body. Triggers fetch-based transport when set. |
| `headers` | `Record<string, string>` | No | Additional request headers. Triggers fetch-based transport when set. |
| `transport` | `(url: string) => SSETransport` | No | Custom transport factory. Takes precedence over `method`/`body`/`headers`. |

**Schema variant:**

```typescript
interface SSEConfigWithSchema extends SSEConfigBase {
  schema: Record<string, any>  // output of defineSchema()
  events?: never
}
```

**Events variant:**

```typescript
interface SSEConfigWithEvents extends SSEConfigBase {
  events: Record<string, EventMapping>
  schema?: never
}
```

---

### EventMapping

Defines how to handle a specific event type, including which SWR cache keys to update and how.

```typescript
interface EventMapping<TPayload = any, TData = any> {
  key: string | string[] | ((payload: TPayload) => string | string[])
  update?: UpdateStrategy<TPayload, TData>
  filter?: (payload: TPayload) => boolean
  transform?: (payload: TPayload) => TPayload
}
```

| Property | Type | Required | Description |
|----------|------|----------|-------------|
| `key` | `string \| string[] \| ((payload) => string \| string[])` | Yes | SWR cache key(s) to update. Can be static, an array, or a function of the payload. |
| `update` | [`UpdateStrategy`](#updatestrategy) | No | How to update the cache. Defaults to `'set'`. |
| `filter` | `(payload) => boolean` | No | Return `false` to skip processing this event. Applied to the raw payload before `transform`. |
| `transform` | `(payload) => payload` | No | Transform payload before cache update and key resolution. |

---

### UpdateStrategy

Controls how the SWR cache is updated when an event is received.

```typescript
type UpdateStrategy<TPayload, TData> =
  | 'set'
  | 'refetch'
  | ((current: TData | undefined, payload: TPayload) => TData)
```

| Strategy | Description |
|----------|-------------|
| `'set'` | Replace cache value with the payload directly (no network request) |
| `'refetch'` | Trigger SWR revalidation (ignores payload, fetches fresh data from the server) |
| `function` | Custom merge: receives current cache value and payload, returns new value |

**Example with custom merge:**

```typescript
const config: SSEConfig = {
  url: '/api/events',
  events: {
    'item.added': {
      key: '/api/items',
      update: (current: Item[] | undefined, newItem: Item) =>
        current ? [...current, newItem] : [newItem],
    },
  },
}
```

---

### ReconnectConfig

Configuration for automatic reconnection with exponential backoff.

```typescript
interface ReconnectConfig {
  enabled?: boolean
  initialDelay?: number
  maxDelay?: number
  backoffMultiplier?: number
  maxAttempts?: number
}
```

| Property | Type | Default | Description |
|----------|------|---------|-------------|
| `enabled` | `boolean` | `true` | Enable automatic reconnection |
| `initialDelay` | `number` | `1000` | Initial delay before first reconnect (ms) |
| `maxDelay` | `number` | `30000` | Maximum delay between attempts (ms) |
| `backoffMultiplier` | `number` | `2` | Exponential backoff multiplier |
| `maxAttempts` | `number` | `Infinity` | Maximum reconnection attempts |

**Backoff formula:** `min(initialDelay * (backoffMultiplier ^ attemptNumber), maxDelay)`

---

### ParsedEvent

The parsed representation of an SSE event after the `parseEvent` function processes it.

```typescript
interface ParsedEvent {
  type: string
  payload: unknown
}
```

---

### SSEStatus

Connection status returned by `useSSEStatus()`.

```typescript
interface SSEStatus {
  connected: boolean       // True when the connection is open
  connecting: boolean      // True during initial connection or reconnection
  error: Error | null      // Last connection error, if any
  reconnectAttempt: number // Current reconnection attempt (0 when connected)
}
```

---

### SSETransport

Abstraction over the native `EventSource` API to support custom transports (e.g., fetch-based SSE for POST requests).

```typescript
interface SSETransport {
  onmessage: ((event: MessageEvent) => void) | null
  onerror: ((event: Event) => void) | null
  onopen: ((event: Event) => void) | null
  close: () => void
  readyState: number
  addEventListener: (type: string, listener: (event: MessageEvent) => void) => void
  removeEventListener: (type: string, listener: (event: MessageEvent) => void) => void
}
```

**Notes:**

- `addEventListener` and `removeEventListener` are for named SSE data events only (e.g., `"user.updated"`), not generic DOM events like `"open"` or `"error"`
- `readyState` follows the `EventSource` constants: `0` (CONNECTING), `1` (OPEN), `2` (CLOSED)

---

### SSERequestOptions

Request options for SSE connections that require custom HTTP methods, request bodies, or additional headers.

```typescript
interface SSERequestOptions {
  method?: string
  body?: BodyInit | Record<string, unknown>
  headers?: Record<string, string>
}
```

---

### SSEProviderProps

Props for the `SSEProvider` component.

```typescript
interface SSEProviderProps {
  config: SSEConfig
  children?: ReactNode
}
```

---

### SchemaDefinition and SchemaResult

Types for the `defineSchema()` function.

```typescript
// Input shape accepted by defineSchema()
type SchemaDefinition = Record<string, SchemaEventDefinition>

// A single event definition entry within a schema
interface SchemaEventDefinition<TPayload = any, TData = any> {
  key: string | string[] | ((payload: TPayload) => string | string[])
  update?: UpdateStrategy<TPayload, TData>
  filter?: (payload: TPayload) => boolean
  transform?: (payload: TPayload) => TPayload
}

// Frozen schema object returned by defineSchema()
type SchemaResult<T extends SchemaDefinition> = Readonly<{
  [K in keyof T]: Required<Pick<T[K], 'key'>> &
    Omit<T[K], 'key'> & { update: NonNullable<T[K]['update']> | 'set' }
}>
```

---

### SSEEvent and SSEParser

Types for the `createSSEParser()` function.

```typescript
interface SSEEvent {
  data: string    // The event data (multi-line data fields joined with \n)
  event: string   // The event type (defaults to "message" for unnamed events)
  id: string      // The last event ID
  retry?: number  // Server-requested retry interval in ms
}

interface SSEParser {
  feed(chunk: string): void  // Feed a raw text chunk to the parser
  reset(): void              // Reset internal state for reuse
}

interface SSEParserCallbacks {
  onEvent: (event: SSEEvent) => void
  onRetry?: (ms: number) => void
}
```

---

### UseSSEStreamOptions and UseSSEStreamResult

Types for the `useSSEStream()` hook.

```typescript
interface UseSSEStreamOptions<T> {
  transform?: (data: unknown) => T
  method?: string
  body?: BodyInit | Record<string, unknown>
  headers?: Record<string, string>
  transport?: (url: string) => SSETransport
}

interface UseSSEStreamResult<T> {
  data: T | undefined       // Latest received data
  error: Error | undefined  // Connection or parse error
}
```

| Option | Type | Description |
|--------|------|-------------|
| `transform` | `(data: unknown) => T` | Transform raw parsed JSON before storing. Uses a ref pattern; changing the function reference does not cause reconnection. |
| `method` | `string` | HTTP method for the request. When `body` is provided without `method`, defaults to POST. |
| `body` | `BodyInit \| Record<string, unknown>` | Request body. Triggers use of fetch-based transport instead of `EventSource`. |
| `headers` | `Record<string, string>` | Additional request headers. Triggers use of fetch-based transport instead of `EventSource`. |
| `transport` | `(url: string) => SSETransport` | Custom transport factory. Takes precedence over `method`/`body`/`headers`. |
