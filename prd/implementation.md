# reactiveSWR Implementation PRD

## Overview

Build a lightweight library that bridges Server-Sent Events (SSE) with SWR's cache layer, enabling Meteor-style reactive data fetching in React applications.

## Goals

1. **Declarative event mapping** - Single config defines how SSE events update cached data
2. **Zero component changes** - Existing `useSWR` hooks become reactive automatically
3. **Efficient updates** - SSE payloads update cache directly (no redundant API calls)
4. **Type safety** - Full TypeScript support with inferred types
5. **Lightweight** - Target < 2KB gzipped

## Technical Context

- **Runtime**: Browser (React 18/19)
- **Peer Dependencies**: `react`, `swr`
- **Build Tool**: Bun
- **Testing**: Bun test, Playwright for E2E

---

## Feature 1: TypeScript Types

### Description
Define all TypeScript interfaces and types that form the public API contract.

### Requirements

1.1. Define `SSEConfig` interface:
- `url: string` - SSE endpoint URL
- `events: Record<string, EventMapping>` - Event type to mapping
- `parseEvent?: (event: MessageEvent) => ParsedEvent` - Custom parser
- `onConnect?: () => void` - Connection opened callback
- `onError?: (error: Event) => void` - Connection error callback
- `onDisconnect?: () => void` - Connection closed callback
- `reconnect?: ReconnectConfig` - Reconnection settings
- `debug?: boolean` - Enable debug logging

1.2. Define `EventMapping<TPayload, TData>` interface:
- `key: string | string[] | ((payload: TPayload) => string | string[])` - Cache key(s)
- `update?: UpdateStrategy<TPayload, TData>` - How to update cache
- `filter?: (payload: TPayload) => boolean` - Optional event filter
- `transform?: (payload: TPayload) => unknown` - Optional payload transform

1.3. Define `UpdateStrategy` type:
- `'set'` - Replace cache with payload
- `'refetch'` - Trigger SWR revalidation
- `(current: TData | undefined, payload: TPayload) => TData` - Custom merge

1.4. Define `ReconnectConfig` interface:
- `enabled?: boolean` - Default: true
- `initialDelay?: number` - Default: 1000ms
- `maxDelay?: number` - Default: 30000ms
- `backoffMultiplier?: number` - Default: 2
- `maxAttempts?: number` - Default: Infinity

1.5. Define `ParsedEvent` interface:
- `type: string`
- `payload: unknown`

1.6. Define `SSEStatus` interface:
- `connected: boolean`
- `connecting: boolean`
- `error: Error | null`
- `reconnectAttempt: number`

### Acceptance Criteria
- All types are exported from `src/types.ts`
- Types compile without errors
- Types are re-exported from `src/index.ts`

---

## Feature 2: SSEProvider Core

### Description
Implement the core `SSEProvider` React component that establishes SSE connections and routes events to SWR cache.

### Requirements

2.1. Create `SSEProvider` component that:
- Accepts `config: SSEConfig` and `children: React.ReactNode` props
- Creates an `EventSource` connection to `config.url` on mount
- Closes the connection on unmount
- Provides context to children

2.2. Implement default event parsing:
- Parse `event.data` as JSON
- Expect format: `{ "type": "...", "payload": { ... } }`
- Support custom `parseEvent` function from config

2.3. Implement event routing:
- Match parsed event type against `config.events` keys
- Resolve cache key(s) from `EventMapping.key`
- Call SWR `mutate()` with appropriate strategy

2.4. Call lifecycle callbacks:
- `onConnect` when EventSource opens
- `onError` when EventSource errors
- `onDisconnect` when EventSource closes

### Acceptance Criteria
- Provider renders children
- EventSource connects to specified URL
- Events are parsed and routed to correct cache keys
- Connection cleans up on unmount
- Lifecycle callbacks are invoked

---

## Feature 3: Update Strategies

### Description
Implement the three update strategies for modifying SWR cache.

### Requirements

3.1. Implement `'set'` strategy:
- Replace cache value with event payload directly
- No network request triggered
- Handle `transform` if provided

3.2. Implement `'refetch'` strategy:
- Call `mutate(key, undefined, { revalidate: true })`
- Ignore event payload
- Triggers SWR to refetch from server

3.3. Implement custom function strategy:
- Call `mutate(key, (current) => updateFn(current, payload))`
- Pass current cached value and event payload to function
- Use returned value as new cache value

3.4. Implement `filter` support:
- Before processing, call `filter(payload)` if defined
- Skip event if filter returns false

3.5. Implement `transform` support:
- After filter, call `transform(payload)` if defined
- Use transformed value for update strategies

3.6. Support array keys:
- When `key` resolves to `string[]`, apply update to all keys

### Acceptance Criteria
- `'set'` replaces cache without network call
- `'refetch'` triggers SWR revalidation
- Custom functions receive current value and payload
- Filters can skip events
- Transforms modify payload before update
- Multiple keys all receive updates

---

## Feature 4: Reconnection Logic

### Description
Implement automatic reconnection with exponential backoff when SSE connection fails.

### Requirements

4.1. Detect connection failures:
- Handle EventSource `onerror` events
- Track connection state (connecting, connected, disconnected)

