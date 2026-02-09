import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { createElement } from 'react'
import { renderToString } from 'react-dom/server'
import type { SSEConfig } from '../types.ts'

/**
 * Tests for update strategies (WI-064).
 *
 * These tests verify:
 * 1. 'set' strategy - replaces cache without network request
 * 2. 'refetch' strategy - triggers SWR revalidation
 * 3. Custom function strategy - receives current value and payload
 * 4. Filter support - skips events when filter returns false
 * 5. Transform support - modifies payload before update
 * 6. Array keys - applies update to all keys
 * 7. Dynamic keys - function resolves to key(s)
 * 8. Default strategy is 'set' when not specified
 *
 * Tests should FAIL until update strategy logic is implemented in SSEProvider.
 */

// Track all mutate calls for verification
interface MutateCall {
  key: string
  data: unknown
  options: { revalidate: boolean }
}

const mutateCalls: MutateCall[] = []

// Mock mutate function that records calls
const mockMutate = mock(
  (key: string, data: unknown, options?: { revalidate?: boolean }) => {
    // If data is a function, call it with undefined to simulate current cache
    const resolvedData = typeof data === 'function' ? data(undefined) : data
    mutateCalls.push({
      key,
      data: resolvedData,
      options: { revalidate: options?.revalidate ?? true },
    })
    return Promise.resolve(resolvedData)
  },
)

// Mock useSWRConfig to return our mock mutate
mock.module('swr', () => ({
  useSWRConfig: () => ({
    mutate: mockMutate,
  }),
}))

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
  mutateCalls.length = 0
  mockMutate.mockClear()
})

afterEach(() => {
  globalThis.EventSource = originalEventSource
})

// Import SSEProvider after mocking (will use mocked SWR)
const { SSEProvider } = await import('../SSEProvider.tsx')

