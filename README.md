# reactiveSWR

A lightweight library that brings Meteor-style reactivity to modern React applications using SWR and Server-Sent Events (SSE).

## The Problem

Building real-time UIs typically requires:
- Manual SSE/WebSocket listeners scattered across components
- Ad-hoc cache invalidation logic
- Components tightly coupled to real-time transport details
- Easy-to-miss cache updates when data changes

## The Solution

reactiveSWR provides a declarative bridge between SSE events and SWR's cache. Define a shared schema once, and your components just use normal `useSWR` hooks -- they automatically receive real-time updates without knowing about SSE.

```typescript
import { defineSchema } from 'reactive-swr'

// Define your schema once -- shared by server and client
const schema = defineSchema({
  'order:updated': {
    key: (p: { id: string; status: string }) => `/api/orders/${p.id}`,
    update: 'set',
  },
  'comment:added': {
    key: (p: { postId: string; comment: string }) => `/api/posts/${p.postId}/comments`,
    update: (current: string[] | undefined, p) => [...(current ?? []), p.comment],
  },
})

// Components just use useSWR - updates happen automatically
function OrderStatus({ orderId }) {
  const { data } = useSWR(`/api/orders/${orderId}`)
  return <div>Status: {data?.status}</div>  // Real-time!
}
```

