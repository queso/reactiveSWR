# API Reference

Complete API documentation for reactiveSWR.

## Components

### SSEProvider

The main provider component that establishes and manages the SSE connection.

```tsx
import { SSEProvider } from 'reactive-swr'

<SSEProvider config={sseConfig}>
  <App />
</SSEProvider>
```

**Props:**

| Prop | Type | Description |
|------|------|-------------|
| `config` | `SSEConfig` | Configuration object (see below) |
| `children` | `ReactNode` | Child components |

**Requirements:**
- Must be wrapped in SWR's `SWRConfig` provider
- Only one `SSEProvider` should be active per SSE endpoint

## Configuration

### SSEConfig

```typescript
interface SSEConfig {
  url: string
  events: Record<string, EventMapping>
  parseEvent?: (event: MessageEvent) => ParsedEvent
  reconnect?: ReconnectConfig
  debug?: boolean
  onConnect?: () => void
  onDisconnect?: () => void
  onError?: (error: Event) => void
  onEventError?: (event: ParsedEvent, error: unknown) => void
}
```

| Property | Type | Required | Description |
|----------|------|----------|-------------|
| `url` | `string` | Yes | The SSE endpoint URL |
| `events` | `Record<string, EventMapping>` | Yes | Map of event types to their handlers |
| `parseEvent` | `(event: MessageEvent) => ParsedEvent` | No | Custom event parser. Default expects `{ type, payload }` JSON |
| `reconnect` | `ReconnectConfig` | No | Reconnection settings |
| `debug` | `boolean` | No | Enable console.debug logging |
| `onConnect` | `() => void` | No | Called when connection opens |
| `onDisconnect` | `() => void` | No | Called when connection closes |
| `onError` | `(error: Event) => void` | No | Called on connection error |
| `onEventError` | `(event: ParsedEvent, error: unknown) => void` | No | Called when event processing fails |

### EventMapping

Defines how to handle a specific event type.

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
| `key` | `string \| string[] \| ((payload) => string \| string[])` | Yes | SWR cache key(s) to update |
| `update` | `UpdateStrategy` | No | How to update the cache. Default: `'set'` |
| `filter` | `(payload) => boolean` | No | Return `false` to skip this event |
| `transform` | `(payload) => payload` | No | Transform payload before cache update |

### UpdateStrategy

```typescript
type UpdateStrategy<TPayload, TData> =
  | 'set'
  | 'refetch'
  | ((current: TData | undefined, payload: TPayload) => TData)
```

| Strategy | Description |
|----------|-------------|
| `'set'` | Replace cache with payload directly (no network request) |
| `'refetch'` | Trigger SWR revalidation (ignores payload, fetches fresh data) |
| `function` | Custom merge: receives current cache value and payload, returns new value |

### ReconnectConfig

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

### ParsedEvent

```typescript
interface ParsedEvent {
  type: string
  payload: unknown
}
```

## Hooks

### useSSEStatus

Returns the current SSE connection status.

```typescript
function useSSEStatus(): SSEStatus
```

**Returns:**

```typescript
interface SSEStatus {
  connected: boolean      // True when connection is open
  connecting: boolean     // True during connection/reconnection
  error: Error | null     // Last connection error, if any
  reconnectAttempt: number // Current reconnection attempt (0 when connected)
}
```

**Usage:**

```tsx
import { useSSEStatus } from 'reactive-swr'

function ConnectionStatus() {
  const { connected, connecting, error, reconnectAttempt } = useSSEStatus()

  if (error) return <div>Error: {error.message}</div>
  if (connecting) return <div>Reconnecting (attempt {reconnectAttempt})...</div>
  if (connected) return <div>Connected</div>
  return <div>Disconnected</div>
}
```

**Requirements:**
- Must be used within an `SSEProvider`

### useSSEEvent

Subscribe to raw SSE events imperatively.

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
| `handler` | `(payload: T) => void` | Callback invoked when event is received |

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
- Handler is called for ALL events of that type (regardless of config.events)
- Uses a ref pattern internally, so handler changes don't cause resubscription
- Must be used within an `SSEProvider`

### useSSEStream

Create an independent SSE connection for a dedicated stream.

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
| `options` | `UseSSEStreamOptions<T>` | Optional configuration |

**Options:**

```typescript
interface UseSSEStreamOptions<T> {
  transform?: (data: unknown) => T
}
```

| Option | Type | Description |
|--------|------|-------------|
| `transform` | `(data: unknown) => T` | Transform raw data before storing |

**Returns:**

```typescript
interface UseSSEStreamResult<T> {
  data: T | undefined      // Latest received data
  error: Error | undefined // Connection or parse error
}
```

**Usage:**

```tsx
import { useSSEStream } from 'reactive-swr'

function StockTicker({ symbol }: { symbol: string }) {
  const { data, error } = useSSEStream<{ price: number; change: number }>(
    `/api/stocks/${symbol}/stream`,
    {
      transform: (raw) => raw as { price: number; change: number }
    }
  )

  if (error) return <span>--</span>
  if (!data) return <span>Loading...</span>

  return (
    <span>
      ${data.price.toFixed(2)} ({data.change > 0 ? '+' : ''}{data.change}%)
    </span>
  )
}
```

**Notes:**
- Does NOT require `SSEProvider` - creates its own EventSource
- Connections are shared across components using the same URL
- Connection closes automatically when no components are subscribed
- URL changes close the old connection and open a new one

## Testing Utilities

### mockSSE

Mock EventSource connections for testing.

```typescript
import { mockSSE } from 'reactive-swr/testing'

function mockSSE(url: string): MockSSEControls
```

**Returns:**

```typescript
interface MockSSEControls {
  sendEvent: (event: SSEEventData) => void
  close: () => void
  getConnection: () => MockEventSource | undefined
}

interface SSEEventData {
  type: string
  payload: unknown
}
```

| Method | Description |
|--------|-------------|
| `sendEvent(event)` | Dispatch an SSE event to listeners |
| `close()` | Simulate connection close (triggers error handlers) |
| `getConnection()` | Get the mock EventSource instance |

**Static Methods:**

```typescript
mockSSE.restore(): void  // Restore original EventSource and clean up all mocks
```

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
      <SSEProvider config={config}>
        <OrderStatus orderId="123" />
      </SSEProvider>
    )

    mock.sendEvent({
      type: 'order:updated',
      payload: { id: '123', status: 'shipped' }
    })

    await waitFor(() => {
      expect(screen.getByText('shipped')).toBeInTheDocument()
    })
  })

  it('handles connection close', async () => {
    const mock = mockSSE('/api/events')

    render(
      <SSEProvider config={config}>
        <ConnectionStatus />
      </SSEProvider>
    )

    mock.close()

    await waitFor(() => {
      expect(screen.getByText('Disconnected')).toBeInTheDocument()
    })
  })
})
```

## Type Exports

All types are exported for use in your code:

```typescript
import type {
  SSEConfig,
  SSEProviderProps,
  SSEStatus,
  EventMapping,
  UpdateStrategy,
  ReconnectConfig,
  ParsedEvent,
  UseSSEStreamOptions,
  UseSSEStreamResult,
} from 'reactive-swr'

import type {
  MockSSEControls,
  SSEEventData,
} from 'reactive-swr/testing'
```