describe('Update Strategies', () => {
  describe('set strategy (default)', () => {
    it('should replace cache with payload when update is "set"', () => {
      const config: SSEConfig = {
        url: 'http://localhost:3000/events',
        events: {
          'user.updated': {
            key: '/api/user',
            update: 'set',
          },
        },
      }

      renderToString(
        createElement(
          SSEProvider,
          { config },
          createElement('div', null, 'child'),
        ),
      )

      const source = MockEventSource.instances[0]
      source.simulateEvent('user.updated', { id: 1, name: 'Alice' })

      expect(mutateCalls.length).toBe(1)
      expect(mutateCalls[0].key).toBe('/api/user')
      expect(mutateCalls[0].data).toEqual({ id: 1, name: 'Alice' })
      expect(mutateCalls[0].options.revalidate).toBe(false)
    })

    it('should default to "set" strategy when update is not specified', () => {
      const config: SSEConfig = {
        url: 'http://localhost:3000/events',
        events: {
          'user.updated': {
            key: '/api/user',
            // No update specified - should default to 'set'
          },
        },
      }

      renderToString(
        createElement(
          SSEProvider,
          { config },
          createElement('div', null, 'child'),
        ),
      )

      const source = MockEventSource.instances[0]
      source.simulateEvent('user.updated', { id: 2, name: 'Bob' })

      expect(mutateCalls.length).toBe(1)
      expect(mutateCalls[0].key).toBe('/api/user')
      expect(mutateCalls[0].data).toEqual({ id: 2, name: 'Bob' })
      expect(mutateCalls[0].options.revalidate).toBe(false)
    })

    it('should not trigger network request with "set" strategy', () => {
      const config: SSEConfig = {
        url: 'http://localhost:3000/events',
        events: {
          'data.updated': {
            key: '/api/data',
            update: 'set',
          },
        },
      }

      renderToString(
        createElement(
          SSEProvider,
          { config },
          createElement('div', null, 'child'),
        ),
      )

      const source = MockEventSource.instances[0]
      source.simulateEvent('data.updated', { value: 42 })

      // revalidate: false means no network request
      expect(mutateCalls[0].options.revalidate).toBe(false)
    })
  })

  describe('refetch strategy', () => {
    it('should trigger SWR revalidation when update is "refetch"', () => {
      const config: SSEConfig = {
        url: 'http://localhost:3000/events',
        events: {
          'cache.invalidate': {
            key: '/api/data',
            update: 'refetch',
          },
        },
      }

      renderToString(
        createElement(
          SSEProvider,
          { config },
          createElement('div', null, 'child'),
        ),
      )

      const source = MockEventSource.instances[0]
      source.simulateEvent('cache.invalidate', { ignored: 'payload' })

      expect(mutateCalls.length).toBe(1)
      expect(mutateCalls[0].key).toBe('/api/data')
      expect(mutateCalls[0].options.revalidate).toBe(true)
    })

    it('should ignore event payload with "refetch" strategy', () => {
      const config: SSEConfig = {
        url: 'http://localhost:3000/events',
        events: {
          'cache.invalidate': {
            key: '/api/data',
            update: 'refetch',
          },
        },
      }

      renderToString(
        createElement(
          SSEProvider,
          { config },
          createElement('div', null, 'child'),
        ),
      )

      const source = MockEventSource.instances[0]
      source.simulateEvent('cache.invalidate', {
        some: 'data',
        that: 'is ignored',
      })

      // With refetch, data should be undefined (not the payload)
      expect(mutateCalls[0].data).toBeUndefined()
    })
  })

  describe('custom function strategy', () => {
    it('should call custom function with current value and payload', () => {
      const customUpdateCalls: Array<{ current: unknown; payload: unknown }> =
        []

      const config: SSEConfig = {
        url: 'http://localhost:3000/events',
        events: {
          'item.added': {
            key: '/api/items',
            update: (current: unknown, payload: unknown) => {
              customUpdateCalls.push({ current, payload })
              const items = Array.isArray(current) ? current : []
              return [...items, payload]
            },
          },
        },
      }

      renderToString(
        createElement(
          SSEProvider,
          { config },
          createElement('div', null, 'child'),
        ),
      )

      const source = MockEventSource.instances[0]
      source.simulateEvent('item.added', { id: 1, name: 'New Item' })

      expect(customUpdateCalls.length).toBe(1)
      expect(customUpdateCalls[0].payload).toEqual({ id: 1, name: 'New Item' })
    })

    it('should use custom function return value as new cache value', () => {
      const config: SSEConfig = {
        url: 'http://localhost:3000/events',
        events: {
          'counter.increment': {
            key: '/api/counter',
            update: (
              current: number | undefined,
              payload: { amount: number },
            ) => {
              return (current ?? 0) + payload.amount
            },
          },
        },
      }

      renderToString(
        createElement(
          SSEProvider,
          { config },
          createElement('div', null, 'child'),
        ),
      )

      const source = MockEventSource.instances[0]
      source.simulateEvent('counter.increment', { amount: 5 })

      // Since current is undefined (no cache), result should be 0 + 5 = 5
      expect(mutateCalls[0].data).toBe(5)
      expect(mutateCalls[0].options.revalidate).toBe(false)
    })

    it('should not trigger network request with custom function strategy', () => {
      const config: SSEConfig = {
        url: 'http://localhost:3000/events',
        events: {
          'data.merge': {
            key: '/api/data',
            update: (current: object | undefined, payload: object) => ({
              ...current,
              ...payload,
            }),
          },
        },
      }

      renderToString(
        createElement(
          SSEProvider,
          { config },
          createElement('div', null, 'child'),
        ),
      )

      const source = MockEventSource.instances[0]
      source.simulateEvent('data.merge', { newField: 'value' })

      expect(mutateCalls[0].options.revalidate).toBe(false)
    })
  })

  describe('filter support', () => {
    it('should skip event when filter returns false', () => {
      const config: SSEConfig = {
        url: 'http://localhost:3000/events',
        events: {
          'user.updated': {
            key: '/api/user',
            update: 'set',
            filter: (payload: { id: number }) => payload.id > 100,
          },
        },
      }

      renderToString(
        createElement(
          SSEProvider,
          { config },
          createElement('div', null, 'child'),
        ),
      )

      const source = MockEventSource.instances[0]

      // This should be filtered out (id <= 100)
      source.simulateEvent('user.updated', { id: 50, name: 'Filtered' })

      expect(mutateCalls.length).toBe(0)
    })

    it('should process event when filter returns true', () => {
      const config: SSEConfig = {
        url: 'http://localhost:3000/events',
        events: {
          'user.updated': {
            key: '/api/user',
            update: 'set',
            filter: (payload: { id: number }) => payload.id > 100,
          },
        },
      }

      renderToString(
        createElement(
          SSEProvider,
          { config },
          createElement('div', null, 'child'),
        ),
      )

      const source = MockEventSource.instances[0]

      // This should pass the filter (id > 100)
      source.simulateEvent('user.updated', { id: 200, name: 'Allowed' })

      expect(mutateCalls.length).toBe(1)
      expect(mutateCalls[0].data).toEqual({ id: 200, name: 'Allowed' })
    })

    it('should run filter on raw payload before transform', () => {
      const filterCalls: unknown[] = []
      const transformCalls: unknown[] = []

      const config: SSEConfig = {
        url: 'http://localhost:3000/events',
        events: {
          'data.updated': {
            key: '/api/data',
            update: 'set',
            filter: (payload: { value: number }) => {
              filterCalls.push(payload)
              return payload.value > 10
            },
            transform: (payload: { value: number }) => {
              transformCalls.push(payload)
              return { value: payload.value * 2 }
            },
          },
        },
      }

      renderToString(
        createElement(
          SSEProvider,
          { config },
          createElement('div', null, 'child'),
        ),
      )

      const source = MockEventSource.instances[0]

      // Send event that passes filter
      source.simulateEvent('data.updated', { value: 20 })

      // Filter should see raw payload
      expect(filterCalls[0]).toEqual({ value: 20 })
      // Transform should also see raw payload (called after filter passes)
      expect(transformCalls[0]).toEqual({ value: 20 })
      // Final cached value should be transformed
      expect(mutateCalls[0].data).toEqual({ value: 40 })
    })
  })

  describe('transform support', () => {
    it('should apply transform to payload for "set" strategy', () => {
      const config: SSEConfig = {
        url: 'http://localhost:3000/events',
        events: {
          'user.updated': {
            key: '/api/user',
            update: 'set',
            transform: (payload: { name: string }) => ({
              ...payload,
              name: payload.name.toUpperCase(),
            }),
          },
        },
      }

      renderToString(
        createElement(
          SSEProvider,
          { config },
          createElement('div', null, 'child'),
        ),
      )

      const source = MockEventSource.instances[0]
      source.simulateEvent('user.updated', { name: 'alice' })

      expect(mutateCalls[0].data).toEqual({ name: 'ALICE' })
    })

    it('should pass transformed payload to custom update function', () => {
      const receivedPayloads: unknown[] = []

      const config: SSEConfig = {
        url: 'http://localhost:3000/events',
        events: {
          'item.added': {
            key: '/api/items',
            update: (
              current: unknown[],
              payload: { id: number; name: string },
            ) => {
              receivedPayloads.push(payload)
              return [...(current || []), payload]
            },
            transform: (payload: { id: number; name: string }) => ({
              ...payload,
              name: `Transformed: ${payload.name}`,
            }),
          },
        },
      }

      renderToString(
        createElement(
          SSEProvider,
          { config },
          createElement('div', null, 'child'),
        ),
      )

      const source = MockEventSource.instances[0]
      source.simulateEvent('item.added', { id: 1, name: 'Original' })

      // Custom function should receive transformed payload
      expect(receivedPayloads[0]).toEqual({
        id: 1,
        name: 'Transformed: Original',
      })
    })

    it('should ignore transform for "refetch" strategy', () => {
      const config: SSEConfig = {
        url: 'http://localhost:3000/events',
        events: {
          'cache.invalidate': {
            key: '/api/data',
            update: 'refetch',
            transform: () => {
              // Transform may or may not be called for refetch, but payload is ignored
              return { should: 'not matter' }
            },
          },
        },
      }

      renderToString(
        createElement(
          SSEProvider,
          { config },
          createElement('div', null, 'child'),
        ),
      )

      const source = MockEventSource.instances[0]
      source.simulateEvent('cache.invalidate', { some: 'payload' })

      // Transform may or may not be called, but payload is ignored for refetch
      // The key point is that the cached data is undefined (triggering revalidation)
      expect(mutateCalls[0].data).toBeUndefined()
      expect(mutateCalls[0].options.revalidate).toBe(true)
    })
  })

  describe('array keys', () => {
    it('should apply update to all keys when key is an array', () => {
      const config: SSEConfig = {
        url: 'http://localhost:3000/events',
        events: {
          'global.update': {
            key: ['/api/users', '/api/teams', '/api/projects'],
            update: 'set',
          },
        },
      }

      renderToString(
        createElement(
          SSEProvider,
          { config },
          createElement('div', null, 'child'),
        ),
      )

      const source = MockEventSource.instances[0]
      source.simulateEvent('global.update', { timestamp: 12345 })

      expect(mutateCalls.length).toBe(3)
      expect(mutateCalls.map((c) => c.key)).toEqual([
        '/api/users',
        '/api/teams',
        '/api/projects',
      ])
      // All keys receive the same payload
      for (const call of mutateCalls) {
        expect(call.data).toEqual({ timestamp: 12345 })
      }
    })

    it('should apply refetch to all keys in array', () => {
      const config: SSEConfig = {
        url: 'http://localhost:3000/events',
        events: {
          'cache.clear': {
            key: ['/api/a', '/api/b'],
            update: 'refetch',
          },
        },
      }

      renderToString(
        createElement(
          SSEProvider,
          { config },
          createElement('div', null, 'child'),
        ),
      )

      const source = MockEventSource.instances[0]
      source.simulateEvent('cache.clear', {})

      expect(mutateCalls.length).toBe(2)
      for (const call of mutateCalls) {
        expect(call.options.revalidate).toBe(true)
      }
    })

    it('should apply custom function to all keys in array', () => {
      const config: SSEConfig = {
        url: 'http://localhost:3000/events',
        events: {
          'timestamp.update': {
            key: ['/api/x', '/api/y'],
            update: (
              current: { ts: number } | undefined,
              payload: { ts: number },
            ) => ({
              ...current,
              ts: payload.ts,
            }),
          },
        },
      }

      renderToString(
        createElement(
          SSEProvider,
          { config },
          createElement('div', null, 'child'),
        ),
      )

      const source = MockEventSource.instances[0]
      source.simulateEvent('timestamp.update', { ts: 999 })

      expect(mutateCalls.length).toBe(2)
      for (const call of mutateCalls) {
        expect(call.data).toEqual({ ts: 999 })
      }
    })
  })

  describe('dynamic keys', () => {
    it('should resolve key from function with payload', () => {
      const config: SSEConfig = {
        url: 'http://localhost:3000/events',
        events: {
          'user.updated': {
            key: (payload: { userId: number }) =>
              `/api/users/${payload.userId}`,
            update: 'set',
          },
        },
      }

      renderToString(
        createElement(
          SSEProvider,
          { config },
          createElement('div', null, 'child'),
        ),
      )

      const source = MockEventSource.instances[0]
      source.simulateEvent('user.updated', { userId: 42, name: 'Dynamic User' })

      expect(mutateCalls.length).toBe(1)
      expect(mutateCalls[0].key).toBe('/api/users/42')
      expect(mutateCalls[0].data).toEqual({ userId: 42, name: 'Dynamic User' })
    })

    it('should support dynamic key function returning array', () => {
      const config: SSEConfig = {
        url: 'http://localhost:3000/events',
        events: {
          'team.member.added': {
            key: (payload: { teamId: number; userId: number }) => [
              `/api/teams/${payload.teamId}`,
              `/api/users/${payload.userId}`,
            ],
            update: 'refetch',
          },
        },
      }

      renderToString(
        createElement(
          SSEProvider,
          { config },
          createElement('div', null, 'child'),
        ),
      )

      const source = MockEventSource.instances[0]
      source.simulateEvent('team.member.added', { teamId: 10, userId: 20 })

      expect(mutateCalls.length).toBe(2)
      expect(mutateCalls.map((c) => c.key)).toEqual([
        '/api/teams/10',
        '/api/users/20',
      ])
    })

    it('should apply transform before passing payload to key function', () => {
      const keyFunctionCalls: unknown[] = []

      const config: SSEConfig = {
        url: 'http://localhost:3000/events',
        events: {
          'item.updated': {
            key: (payload: { itemId: string }) => {
              keyFunctionCalls.push(payload)
              return `/api/items/${payload.itemId}`
            },
            update: 'set',
            transform: (payload: { id: number }) => ({
              itemId: `item-${payload.id}`,
            }),
          },
        },
      }

      renderToString(
        createElement(
          SSEProvider,
          { config },
          createElement('div', null, 'child'),
        ),
      )

      const source = MockEventSource.instances[0]
      source.simulateEvent('item.updated', { id: 123 })

      // Key function should receive transformed payload
      expect(keyFunctionCalls[0]).toEqual({ itemId: 'item-123' })
      expect(mutateCalls[0].key).toBe('/api/items/item-123')
    })
  })

  describe('combined scenarios', () => {
    it('should handle filter + transform + custom function together', () => {
      const processedPayloads: unknown[] = []

      const config: SSEConfig = {
        url: 'http://localhost:3000/events',
        events: {
          'score.updated': {
            key: '/api/scores',
            filter: (payload: { score: number }) => payload.score >= 0,
            transform: (payload: { score: number }) => ({
              score: Math.round(payload.score),
            }),
            update: (
              current: number[] | undefined,
              payload: { score: number },
            ) => {
              processedPayloads.push(payload)
              return [...(current || []), payload.score]
            },
          },
        },
      }

      renderToString(
        createElement(
          SSEProvider,
          { config },
          createElement('div', null, 'child'),
        ),
      )

      const source = MockEventSource.instances[0]

      // This should be filtered out (negative score)
      source.simulateEvent('score.updated', { score: -5 })
      expect(mutateCalls.length).toBe(0)

      // This should pass filter, be transformed, and processed
      source.simulateEvent('score.updated', { score: 7.8 })
      expect(mutateCalls.length).toBe(1)
      expect(processedPayloads[0]).toEqual({ score: 8 }) // Transformed (rounded)
    })

    it('should handle filter + dynamic array keys + refetch', () => {
      const config: SSEConfig = {
        url: 'http://localhost:3000/events',
        events: {
          'data.invalidate': {
            key: (payload: { scopes: string[] }) =>
              payload.scopes.map((s) => `/api/${s}`),
            filter: (payload: { scopes: string[] }) =>
              payload.scopes.length > 0,
            update: 'refetch',
          },
        },
      }

      renderToString(
        createElement(
          SSEProvider,
          { config },
          createElement('div', null, 'child'),
        ),
      )

      const source = MockEventSource.instances[0]

      // Empty scopes should be filtered
      source.simulateEvent('data.invalidate', { scopes: [] })
      expect(mutateCalls.length).toBe(0)

      // Non-empty scopes should trigger refetch for each
      source.simulateEvent('data.invalidate', { scopes: ['users', 'teams'] })
      expect(mutateCalls.length).toBe(2)
      expect(mutateCalls.map((c) => c.key)).toEqual([
        '/api/users',
        '/api/teams',
      ])
    })
  })
})