You can also define event mappings manually without a schema -- see [Manual Events Mapping](#manual-events-mapping) below.

## Installation

```bash
npm install reactive-swr swr
```

## Quick Start

### 1. Define a schema (shared between server and client)

```typescript
// schema.ts
import { defineSchema } from 'reactive-swr'

export const schema = defineSchema({
  'user:updated': {
    key: (p: { id: string }) => `/api/users/${p.id}`,
    update: 'set',
  },
  'order:placed': {
    key: '/api/orders',
    update: 'refetch',
  },
})
```

### 2. Server: create an SSE channel

```typescript
// server.ts
import { createChannel } from 'reactive-swr/server'
import { schema } from './schema'

const channel = createChannel(schema)

// Web standard (Cloudflare Workers, Deno, Bun)
export function GET(request: Request) {
  return channel.connect(request)
}

// Node.js HTTP / Express / Fastify
app.get('/api/events', (req, res) => channel.connect(req, res))

// Broadcast type-safe events
channel.emit('user:updated', { id: '42', name: 'Alice' })
```

### 3. Client: wire up SSEProvider with the schema

```tsx
import { SWRConfig } from 'swr'
import { SSEProvider } from 'reactive-swr'
import { schema } from './schema'

function App() {
  return (
    <SWRConfig value={{ fetcher: (url) => fetch(url).then(r => r.json()) }}>
      <SSEProvider config={{ url: '/api/events', schema }}>
        <YourApp />
      </SSEProvider>
    </SWRConfig>
  )
}
```

Components use standard `useSWR` hooks and receive real-time updates automatically.

## Features

### Schema-Driven SSE

The recommended approach is to define a shared schema that drives both server-side event emission and client-side cache updates. This eliminates type drift between server and client.

#### `defineSchema()`

`defineSchema()` creates a frozen, type-safe schema object. Event names are preserved as string literals for full TypeScript autocomplete on both sides.

```typescript
import { defineSchema } from 'reactive-swr'

const schema = defineSchema({
  'user:updated': {
    key: (p: { id: string; name: string }) => `/api/users/${p.id}`,
    update: 'set',
  },
  'stats:refreshed': {
    key: ['/api/stats', '/api/dashboard'],
    update: 'refetch',
  },
  'comment:added': {
    key: (p: { postId: string; comment: Comment }) => `/api/posts/${p.postId}/comments`,
    update: (current: Comment[] | undefined, p) => [...(current ?? []), p.comment],
    filter: (p) => !p.comment.deleted,
    transform: (p) => ({ ...p, comment: { ...p.comment, isNew: true } }),
  },
})
```

Each event definition supports:

| Property | Type | Description |
|----------|------|-------------|
| `key` | `string \| string[] \| (payload) => string \| string[]` | SWR cache key(s) to update |
| `update` | `'set' \| 'refetch' \| (current, payload) => newValue` | Update strategy (default: `'set'`) |
| `filter` | `(payload) => boolean` | Optional client-side filter |
| `transform` | `(payload) => payload` | Optional client-side transform |

#### `createChannel()` (Server)

`createChannel()` provides a complete server-side SSE endpoint. It handles wire formatting, heartbeats, connection tracking, and cleanup. Import it from `reactive-swr/server`.

```typescript
import { createChannel } from 'reactive-swr/server'

const channel = createChannel(schema, {
  heartbeatInterval: 30000, // default: 30s
})
```

**Dual runtime support** -- works with both Web standard APIs (Cloudflare Workers, Deno, Bun) and Node.js (Express, Fastify, raw `http`):

```typescript
// Web standard: returns a streaming Response
export function GET(request: Request): Response {
  return channel.connect(request)
}

// Node.js: writes to ServerResponse
app.get('/events', (req, res) => {
  channel.connect(req, res)
})
```

**Broadcast events** to all connected clients:

```typescript
// Type-safe: eventType and payload are checked against the schema
channel.emit('user:updated', { id: '42', name: 'Alice' })
```

**Scoped emitters** for request-response patterns (e.g., streaming query results):

```typescript
app.post('/api/query', (req, res) => {
  const emitter = channel.respond()
  emitter.emit('result', { rows: queryResults })
  emitter.close()
})
```

**Shutdown** all connections:

```typescript
channel.close() // Closes all connections, stops heartbeats
```

#### SSEProvider `schema` Prop

Pass a schema to `SSEProvider` instead of manually writing `events` mappings:

```tsx
<SSEProvider config={{ url: '/api/events', schema }}>
  <App />
</SSEProvider>
```

The `events` mapping is automatically derived from the schema's `key`, `update`, `filter`, and `transform` definitions. `schema` and `events` are mutually exclusive -- providing both is a TypeScript error. The `parseEvent` callback remains configurable alongside `schema`.

### Manual Events Mapping

If you prefer not to use a schema, you can define event mappings manually. This is the original API and remains fully supported.

```typescript
const config: SSEConfig = {
  url: '/api/events',
  events: {
    'order:updated': {
      key: (p) => `/api/orders/${p.id}`,
      update: 'set',
    },
  },
}

<SSEProvider config={config}>
  <App />
</SSEProvider>
```

### Update Strategies

Control how SSE events update your cached data:

- **`'set'`** - Replace cache with the event payload (no network request)
- **`'refetch'`** - Trigger SWR revalidation (ignores payload)
- **Custom function** - Merge payload with current data: `(current, payload) => newValue`

```typescript
const config: SSEConfig = {
  url: '/api/events',
  events: {
    // Replace entire cache entry
    'user:updated': {
      key: (p) => `/api/users/${p.id}`,
      update: 'set',
    },
    // Trigger refetch from server
    'cache:invalidate': {
      key: (p) => p.keys,
      update: 'refetch',
    },
    // Custom merge logic
    'comment:added': {
      key: (p) => `/api/posts/${p.postId}/comments`,
      update: (current, p) => [...(current ?? []), p.comment],
    },
  },
}
```

### Dynamic Keys

Keys can be static strings, arrays, or functions:

```typescript
events: {
  // Static key
  'stats:updated': {
    key: '/api/stats',
    update: 'set',
  },
  // Multiple keys
  'user:updated': {
    key: ['/api/users', '/api/user-count'],
    update: 'refetch',
  },
  // Dynamic key from payload
  'order:updated': {
    key: (p) => `/api/orders/${p.id}`,
    update: 'set',
  },
}
```

### Filter and Transform

Pre-process events before they update the cache:

```typescript
events: {
  'order:updated': {
    key: (p) => `/api/orders/${p.id}`,
    // Only process orders for current user
    filter: (p) => p.userId === currentUserId,
    // Extract just the order data
    transform: (p) => p.order,
    update: 'set',
  },
}
```

### POST SSE and Custom Transports

By default, reactiveSWR uses the browser's `EventSource` API, which only supports GET requests. The transport abstraction lets you connect to SSE endpoints that require POST requests, custom headers, or entirely custom connection logic.

#### POST with JSON body

```typescript
import { useSSEStream } from 'reactive-swr'

function AIChat({ question }: { question: string }) {
  const { data, error } = useSSEStream<string>('/api/chat', {
    method: 'POST',
    body: { question, model: 'gpt-4' },
  })

  return <div>{data}</div>
}
```

Plain objects passed as `body` are automatically JSON-serialized with `Content-Type: application/json`. If you provide a `body` without a `method`, it defaults to POST.

#### Custom headers (authenticated SSE)

```typescript
const { data } = useSSEStream('/api/events', {
  headers: { Authorization: `Bearer ${token}` },
})
```

Providing `headers` (or `method` or `body`) automatically switches from `EventSource` to the fetch-based transport.

#### Custom transport factory

For full control, provide a `transport` factory that returns an `SSETransport`-compatible object:

```typescript
import type { SSETransport } from 'reactive-swr'

const { data } = useSSEStream('/api/events', {
  transport: (url) => createMyCustomTransport(url),
})
```

#### SSEProvider with transport options

The same transport options are available in `SSEConfig`:

```typescript
const config: SSEConfig = {
  url: '/api/events',
  method: 'POST',
  body: { subscribe: ['orders', 'users'] },
  headers: { Authorization: `Bearer ${token}` },
  events: {
    'order:updated': {
      key: (p) => `/api/orders/${p.id}`,
      update: 'set',
    },
  },
}

// Or with a custom transport factory:
const config: SSEConfig = {
  url: '/api/events',
  transport: (url) => createMyCustomTransport(url),
  events: { /* ... */ },
}
```

### SSE Parser

For advanced users building custom transports, the SSE wire format parser is available as a standalone export:

```typescript
import { createSSEParser } from 'reactive-swr'

const parser = createSSEParser({
  onEvent(event) {
    console.log(event.event, event.data, event.id)
  },
  onRetry(ms) {
    console.log('Server requested retry interval:', ms)
  },
})

// Feed raw SSE text (handles chunked input)
parser.feed('data: {"hello":"world"}\n\n')
parser.feed('event: update\ndata: {"id":1}\n\n')
```

### Reconnection

Automatic reconnection with exponential backoff:

```typescript
const config: SSEConfig = {
  url: '/api/events',
  events: { /* ... */ },
  reconnect: {
    enabled: true,           // default: true
    initialDelay: 1000,      // default: 1000ms
    maxDelay: 30000,         // default: 30000ms
    backoffMultiplier: 2,    // default: 2
    maxAttempts: Infinity,   // default: Infinity
  },
}
```

The connection also auto-reconnects when a hidden browser tab becomes visible.

### Connection Callbacks

React to connection lifecycle events:

```typescript
const config: SSEConfig = {
  url: '/api/events',
  events: { /* ... */ },
  onConnect: () => {
    console.log('Connected to SSE')
  },
  onDisconnect: () => {
    toast.warning('Connection lost. Reconnecting...')
  },
  onError: (error) => {
    captureException(error)
  },
  onEventError: (event, error) => {
    console.error(`Failed to process ${event.type}:`, error)
  },
}
```

### Debug Mode

Enable console logging for SSE events:

```typescript
const config: SSEConfig = {
  url: '/api/events',
  events: { /* ... */ },
  debug: true,  // Logs events and unhandled event types
}
```

## Hooks

### useSSEStatus

Access connection status from any component:

```tsx
import { useSSEStatus } from 'reactive-swr'

function ConnectionIndicator() {
  const { connected, connecting, error, reconnectAttempt } = useSSEStatus()

  if (error) return <span>Error: {error.message}</span>
  if (connecting) return <span>Connecting... (attempt {reconnectAttempt})</span>
  if (connected) return <span>Connected</span>
  return <span>Disconnected</span>
}
```

### useSSEEvent

Subscribe to raw SSE events outside the declarative config:

```tsx
import { useSSEEvent } from 'reactive-swr'

function NotificationListener() {
  useSSEEvent<{ message: string }>('notification', (payload) => {
    toast.info(payload.message)
  })

  return null
}
```

### useSSEStream

Create an independent SSE connection (bypasses the provider):

```tsx
import { useSSEStream } from 'reactive-swr'

function LivePrice({ symbol }: { symbol: string }) {
  const { data, error } = useSSEStream<number>(
    `/api/prices/${symbol}`,
    { transform: (raw) => (raw as { price: number }).price }
  )

  if (error) return <span>--</span>
  return <span>${data?.toFixed(2)}</span>
}
```

#### Options

| Option | Type | Description |
|--------|------|-------------|
| `transform` | `(data: unknown) => T` | Transform incoming data before storing |
| `method` | `string` | HTTP method (defaults to POST when body is provided) |
| `body` | `BodyInit \| Record<string, unknown>` | Request body (triggers fetch-based transport) |
| `headers` | `Record<string, string>` | Additional request headers (triggers fetch-based transport) |
| `transport` | `(url: string) => SSETransport` | Custom transport factory (takes precedence over all other options) |

## Testing

The library provides `mockSSE` for testing components with SSE:

```typescript
import { mockSSE } from 'reactive-swr/testing'

test('updates order when SSE event received', async () => {
  const mock = mockSSE('/api/events')

  render(
    <SSEProvider config={sseConfig}>
      <OrderStatus orderId="123" />
    </SSEProvider>
  )

  // Initial state
  expect(screen.getByText('Status: pending')).toBeInTheDocument()

  // Simulate SSE event
  mock.sendEvent({
    type: 'order:updated',
    payload: { id: '123', status: 'shipped' },
  })

  // Verify update
  await waitFor(() => {
    expect(screen.getByText('Status: shipped')).toBeInTheDocument()
  })

  // Clean up
  mockSSE.restore()
})
```

### mockSSE API

```typescript
const mock = mockSSE(url: string)

mock.sendEvent({ type: string, payload: unknown })  // Send a typed event
mock.sendSSE(data: unknown)                          // Send raw JSON data (convenience for createSSEParser tests)
mock.sendRaw(text: string)                           // Send raw SSE wire format
mock.close()                                         // Simulate connection close
mock.getConnection()                                 // Get the mock EventSource

mockSSE.restore()                                    // Restore real EventSource and fetch
```

`sendSSE(data)` is a convenience wrapper that calls `sendRaw(\`data: ${JSON.stringify(data)}\n\n\`)`. It simplifies tests for consumers using `createSSEParser` who work with raw SSE wire format.

`mockSSE` automatically intercepts both `EventSource` and `fetch` for registered URLs, so your tests work regardless of which transport the component uses internally.

## Documentation

- [API Reference](./docs/API.md) - Complete API documentation
- [Specification](./docs/SPEC.md) - Technical specification

## Inspiration

This library is inspired by [Meteor's](https://www.meteor.com/) Minimongo and DDP protocol, which pioneered the pattern of real-time database synchronization to the client. reactiveSWR brings that developer experience to the modern React ecosystem using SSE and SWR.

## License

MIT
