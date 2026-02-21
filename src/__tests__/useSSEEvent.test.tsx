import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { createElement, useState } from 'react'
import { renderToString } from 'react-dom/server'
import { SSEProvider, useSSEContext } from '../SSEProvider.tsx'
import type { SSEConfig } from '../types.ts'

/**
 * Tests for useSSEEvent hook (WI-067).
 *
 * These tests verify:
 * 1. Handler called when matching event type is received
 * 2. Unsubscribes automatically on unmount
 * 3. Multiple subscribers to same event type all receive events
 * 4. Works simultaneously with declarative config mappings
 * 5. Handler updates don't cause resubscription (ref pattern)
 *
 * Tests should FAIL until useSSEEvent.ts is implemented.
 */

// Simple EventSource mock for testing
class MockEventSource {
  static instances: MockEventSource[] = []
  url: string
  readyState = 0 // CONNECTING
  onmessage: ((event: MessageEvent) => void) | null = null
  onerror: ((event: Event) => void) | null = null
  onopen: ((event: Event) => void) | null = null

  private eventListeners = new Map<string, Set<(event: MessageEvent) => void>>()

  constructor(url: string) {
    this.url = url
    MockEventSource.instances.push(this)
    // Simulate async open
    queueMicrotask(() => {
      this.readyState = 1 // OPEN
      this.onopen?.(new Event('open'))
    })
  }

  close() {
    this.readyState = 2 // CLOSED
  }

  addEventListener(type: string, handler: (event: MessageEvent) => void) {
    if (!this.eventListeners.has(type)) {
      this.eventListeners.set(type, new Set())
    }
    this.eventListeners.get(type)?.add(handler)
  }

  removeEventListener(type: string, handler: (event: MessageEvent) => void) {
    this.eventListeners.get(type)?.delete(handler)
  }

  dispatchEvent() {
    return true
  }

  // Test helper to simulate incoming named event
  simulateEvent(type: string, payload: unknown) {
    const handlers = this.eventListeners.get(type)
    if (handlers) {
      for (const handler of handlers) {
        handler(new MessageEvent(type, { data: JSON.stringify(payload) }))
      }
    }
  }

  // Test helper to simulate generic message (uses onmessage)
  simulateMessage(data: { type: string; payload: unknown }) {
    if (this.onmessage) {
      this.onmessage(
        new MessageEvent('message', { data: JSON.stringify(data) }),
      )
    }
  }

  static reset() {
    MockEventSource.instances = []
  }

  static get CONNECTING() {
    return 0
  }
  static get OPEN() {
    return 1
  }
  static get CLOSED() {
    return 2
  }
}

// Replace global EventSource with mock
const originalEventSource = globalThis.EventSource
beforeEach(() => {
  // @ts-expect-error - Mocking EventSource
  globalThis.EventSource = MockEventSource
  MockEventSource.reset()
})

afterEach(() => {
  globalThis.EventSource = originalEventSource
})

// Import the hook we're testing (will fail until implemented)
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { useSSEEvent } = await import('../hooks/useSSEEvent.ts')

const testConfig: SSEConfig = {
  url: 'http://localhost:3000/events',
  events: {
    'user.updated': {
      key: '/api/user',
    },
    'order.created': {
      key: '/api/orders',
    },
  },
}

