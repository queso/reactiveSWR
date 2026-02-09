# reactiveSWR Technical Specification

## Overview

reactiveSWR is a declarative bridge between Server-Sent Events (SSE) and SWR's cache layer. It enables Meteor-style reactive data fetching in modern React applications without the complexity of a full real-time framework.

## Goals

1. **Simplicity** - Minimal API surface, easy to understand and adopt
2. **Transparency** - Components don't know about SSE; they just use `useSWR`
3. **Efficiency** - No redundant API calls when SSE provides full payloads
4. **Flexibility** - Support various update strategies and custom merge logic
5. **Type Safety** - Full TypeScript support with inferred types

## Non-Goals

1. Not a full Meteor replacement (no client-side query engine)
2. Not a state management solution (use SWR for that)
3. Not a WebSocket library (SSE-focused, though patterns are similar)
4. Not an offline-first solution (pairs well with SWR's existing features)

---

## Architecture

### Data Flow

```
┌─────────────────────────────────────────────────────────────────┐
│                           Server                                 │
│  ┌─────────────┐     ┌─────────────┐     ┌─────────────────┐   │
│  │  Database   │────▶│  Change     │────▶│  SSE Endpoint   │   │
│  │  (Mongo,    │     │  Detection  │     │  /api/events    │   │
│  │   Postgres) │     │             │     │                 │   │
│  └─────────────┘     └─────────────┘     └────────┬────────┘   │
└───────────────────────────────────────────────────┼─────────────┘
                                                    │
                                          SSE Stream│
                                                    ▼
┌─────────────────────────────────────────────────────────────────┐
│                           Client                                 │
│                                                                  │
│  ┌─────────────────┐     ┌─────────────────┐                   │
│  │   SSEProvider   │────▶│  Event Router   │                   │
│  │   (Connection)  │     │  (Config-based) │                   │
│  └─────────────────┘     └────────┬────────┘                   │
│                                   │                             │
│                    ┌──────────────┼──────────────┐             │
│                    ▼              ▼              ▼             │
│              ┌──────────┐  ┌──────────┐  ┌──────────┐         │
│              │ mutate() │  │ mutate() │  │ mutate() │         │
│              │ key: /a  │  │ key: /b  │  │ key: /c  │         │
│              └────┬─────┘  └────┬─────┘  └────┬─────┘         │
│                   │             │             │                │
│                   └─────────────┼─────────────┘                │
│                                 ▼                              │
│                    ┌─────────────────────┐                     │
│                    │     SWR Cache       │                     │
│                    │  (In-memory store)  │                     │
│                    └──────────┬──────────┘                     │
│                               │                                │
│              ┌────────────────┼────────────────┐               │
│              ▼                ▼                ▼               │
│        ┌──────────┐    ┌──────────┐    ┌──────────┐           │
│        │Component │    │Component │    │Component │           │
│        │useSWR(/a)│    │useSWR(/b)│    │useSWR(/c)│           │
│        └──────────┘    └──────────┘    └──────────┘           │
│                                                                │
└─────────────────────────────────────────────────────────────────┘
```

### Key Components

#### 1. SSEProvider

A React context provider that:
- Establishes and maintains the SSE connection
- Parses incoming events
- Routes events to the appropriate SWR cache keys via `mutate()`
- Handles reconnection on failure
- Exposes connection status to children

#### 2. Event Mapping Configuration

A declarative object that defines:
- Which event types to listen for
- How to resolve SWR cache key(s) from event payloads
- What update strategy to use (set, refetch, or custom merge)

#### 3. Update Strategies

Three built-in strategies:
- **`set`** - Replace cache with SSE payload (no network request)
- **`refetch`** - Ignore payload, trigger SWR revalidation (for notifications)
- **`(current, payload) => newValue`** - Custom merge function

---

## API Specification

### SSEConfig

```typescript
interface SSEConfig {
  /**
   * The SSE endpoint URL.
   * Must return Content-Type: text/event-stream
   */
  url: string

  /**
   * Event type to cache key mappings.
   * Keys are event type strings (e.g., "order:updated")
   */
  events: Record<string, EventMapping>

  /**
   * Custom event parser.
   * Default expects: { "type": "...", "payload": { ... } }
   */
  parseEvent?: (event: MessageEvent) => ParsedEvent

  /**
   * Called when SSE connection opens.
   */
  onConnect?: () => void

  /**
   * Called on SSE connection error.
   */
  onError?: (error: Event) => void

  /**
   * Called when SSE connection closes.
   */
  onDisconnect?: () => void

  /**
   * Reconnection configuration.
   */
  reconnect?: ReconnectConfig
}

interface ParsedEvent {
  type: string
  payload: unknown
}

interface ReconnectConfig {
  /**
   * Whether to automatically reconnect on failure.
   * Default: true
   */
  enabled?: boolean

  /**
   * Initial delay before reconnecting (ms).
   * Default: 1000
   */
  initialDelay?: number

  /**
   * Maximum delay between reconnection attempts (ms).
   * Default: 30000
   */
  maxDelay?: number

  /**
   * Multiplier for exponential backoff.
   * Default: 2
   */
  backoffMultiplier?: number

  /**
   * Maximum number of reconnection attempts.
   * Default: Infinity
   */
  maxAttempts?: number
}
```

### EventMapping

```typescript
interface EventMapping<TPayload = unknown, TData = unknown> {
  /**
   * SWR cache key(s) to update when this event is received.
   *
   * Can be:
   * - A static string: "/api/users"
   * - An array of strings: ["/api/users", "/api/stats"]
   * - A function that derives key(s) from the payload
   */
  key: string | string[] | ((payload: TPayload) => string | string[])

  /**
   * How to update the cached data.
   *
   * - "set": Replace cache with payload (no refetch)
   * - "refetch": Trigger SWR revalidation (ignores payload)
   * - function: Custom merge (current, payload) => newValue
   *
   * Default: "set"
   */
  update?: UpdateStrategy<TPayload, TData>

  /**
   * Optional filter function.
   * Return false to ignore this event.
   */
  filter?: (payload: TPayload) => boolean

  /**
   * Optional transform function.
   * Transform payload before applying update strategy.
   */
  transform?: (payload: TPayload) => unknown
}

type UpdateStrategy<TPayload, TData> =
  | 'set'
  | 'refetch'
  | ((current: TData | undefined, payload: TPayload) => TData)
```

### SSEProvider Component

```typescript
interface SSEProviderProps {
  /**
   * SSE configuration object.
   */
  config: SSEConfig

  /**
   * React children.
   */
  children: React.ReactNode
}

function SSEProvider(props: SSEProviderProps): JSX.Element
```

### Hooks

```typescript
/**
 * Returns the current SSE connection status.
 */
function useSSEStatus(): {
  connected: boolean
  connecting: boolean
  error: Error | null
  reconnectAttempt: number
}

/**
 * Imperatively subscribe to raw SSE events.
 * Useful for events that don't map to SWR cache.
 */
function useSSEEvent<T = unknown>(
  eventType: string,
  handler: (payload: T) => void
): void

/**
 * Direct SSE stream subscription (bypasses event mapping).
 * For dedicated streams that aren't part of the main event bus.
 */
function useSSEStream<T = unknown>(
  url: string,
  options?: {
    transform?: (data: unknown) => T
  }
): {
  data: T | undefined
  error: Error | undefined
}
```

---

## Event Protocol

### Default Format

The default parser expects events in this format:

```
data: {"type": "order:updated", "payload": {"id": "123", "status": "shipped"}}

data: {"type": "comment:added", "payload": {"postId": "456", "comment": {...}}}
```

### Named Events

SSE supports named events via the `event:` field:

```
event: order:updated
data: {"id": "123", "status": "shipped"}

event: comment:added
data: {"postId": "456", "comment": {...}}
```

To use named events, provide a custom parser:

```typescript
parseEvent: (event) => ({
  type: event.type,  // SSE event name
  payload: JSON.parse(event.data)
})
```

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
│          │────────────────────▶│           │
│  Closed  │                     │ Connected │
│          │◀────────────────────│           │
└──────────┘     onDisconnect()  └───────────┘
     ▲                                 │
     │                                 │
     │         onError()               │
     │                                 ▼
     │                           ┌───────────┐
     └───────────────────────────│           │
           (after max retries)   │ Retrying  │
                                 │           │
                                 └───────────┘
                                       │
                                       │ (retry succeeds)
                                       ▼
                                 ┌───────────┐
                                 │ Connected │
                                 └───────────┘
```

### Reconnection Behavior

1. On connection error, wait `initialDelay` ms
2. Attempt reconnection
3. On failure, multiply delay by `backoffMultiplier`
4. Cap delay at `maxDelay`
5. Continue until `maxAttempts` reached or connection succeeds
6. On success, reset retry counter and delay

### Browser Tab Visibility

When the browser tab becomes hidden:
- SSE connection may be throttled by the browser
- On tab focus, connection is checked and re-established if needed

---

## TypeScript Support

### Typed Event Configurations

```typescript
// Define your event types
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

// Type-safe config
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

### Type Generation from Schema

For projects using OpenAPI or similar schemas, event types can be generated:

```typescript
// Generated from openapi.yaml
import type { Events } from './generated/events'

const config: SSEConfig<Events> = {
  url: '/api/events',
  events: {
    'order:updated': { ... },  // TypeScript knows the payload shape
  },
}
```

---

## Performance Considerations

### Memory

- One SSE connection per provider instance
- Event mappings are stored once in the provider
- SWR handles cache memory management

### CPU

- Event parsing: O(1) JSON parse per event
- Key resolution: O(1) for static keys, O(n) for array keys
- Cache update: Delegated to SWR's `mutate()`

### Network

- Single persistent HTTP connection for all events
- No polling overhead
- Automatic browser reconnection with last event ID
- Full payloads eliminate redundant API calls

### Bundle Size

Target: < 2KB gzipped (excluding SWR peer dependency)

---

## Error Handling

### Connection Errors

```typescript
const config: SSEConfig = {
  url: '/api/events',
  events: { ... },

  onError: (error) => {
    // Log to monitoring service
    captureException(error)
  },

  onDisconnect: () => {
    // Show toast notification
    toast.warning('Real-time updates disconnected. Reconnecting...')
  },

  onConnect: () => {
    toast.success('Real-time updates restored')
  },
}
```

### Event Processing Errors

If an event handler throws, it should:
1. Log the error
2. Continue processing subsequent events
3. Not crash the provider

```typescript
// Internal error boundary per event
try {
  processEvent(event)
} catch (error) {
  console.error(`Error processing event ${event.type}:`, error)
  config.onEventError?.(event, error)
}
```

### Invalid Events

Events that don't match any mapping are silently ignored by default. Enable debug mode to log them:

```typescript
const config: SSEConfig = {
  debug: true,  // Logs unhandled events
  ...
}
```

---

## Testing

### Unit Testing Components

Components using `useSWR` can be tested normally—they don't know about SSE:

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

### Integration Testing SSE Updates

```typescript
import { SSEProvider } from 'reactive-swr'
import { mockSSE } from 'reactive-swr/testing'

test('updates order when SSE event received', async () => {
  const { sendEvent } = mockSSE('/api/events')

  render(
    <SSEProvider config={sseConfig}>
      <OrderStatus orderId="123" />
    </SSEProvider>
  )

  // Initial state
  expect(screen.getByText('Status: pending')).toBeInTheDocument()

  // Simulate SSE event
  sendEvent({
    type: 'order:updated',
    payload: { id: '123', status: 'shipped' },
  })

  // Updated state
  await waitFor(() => {
    expect(screen.getByText('Status: shipped')).toBeInTheDocument()
  })
})
```

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
4. Server-side implementation (focus is client-side)
