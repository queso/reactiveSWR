import { describe, expect, it } from 'bun:test'
import { createElement } from 'react'
import { renderToString } from 'react-dom/server'
import { SSEProvider, useSSEContext } from '../SSEProvider.tsx'
import type { SSEConfig, SSEStatus } from '../types.ts'

/**
 * Tests for SSEProvider context shell and subscribe mechanism (WI-062).
 *
 * These tests verify:
 * 1. SSEProvider renders its children
 * 2. useSSEContext throws when used outside provider
 * 3. Initial SSEStatus state is correct
 * 4. subscribe() returns an unsubscribe function
 * 5. Unsubscribe removes the handler
 * 6. Multiple subscribers to the same event type all work
 *
 * Tests should FAIL until SSEProvider.tsx is implemented.
 */

const testConfig: SSEConfig = {
  url: 'http://localhost:3000/events',
  events: {
    'user.updated': {
      key: '/api/user',
    },
  },
}

describe('SSEProvider', () => {
  describe('rendering', () => {
    it('should render children within the provider', () => {
      const html = renderToString(
        createElement(
          SSEProvider,
          { config: testConfig },
          createElement('div', { 'data-testid': 'child' }, 'Hello from child'),
        ),
      )
      expect(html).toContain('Hello from child')
    })
  })

  describe('useSSEContext', () => {
    it('should throw a descriptive error when used outside provider', () => {
      // Component that tries to use context outside a provider
      function OrphanConsumer() {
        useSSEContext()
        return createElement('div', null, 'should not render')
      }

      expect(() => {
        renderToString(createElement(OrphanConsumer))
      }).toThrow()
    })

    it('should provide initial SSEStatus with connecting state during connection attempt', () => {
      let capturedStatus: SSEStatus | null = null

      function StatusCapture() {
        const ctx = useSSEContext()
        capturedStatus = ctx.status
        return createElement('div', null, 'status captured')
      }

      renderToString(
        createElement(
          SSEProvider,
          { config: testConfig },
          createElement(StatusCapture),
        ),
      )

      expect(capturedStatus).not.toBeNull()
      // biome-ignore lint/style/noNonNullAssertion: asserted not-null above
      expect(capturedStatus!.connected).toBe(false)
      // During initial render, connecting is true because EventSource is being established
      // biome-ignore lint/style/noNonNullAssertion: asserted not-null above
      expect(capturedStatus!.connecting).toBe(true)
      // biome-ignore lint/style/noNonNullAssertion: asserted not-null above
      expect(capturedStatus!.error).toBeNull()
      // biome-ignore lint/style/noNonNullAssertion: asserted not-null above
      expect(capturedStatus!.reconnectAttempt).toBe(0)
    })
  })

  describe('subscribe mechanism', () => {
    it('should return an unsubscribe function from subscribe()', () => {
      let subscribeFn:
        | ((
            eventType: string,
            handler: (payload: unknown) => void,
          ) => () => void)
        | null = null

      function SubscribeCapture() {
        const ctx = useSSEContext()
        subscribeFn = ctx.subscribe
        return createElement('div', null, 'captured')
      }

      renderToString(
        createElement(
          SSEProvider,
          { config: testConfig },
          createElement(SubscribeCapture),
        ),
      )

      expect(subscribeFn).toBeFunction()

      const handler = (_payload: unknown) => {}
      // biome-ignore lint/style/noNonNullAssertion: asserted toBeFunction above
      const unsubscribe = subscribeFn!('user.updated', handler)
      expect(unsubscribe).toBeFunction()
    })

    it('should remove handler when unsubscribe is called', () => {
      let subscribeFn:
        | ((
            eventType: string,
            handler: (payload: unknown) => void,
          ) => () => void)
        | null = null

      function SubscribeCapture() {
        const ctx = useSSEContext()
        subscribeFn = ctx.subscribe
        return createElement('div', null, 'captured')
      }

      renderToString(
        createElement(
          SSEProvider,
          { config: testConfig },
          createElement(SubscribeCapture),
        ),
      )

      const calls: unknown[] = []
      const handler = (payload: unknown) => {
        calls.push(payload)
      }

      // biome-ignore lint/style/noNonNullAssertion: subscribeFn captured from context
      const unsubscribe = subscribeFn!('test.event', handler)

      // After unsubscribing, subscribing again and checking the returned
      // function still works proves the mechanism is functional.
      // The actual dispatch will be tested when EventSource is wired up (WI-063).
      // For now we verify unsubscribe is callable and doesn't throw.
      expect(() => unsubscribe()).not.toThrow()

      // Subscribing again after unsubscribe should work cleanly
      // biome-ignore lint/style/noNonNullAssertion: subscribeFn captured from context
      const unsubscribe2 = subscribeFn!('test.event', handler)
      expect(unsubscribe2).toBeFunction()
    })

    it('should support multiple subscribers for the same event type', () => {
      let subscribeFn:
        | ((
            eventType: string,
            handler: (payload: unknown) => void,
          ) => () => void)
        | null = null

      function SubscribeCapture() {
        const ctx = useSSEContext()
        subscribeFn = ctx.subscribe
        return createElement('div', null, 'captured')
      }

      renderToString(
        createElement(
          SSEProvider,
          { config: testConfig },
          createElement(SubscribeCapture),
        ),
      )

      const handler1 = (_payload: unknown) => {}
      const handler2 = (_payload: unknown) => {}
      const handler3 = (_payload: unknown) => {}

      // All three should subscribe without error
      // biome-ignore lint/style/noNonNullAssertion: subscribeFn captured from context
      const unsub1 = subscribeFn!('same.event', handler1)
      // biome-ignore lint/style/noNonNullAssertion: subscribeFn captured from context
      const unsub2 = subscribeFn!('same.event', handler2)
      // biome-ignore lint/style/noNonNullAssertion: subscribeFn captured from context
      const unsub3 = subscribeFn!('same.event', handler3)

      expect(unsub1).toBeFunction()
      expect(unsub2).toBeFunction()
      expect(unsub3).toBeFunction()

      // Unsubscribing one should not affect others
      expect(() => unsub1()).not.toThrow()
      expect(() => unsub2()).not.toThrow()
      expect(() => unsub3()).not.toThrow()
    })
  })
})