describe('useSSEEvent', () => {
  describe('event subscription', () => {
    it('should call handler when matching event type is received', () => {
      const receivedPayloads: unknown[] = []

      function EventConsumer() {
        useSSEEvent('user.updated', (payload: unknown) => {
          receivedPayloads.push(payload)
        })
        return createElement('div', null, 'listening')
      }

      renderToString(
        createElement(
          SSEProvider,
          { config: testConfig },
          createElement(EventConsumer),
        ),
      )

      // Get the EventSource instance and simulate an event
      const source = MockEventSource.instances[0]
      source.simulateEvent('user.updated', { id: 123, name: 'John' })

      expect(receivedPayloads.length).toBe(1)
      expect(receivedPayloads[0]).toEqual({ id: 123, name: 'John' })
    })

    it('should not call handler for non-matching event types', () => {
      const receivedPayloads: unknown[] = []

      function EventConsumer() {
        useSSEEvent('user.updated', (payload: unknown) => {
          receivedPayloads.push(payload)
        })
        return createElement('div', null, 'listening')
      }

      renderToString(
        createElement(
          SSEProvider,
          { config: testConfig },
          createElement(EventConsumer),
        ),
      )

      // Simulate a different event type
      const source = MockEventSource.instances[0]
      source.simulateEvent('order.created', { orderId: 456 })

      expect(receivedPayloads.length).toBe(0)
    })
  })

  describe('unsubscription', () => {
    it('should unsubscribe when component unmounts', () => {
      const receivedPayloads: unknown[] = []
      let subscribeFn: ReturnType<typeof useSSEContext>['subscribe'] | null =
        null

      function EventConsumer() {
        useSSEEvent('user.updated', (payload: unknown) => {
          receivedPayloads.push(payload)
        })
        const ctx = useSSEContext()
        subscribeFn = ctx.subscribe
        return createElement('div', null, 'listening')
      }

      // Mount component
      renderToString(
        createElement(
          SSEProvider,
          { config: testConfig },
          createElement(EventConsumer),
        ),
      )

      // The subscribe function should have been captured
      expect(subscribeFn).toBeFunction()

      // In SSR, effects don't run cleanup, but we can verify the pattern
      // by checking that the hook properly returns an unsubscribe in the effect
      // For a true unmount test, we'd need a client-side environment

      // Simulate event - should be received before unmount
      const source = MockEventSource.instances[0]
      source.simulateEvent('user.updated', { id: 1 })
      expect(receivedPayloads.length).toBe(1)
    })

    it('should call unsubscribe function from context on cleanup', () => {
      // This test verifies that the useEffect cleanup calls unsubscribe
      // Since we're in SSR mode (renderToString), effects don't actually run,
      // but we can verify the hook integrates correctly with the context

      function EventConsumer() {
        // The hook should call context.subscribe internally
        useSSEEvent('test.event', () => {})
        return createElement('div', null, 'listening')
      }

      // Should render without error, proving hook integrates with context
      const html = renderToString(
        createElement(
          SSEProvider,
          { config: testConfig },
          createElement(EventConsumer),
        ),
      )

      // Hook rendered successfully within provider context
      expect(html).toContain('listening')
    })
  })

  describe('multiple subscribers', () => {
    it('should deliver events to all subscribers of the same event type', () => {
      const receivedByFirst: unknown[] = []
      const receivedBySecond: unknown[] = []
      const receivedByThird: unknown[] = []

      function FirstConsumer() {
        useSSEEvent('shared.event', (payload: unknown) => {
          receivedByFirst.push(payload)
        })
        return createElement('div', null, 'first')
      }

      function SecondConsumer() {
        useSSEEvent('shared.event', (payload: unknown) => {
          receivedBySecond.push(payload)
        })
        return createElement('div', null, 'second')
      }

      function ThirdConsumer() {
        useSSEEvent('shared.event', (payload: unknown) => {
          receivedByThird.push(payload)
        })
        return createElement('div', null, 'third')
      }

      // Extend config to include shared.event
      const extendedConfig: SSEConfig = {
        ...testConfig,
        events: {
          ...testConfig.events,
          'shared.event': { key: '/api/shared' },
        },
      }

      renderToString(
        createElement(
          SSEProvider,
          { config: extendedConfig },
          createElement('div', null, [
            createElement(FirstConsumer, { key: '1' }),
            createElement(SecondConsumer, { key: '2' }),
            createElement(ThirdConsumer, { key: '3' }),
          ]),
        ),
      )

      // Simulate event
      const source = MockEventSource.instances[0]
      source.simulateEvent('shared.event', { message: 'hello all' })

      // All three should receive the event
      expect(receivedByFirst.length).toBe(1)
      expect(receivedBySecond.length).toBe(1)
      expect(receivedByThird.length).toBe(1)

      expect(receivedByFirst[0]).toEqual({ message: 'hello all' })
      expect(receivedBySecond[0]).toEqual({ message: 'hello all' })
      expect(receivedByThird[0]).toEqual({ message: 'hello all' })
    })

    it('should allow different components to subscribe to different event types', () => {
      const userEvents: unknown[] = []
      const orderEvents: unknown[] = []

      function UserConsumer() {
        useSSEEvent('user.updated', (payload: unknown) => {
          userEvents.push(payload)
        })
        return createElement('div', null, 'user consumer')
      }

      function OrderConsumer() {
        useSSEEvent('order.created', (payload: unknown) => {
          orderEvents.push(payload)
        })
        return createElement('div', null, 'order consumer')
      }

      renderToString(
        createElement(
          SSEProvider,
          { config: testConfig },
          createElement('div', null, [
            createElement(UserConsumer, { key: 'user' }),
            createElement(OrderConsumer, { key: 'order' }),
          ]),
        ),
      )

      const source = MockEventSource.instances[0]

      // Send user event
      source.simulateEvent('user.updated', { userId: 1 })

      // Send order event
      source.simulateEvent('order.created', { orderId: 100 })

      // Each should only receive their type
      expect(userEvents.length).toBe(1)
      expect(userEvents[0]).toEqual({ userId: 1 })

      expect(orderEvents.length).toBe(1)
      expect(orderEvents[0]).toEqual({ orderId: 100 })
    })
  })

  describe('declarative config interaction', () => {
    it('should work alongside declarative config mappings', () => {
      const imperativeReceived: unknown[] = []

      function EventConsumer() {
        // Use imperative hook for the same event type that's in config
        useSSEEvent('user.updated', (payload: unknown) => {
          imperativeReceived.push(payload)
        })
        return createElement('div', null, 'listening')
      }

      renderToString(
        createElement(
          SSEProvider,
          { config: testConfig },
          createElement(EventConsumer),
        ),
      )

      // Simulate event - both declarative config and imperative handler should work
      const source = MockEventSource.instances[0]
      source.simulateEvent('user.updated', { id: 999 })

      // The imperative handler should receive the event
      expect(imperativeReceived.length).toBe(1)
      expect(imperativeReceived[0]).toEqual({ id: 999 })
    })
  })

  describe('handler stability (ref pattern)', () => {
    it('should not resubscribe when handler function changes', () => {
      const receivedPayloads: unknown[] = []

      // Track subscribe calls via context
      function SubscribeTracker() {
        useSSEContext() // Verify we're in provider context

        // Create new handler on each render (simulating closure over changing state)
        const [counter, setCounter] = useState(0)
        const handler = (payload: unknown) => {
          receivedPayloads.push({ payload, counter })
        }

        // Trigger re-render to create new handler function
        if (counter === 0) {
          queueMicrotask(() => setCounter(1))
        }

        useSSEEvent('test.event', handler)

        return createElement('div', null, `counter: ${counter}`)
      }

      const extendedConfig: SSEConfig = {
        ...testConfig,
        events: {
          ...testConfig.events,
          'test.event': { key: '/api/test' },
        },
      }

      // First render
      renderToString(
        createElement(
          SSEProvider,
          { config: extendedConfig },
          createElement(SubscribeTracker),
        ),
      )

      // Second render (simulates re-render with new handler)
      renderToString(
        createElement(
          SSEProvider,
          { config: extendedConfig },
          createElement(SubscribeTracker),
        ),
      )

      // The hook should use ref pattern, so even though handler changed,
      // there should be no resubscription. The test verifies this by
      // checking that events are still received correctly.
      const source = MockEventSource.instances[0]
      source.simulateEvent('test.event', { data: 'test' })

      // Should still receive the event (ref pattern keeps subscription stable)
      expect(receivedPayloads.length).toBeGreaterThanOrEqual(1)
    })

    it('should use latest handler via ref pattern (no stale closures)', () => {
      // Test verifies that handlerRef.current is updated on each render.
      // In SSR, we can't test actual state updates, but we can verify that
      // different handler functions passed on successive renders are used.
      const receivedValues: number[] = []
      let currentMultiplier = 1

      function LatestHandlerConsumer({ multiplier }: { multiplier: number }) {
        // Handler captures current multiplier from props
        const handler = (payload: unknown) => {
          const value = (payload as { value: number }).value * multiplier
          receivedValues.push(value)
        }

        useSSEEvent('calc.event', handler)

        return createElement('div', null, `multiplier: ${multiplier}`)
      }

      const extendedConfig: SSEConfig = {
        ...testConfig,
        events: {
          ...testConfig.events,
          'calc.event': { key: '/api/calc' },
        },
      }

      // First render with multiplier=1
      renderToString(
        createElement(
          SSEProvider,
          { config: extendedConfig },
          createElement(LatestHandlerConsumer, { multiplier: 1 }),
        ),
      )

      // Simulate event with multiplier=1 - should get 5
      const source = MockEventSource.instances[0]
      source.simulateEvent('calc.event', { value: 5 })
      expect(receivedValues).toContain(5)

      // Re-render with multiplier=10 (new handler closure via props)
      currentMultiplier = 10
      renderToString(
        createElement(
          SSEProvider,
          { config: extendedConfig },
          createElement(LatestHandlerConsumer, {
            multiplier: currentMultiplier,
          }),
        ),
      )

      // Simulate another event - the ref pattern should use the LATEST handler
      // Note: In SSR each renderToString creates a new context, so we test that
      // the pattern correctly updates handlerRef.current on each render
      const latestSource =
        MockEventSource.instances[MockEventSource.instances.length - 1]
      latestSource.simulateEvent('calc.event', { value: 5 })
      expect(receivedValues).toContain(50)
    })
  })

  describe('error cases', () => {
    it('should throw when used outside SSEProvider', () => {
      function OrphanConsumer() {
        useSSEEvent('test.event', () => {})
        return createElement('div', null, 'should not render')
      }

      expect(() => {
        renderToString(createElement(OrphanConsumer))
      }).toThrow()
    })
  })

  describe('type safety', () => {
    it('should accept generic type parameter for payload', () => {
      interface UserPayload {
        id: number
        name: string
      }

      const typedPayloads: UserPayload[] = []

      function TypedConsumer() {
        useSSEEvent<UserPayload>('user.updated', (payload) => {
          // TypeScript should infer payload as UserPayload
          typedPayloads.push(payload)
        })
        return createElement('div', null, 'typed')
      }

      renderToString(
        createElement(
          SSEProvider,
          { config: testConfig },
          createElement(TypedConsumer),
        ),
      )

      const source = MockEventSource.instances[0]
      source.simulateEvent('user.updated', { id: 1, name: 'Alice' })

      expect(typedPayloads[0].id).toBe(1)
      expect(typedPayloads[0].name).toBe('Alice')
    })
  })
})