4.2. Implement exponential backoff:
- Start with `initialDelay` (default 1000ms)
- Multiply by `backoffMultiplier` (default 2) on each failure
- Cap at `maxDelay` (default 30000ms)
- Stop after `maxAttempts` (default Infinity)

4.3. Reset on successful connection:
- Reset retry counter to 0
- Reset delay to `initialDelay`

4.4. Respect `reconnect.enabled`:
- When false, do not attempt reconnection
- Default to true

4.5. Track reconnection attempts:
- Expose current attempt number via context

### Acceptance Criteria
- Automatically reconnects on connection failure
- Delay increases exponentially up to max
- Stops after max attempts reached
- Resets state on successful reconnection
- Can be disabled via config

---

## Feature 5: useSSEStatus Hook

### Description
Provide a hook for components to access SSE connection status.

### Requirements

5.1. Create `useSSEStatus()` hook that returns:
- `connected: boolean` - True when EventSource is open
- `connecting: boolean` - True during connection/reconnection
- `error: Error | null` - Last connection error
- `reconnectAttempt: number` - Current retry attempt (0 when connected)

5.2. Hook must be used within SSEProvider:
- Throw helpful error if used outside provider

5.3. Updates reactively:
- Component re-renders when status changes

### Acceptance Criteria
- Returns accurate connection status
- Throws if used outside provider
- Re-renders on status changes

---

## Feature 6: useSSEEvent Hook

### Description
Allow components to subscribe to raw SSE events outside the declarative config.

### Requirements

6.1. Create `useSSEEvent<T>(eventType: string, handler: (payload: T) => void)`:
- Subscribe to events of specified type
- Call handler with payload when event received
- Handler should be stable (use latest ref pattern)

6.2. Cleanup on unmount:
- Unsubscribe when component unmounts

6.3. Work alongside declarative config:
- Events can trigger both config mappings AND useSSEEvent handlers

### Acceptance Criteria
- Handler called when matching event received
- Unsubscribes on unmount
- Multiple subscribers to same event type work
- Works with declarative config simultaneously

---

## Feature 7: useSSEStream Hook

### Description
Provide a hook for subscribing to dedicated SSE streams separate from the main event bus.

### Requirements

7.1. Create `useSSEStream<T>(url: string, options?)`:
- Create dedicated EventSource to specified URL
- Return `{ data: T | undefined, error: Error | undefined }`

7.2. Support transform option:
- `options.transform?: (data: unknown) => T`
- Apply transform to incoming data

7.3. Manage connection lifecycle:
- Connect on mount
- Disconnect on unmount
- Handle errors gracefully

### Acceptance Criteria
- Creates separate EventSource connection
- Returns latest data from stream
- Cleans up on unmount
- Transform function works

---

## Feature 8: Testing Utilities

### Description
Provide utilities for testing components that use reactiveSWR.

### Requirements

8.1. Create `mockSSE(url: string)` utility:
- Returns `{ sendEvent, close, getConnection }`
- `sendEvent({ type, payload })` - Simulate SSE event
- `close()` - Simulate connection close
- `getConnection()` - Access mock EventSource

8.2. Mock should intercept EventSource:
- Replace global EventSource during test
- Restore after test

8.3. Export from `reactive-swr/testing`:
- Separate entry point for test utilities

### Acceptance Criteria
- Can simulate SSE events in tests
- Can test connection/disconnection handling
- Does not pollute production bundle

---

## Feature 9: Tab Visibility Handling

### Description
Handle browser tab visibility changes to maintain reliable connections.

### Requirements

9.1. Listen for visibility changes:
- Use `document.visibilitychange` event

9.2. On tab becoming visible:
- Check if EventSource is still connected
- Reconnect if connection was lost while hidden

9.3. Respect browser throttling:
- Browsers may throttle background tabs
- Ensure reconnection works after tab focus

### Acceptance Criteria
- Reconnects when tab becomes visible if disconnected
- Does not create duplicate connections

---

## Feature 10: Error Handling

### Description
Implement robust error handling that prevents crashes and aids debugging.

### Requirements

10.1. Wrap event processing in try-catch:
- Log errors but continue processing
- Call `config.onEventError?.(event, error)` if provided

10.2. Handle malformed events:
- Invalid JSON should not crash provider
- Log warning in debug mode

10.3. Debug mode:
- When `config.debug: true`, log:
  - All received events
  - Unhandled event types
  - Cache mutations performed

### Acceptance Criteria
- Bad events don't crash the provider
- Errors are logged and reported via callback
- Debug mode provides visibility into event flow

---

## Implementation Order

1. Feature 1: TypeScript Types
2. Feature 2: SSEProvider Core
3. Feature 3: Update Strategies
4. Feature 4: Reconnection Logic
5. Feature 5: useSSEStatus Hook
6. Feature 6: useSSEEvent Hook
7. Feature 7: useSSEStream Hook
8. Feature 9: Tab Visibility Handling
9. Feature 10: Error Handling
10. Feature 8: Testing Utilities

---

## Out of Scope

- Server-side implementation
- WebSocket transport
- Client-side query engine
- Offline queue/replay
- Conflict resolution
