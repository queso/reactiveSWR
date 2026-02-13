# reactiveSWR

A lightweight library that brings Meteor-style reactivity to modern React applications using SWR and Server-Sent Events (SSE).

## The Problem

Building real-time UIs typically requires:
- Manual SSE/WebSocket listeners scattered across components
- Ad-hoc cache invalidation logic
- Components tightly coupled to real-time transport details
- Easy-to-miss cache updates when data changes

## The Solution

reactiveSWR provides a declarative bridge between SSE events and SWR's cache. You define a mapping once, and your components just use normal `useSWR` hooks--they automatically receive real-time updates without knowing about SSE.

```typescript
// Define your event mappings once
const config: SSEConfig = {
  url: '/api/events',
  events: {
    'order:updated': {
      key: (p) => `/api/orders/${p.id}`,
      update: 'set',  // Use SSE payload directly, no refetch
    },
    'comment:added': {
      key: (p) => `/api/posts/${p.postId}/comments`,
      update: (current, p) => [...(current ?? []), p.comment],
    },
  },
}

// Components just use useSWR - updates happen automatically
function OrderStatus({ orderId }) {
  const { data } = useSWR(`/api/orders/${orderId}`)
  return <div>Status: {data?.status}</div>  // Real-time!
}
```

## Installation

```bash
npm install reactive-swr swr
```

## Quick Start

```tsx
import { SWRConfig } from 'swr'
import { SSEProvider } from 'reactive-swr'

const sseConfig = {
  url: '/api/events',
  events: {
    'user:updated': {
      key: (p) => `/api/users/${p.id}`,
      update: 'set',
    },
  },
}

function App() {
  return (
    <SWRConfig value={{ fetcher: (url) => fetch(url).then(r => r.json()) }}>
      <SSEProvider config={sseConfig}>
        <YourApp />
      </SSEProvider>
    </SWRConfig>
  )
}
```

## Features

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

mock.sendEvent({ type: string, payload: unknown })  // Send an event
mock.sendRaw(text: string)                           // Send raw SSE wire format
mock.close()                                         // Simulate connection close
mock.getConnection()                                 // Get the mock EventSource

mockSSE.restore()                                    // Restore real EventSource and fetch
```

`mockSSE` automatically intercepts both `EventSource` and `fetch` for registered URLs, so your tests work regardless of which transport the component uses internally.

## Documentation

- [API Reference](./docs/API.md) - Complete API documentation
- [Specification](./docs/SPEC.md) - Technical specification

## Inspiration

This library is inspired by [Meteor's](https://www.meteor.com/) Minimongo and DDP protocol, which pioneered the pattern of real-time database synchronization to the client. reactiveSWR brings that developer experience to the modern React ecosystem using SSE and SWR.

## License

MIT
