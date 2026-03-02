import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  mock,
  spyOn,
} from 'bun:test'
import { createElement } from 'react'
import { renderToString } from 'react-dom/server'
import type { ParsedEvent, SSEConfig } from '../types.ts'

/**
 * Tests for error handling and debug mode (WI-070).
 *
 * These tests verify:
 * 1. Event processing errors don't crash the provider
 *    - Bad JSON in event.data is handled gracefully
 *    - Filter function errors are caught
 *    - Transform function errors are caught
 *    - Update function errors are caught
 *
 * 2. config.onEventError callback
 *    - Called when event processing fails
 *    - Receives event and error details
 *
 * 3. Debug mode (config.debug: true)
 *    - Logs received events with type and payload
 *    - Logs unhandled event types
 *    - Logs cache mutations (key, strategy)
 *    - Uses console.debug
 *
 * 4. Provider continues after errors
 *    - Subsequent events are still processed
 *
 * Tests should FAIL until error handling and debug mode are implemented.
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

  // Test helper to simulate incoming named event with raw data
  simulateEventRaw(type: string, data: string) {
    const handlers = this.eventListeners.get(type)
    if (handlers) {
      for (const handler of handlers) {
        handler(new MessageEvent(type, { data }))
      }
    }
  }

  // Test helper to simulate incoming named event with JSON payload
  simulateEvent(type: string, payload: unknown) {
    this.simulateEventRaw(type, JSON.stringify(payload))
  }

  // Test helper to simulate a generic message event
  simulateMessage(data: string) {
    if (this.onmessage) {
      this.onmessage(new MessageEvent('message', { data }))
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

// Store console.debug spy and original
let debugSpy: ReturnType<typeof spyOn>
let warnSpy: ReturnType<typeof spyOn>
let errorSpy: ReturnType<typeof spyOn>
const originalEventSource = globalThis.EventSource

beforeEach(() => {
  // @ts-expect-error - Mocking EventSource
  globalThis.EventSource = MockEventSource
  MockEventSource.reset()
  mutateCalls.length = 0
  mockMutate.mockClear()

  // Spy on console methods
  debugSpy = spyOn(console, 'debug').mockImplementation(() => {})
  warnSpy = spyOn(console, 'warn').mockImplementation(() => {})
  errorSpy = spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  globalThis.EventSource = originalEventSource
  debugSpy.mockRestore()
  warnSpy.mockRestore()
  errorSpy.mockRestore()
})

// Import SSEProvider after mocking
const { SSEProvider } = await import('../SSEProvider.tsx')

describe('Error Handling and Debug Mode', () => {
  describe('bad JSON handling', () => {
    it('should not crash provider when event.data contains invalid JSON', () => {
      const config: SSEConfig = {
        url: 'http://localhost:3000/events',
        events: {
          'data.updated': {
            key: '/api/data',
            update: 'set',
          },
        },
      }

      // This should not throw
      expect(() => {
        renderToString(
          createElement(
            SSEProvider,
            { config },
            createElement('div', null, 'child'),
          ),
        )

        const source = MockEventSource.instances[0]
        // Send invalid JSON
        source.simulateEventRaw('data.updated', 'this is not valid json {{{')
      }).not.toThrow()

      // No mutate calls should have been made
      expect(mutateCalls.length).toBe(0)
    })

    it('should continue processing events after bad JSON event', () => {
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

      // Send invalid JSON first
      source.simulateEventRaw('data.updated', 'invalid json')

      // Then send valid event
      source.simulateEvent('data.updated', { value: 'valid' })

      // The valid event should have been processed
      expect(mutateCalls.length).toBe(1)
      expect(mutateCalls[0].data).toEqual({ value: 'valid' })
    })
  })

  describe('filter function errors', () => {
    it('should catch errors thrown by filter function', () => {
      const config: SSEConfig = {
        url: 'http://localhost:3000/events',
        events: {
          'data.updated': {
            key: '/api/data',
            update: 'set',
            filter: () => {
              throw new Error('Filter explosion!')
            },
          },
        },
      }

      expect(() => {
        renderToString(
          createElement(
            SSEProvider,
            { config },
            createElement('div', null, 'child'),
          ),
        )

        const source = MockEventSource.instances[0]
        source.simulateEvent('data.updated', { value: 'test' })
      }).not.toThrow()

      // Event should not be processed due to filter error
      expect(mutateCalls.length).toBe(0)
    })

    it('should continue processing after filter error', () => {
      let filterCallCount = 0
      const config: SSEConfig = {
        url: 'http://localhost:3000/events',
        events: {
          'data.updated': {
            key: '/api/data',
            update: 'set',
            filter: () => {
              filterCallCount++
              if (filterCallCount === 1) {
                throw new Error('First filter fails')
              }
              return true
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

      // First event - filter throws
      source.simulateEvent('data.updated', { value: 'first' })
      expect(mutateCalls.length).toBe(0)

      // Second event - filter passes
      source.simulateEvent('data.updated', { value: 'second' })
      expect(mutateCalls.length).toBe(1)
      expect(mutateCalls[0].data).toEqual({ value: 'second' })
    })
  })

  describe('transform function errors', () => {
    it('should catch errors thrown by transform function', () => {
      const config: SSEConfig = {
        url: 'http://localhost:3000/events',
        events: {
          'data.updated': {
            key: '/api/data',
            update: 'set',
            transform: () => {
              throw new Error('Transform explosion!')
            },
          },
        },
      }

      expect(() => {
        renderToString(
          createElement(
            SSEProvider,
            { config },
            createElement('div', null, 'child'),
          ),
        )

        const source = MockEventSource.instances[0]
        source.simulateEvent('data.updated', { value: 'test' })
      }).not.toThrow()

      // Event should not be processed due to transform error
      expect(mutateCalls.length).toBe(0)
    })

    it('should continue processing after transform error', () => {
      let transformCallCount = 0
      const config: SSEConfig = {
        url: 'http://localhost:3000/events',
        events: {
          'data.updated': {
            key: '/api/data',
            update: 'set',
            transform: (payload: { value: string }) => {
              transformCallCount++
              if (transformCallCount === 1) {
                throw new Error('First transform fails')
              }
              return { value: payload.value.toUpperCase() }
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

      // First event - transform throws
      source.simulateEvent('data.updated', { value: 'first' })
      expect(mutateCalls.length).toBe(0)

      // Second event - transform succeeds
      source.simulateEvent('data.updated', { value: 'second' })
      expect(mutateCalls.length).toBe(1)
      expect(mutateCalls[0].data).toEqual({ value: 'SECOND' })
    })
  })

  describe('update function errors', () => {
    it('should catch errors thrown by custom update function', () => {
      const config: SSEConfig = {
        url: 'http://localhost:3000/events',
        events: {
          'data.updated': {
            key: '/api/data',
            update: () => {
              throw new Error('Update explosion!')
            },
          },
        },
      }

      expect(() => {
        renderToString(
          createElement(
            SSEProvider,
            { config },
            createElement('div', null, 'child'),
          ),
        )

        const source = MockEventSource.instances[0]
        source.simulateEvent('data.updated', { value: 'test' })
      }).not.toThrow()
    })

    it('should continue processing after update function error', () => {
      let updateCallCount = 0
      const config: SSEConfig = {
        url: 'http://localhost:3000/events',
        events: {
          'data.updated': {
            key: '/api/data',
            update: (_current: unknown, payload: { value: string }) => {
              updateCallCount++
              if (updateCallCount === 1) {
                throw new Error('First update fails')
              }
              return { merged: payload.value }
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

      // First event - update throws (mutate may or may not be called depending on impl)
      source.simulateEvent('data.updated', { value: 'first' })

      // Second event - update succeeds
      source.simulateEvent('data.updated', { value: 'second' })

      // At least the second event should succeed
      const successfulCalls = mutateCalls.filter(
        (c) => c.data && (c.data as { merged?: string }).merged === 'second',
      )
      expect(successfulCalls.length).toBeGreaterThanOrEqual(1)
    })
  })

  describe('onEventError callback', () => {
    it('should call onEventError when filter throws', () => {
      const onEventErrorCalls: Array<{ event: ParsedEvent; error: unknown }> =
        []

      const config: SSEConfig = {
        url: 'http://localhost:3000/events',
        events: {
          'data.updated': {
            key: '/api/data',
            update: 'set',
            filter: () => {
              throw new Error('Filter error')
            },
          },
        },
        onEventError: (event, error) => {
          onEventErrorCalls.push({ event, error })
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
      source.simulateEvent('data.updated', { value: 'test' })

      expect(onEventErrorCalls.length).toBe(1)
      expect(onEventErrorCalls[0].event.type).toBe('data.updated')
      expect(onEventErrorCalls[0].event.payload).toEqual({ value: 'test' })
      expect(onEventErrorCalls[0].error).toBeInstanceOf(Error)
      expect((onEventErrorCalls[0].error as Error).message).toBe('Filter error')
    })

    it('should call onEventError when transform throws', () => {
      const onEventErrorCalls: Array<{ event: ParsedEvent; error: unknown }> =
        []

      const config: SSEConfig = {
        url: 'http://localhost:3000/events',
        events: {
          'data.updated': {
            key: '/api/data',
            update: 'set',
            transform: () => {
              throw new Error('Transform error')
            },
          },
        },
        onEventError: (event, error) => {
          onEventErrorCalls.push({ event, error })
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
      source.simulateEvent('data.updated', { payload: 'data' })

      expect(onEventErrorCalls.length).toBe(1)
      expect(onEventErrorCalls[0].event.type).toBe('data.updated')
      expect((onEventErrorCalls[0].error as Error).message).toBe(
        'Transform error',
      )
    })

    it('should call onEventError when custom update function throws', () => {
      const onEventErrorCalls: Array<{ event: ParsedEvent; error: unknown }> =
        []

      const config: SSEConfig = {
        url: 'http://localhost:3000/events',
        events: {
          'data.updated': {
            key: '/api/data',
            update: () => {
              throw new Error('Update error')
            },
          },
        },
        onEventError: (event, error) => {
          onEventErrorCalls.push({ event, error })
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
      source.simulateEvent('data.updated', { id: 123 })

      expect(onEventErrorCalls.length).toBe(1)
      expect(onEventErrorCalls[0].event.type).toBe('data.updated')
      expect((onEventErrorCalls[0].error as Error).message).toBe('Update error')
    })

    it('should not fail when onEventError is not provided', () => {
      const config: SSEConfig = {
        url: 'http://localhost:3000/events',
        events: {
          'data.updated': {
            key: '/api/data',
            update: 'set',
            filter: () => {
              throw new Error('Error without callback')
            },
          },
        },
        // No onEventError provided
      }

      expect(() => {
        renderToString(
          createElement(
            SSEProvider,
            { config },
            createElement('div', null, 'child'),
          ),
        )

        const source = MockEventSource.instances[0]
        source.simulateEvent('data.updated', { value: 'test' })
      }).not.toThrow()
    })
  })

  describe('debug mode - event logging', () => {
    it('should log received events with type and payload when debug is true', () => {
      const config: SSEConfig = {
        url: 'http://localhost:3000/events',
        debug: true,
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

      expect(debugSpy).toHaveBeenCalled()

      // Find the call that logs the received event
      const calls = debugSpy.mock.calls
      const eventLogCall = calls.find(
        (call) =>
          typeof call[0] === 'string' &&
          call[0].includes('[reactiveSWR]') &&
          call[0].includes('Event received'),
      )

      expect(eventLogCall).toBeDefined()
    })

    it('should not log events when debug is false', () => {
      const config: SSEConfig = {
        url: 'http://localhost:3000/events',
        debug: false,
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

      // No debug logs should have been made
      const debugCalls = debugSpy.mock.calls.filter(
        (call) =>
          typeof call[0] === 'string' && call[0].includes('[reactiveSWR]'),
      )
      expect(debugCalls.length).toBe(0)
    })

    it('should not log events when debug is not set', () => {
      const config: SSEConfig = {
        url: 'http://localhost:3000/events',
        // debug not set (undefined)
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

      // No debug logs should have been made
      const debugCalls = debugSpy.mock.calls.filter(
        (call) =>
          typeof call[0] === 'string' && call[0].includes('[reactiveSWR]'),
      )
      expect(debugCalls.length).toBe(0)
    })
  })

  describe('debug mode - unhandled events', () => {
    it('should log unhandled event types when debug is true', () => {
      const config: SSEConfig = {
        url: 'http://localhost:3000/events',
        debug: true,
        events: {
          'known.event': {
            key: '/api/known',
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

      // Simulate a generic message event with an unknown type
      source.simulateMessage(
        JSON.stringify({ type: 'unknown.event', payload: { data: 'test' } }),
      )

      const calls = debugSpy.mock.calls
      const unhandledLogCall = calls.find(
        (call) =>
          typeof call[0] === 'string' &&
          call[0].includes('[reactiveSWR]') &&
          call[0].includes('Unhandled event type'),
      )

      expect(unhandledLogCall).toBeDefined()
    })
  })

  describe('debug mode - cache mutations', () => {
    it('should log cache mutations with key and strategy when debug is true', () => {
      const config: SSEConfig = {
        url: 'http://localhost:3000/events',
        debug: true,
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

      const calls = debugSpy.mock.calls
      const mutationLogCall = calls.find(
        (call) =>
          typeof call[0] === 'string' &&
          call[0].includes('[reactiveSWR]') &&
          call[0].includes('Cache mutation'),
      )

      expect(mutationLogCall).toBeDefined()
    })

    it('should log cache mutation for refetch strategy', () => {
      const config: SSEConfig = {
        url: 'http://localhost:3000/events',
        debug: true,
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
      source.simulateEvent('cache.invalidate', {})

      const calls = debugSpy.mock.calls
      const mutationLogCall = calls.find(
        (call) =>
          typeof call[0] === 'string' &&
          call[0].includes('[reactiveSWR]') &&
          call[0].includes('Cache mutation') &&
          call[0].includes('refetch'),
      )

      expect(mutationLogCall).toBeDefined()
    })

    it('should log cache mutation for custom function strategy', () => {
      const config: SSEConfig = {
        url: 'http://localhost:3000/events',
        debug: true,
        events: {
          'counter.increment': {
            key: '/api/counter',
            update: (
              current: number | undefined,
              payload: { amount: number },
            ) => (current ?? 0) + payload.amount,
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

      const calls = debugSpy.mock.calls
      // For custom functions, strategy might be logged as "function" or "custom"
      const mutationLogCall = calls.find(
        (call) =>
          typeof call[0] === 'string' &&
          call[0].includes('[reactiveSWR]') &&
          call[0].includes('Cache mutation'),
      )

      expect(mutationLogCall).toBeDefined()
    })
  })

  describe('provider resilience', () => {
    it('should process multiple events with intermittent errors', () => {
      let callCount = 0

      const config: SSEConfig = {
        url: 'http://localhost:3000/events',
        events: {
          'data.updated': {
            key: '/api/data',
            update: 'set',
            filter: () => {
              callCount++
              // Every other event throws
              if (callCount % 2 === 0) {
                throw new Error('Intermittent failure')
              }
              return true
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

      // Send 5 events - events 1, 3, 5 should succeed
      source.simulateEvent('data.updated', { n: 1 })
      source.simulateEvent('data.updated', { n: 2 }) // fails
      source.simulateEvent('data.updated', { n: 3 })
      source.simulateEvent('data.updated', { n: 4 }) // fails
      source.simulateEvent('data.updated', { n: 5 })

      // 3 events should have been processed successfully
      expect(mutateCalls.length).toBe(3)
      expect(mutateCalls[0].data).toEqual({ n: 1 })
      expect(mutateCalls[1].data).toEqual({ n: 3 })
      expect(mutateCalls[2].data).toEqual({ n: 5 })
    })

    it('should handle errors in one event type while processing others', () => {
      const config: SSEConfig = {
        url: 'http://localhost:3000/events',
        events: {
          'broken.event': {
            key: '/api/broken',
            update: 'set',
            transform: () => {
              throw new Error('Always broken')
            },
          },
          'working.event': {
            key: '/api/working',
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

      // Broken event fails
      source.simulateEvent('broken.event', { data: 'will fail' })

      // Working event should still work
      source.simulateEvent('working.event', { data: 'will succeed' })

      expect(mutateCalls.length).toBe(1)
      expect(mutateCalls[0].key).toBe('/api/working')
      expect(mutateCalls[0].data).toEqual({ data: 'will succeed' })
    })
  })

  describe('parseEvent non-Error throws', () => {
    it('should wrap a thrown string in a proper Error for onmessage path', () => {
      const onEventErrorCalls: Array<{ event: ParsedEvent; error: unknown }> =
        []

      const config: SSEConfig = {
        url: 'http://localhost:3000/events',
        events: {},
        parseEvent: () => {
          throw 'string error'
        },
        onEventError: (event, error) => {
          onEventErrorCalls.push({ event, error })
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
      // Trigger the onmessage path with a generic message
      source.simulateMessage('{}')

      expect(onEventErrorCalls.length).toBe(1)
      expect(onEventErrorCalls[0].error).toBeInstanceOf(Error)
      expect((onEventErrorCalls[0].error as Error).message).toContain(
        'string error',
      )
    })

    it('should wrap a thrown object in a proper Error for onmessage path', () => {
      const onEventErrorCalls: Array<{ event: ParsedEvent; error: unknown }> =
        []

      const config: SSEConfig = {
        url: 'http://localhost:3000/events',
        events: {},
        parseEvent: () => {
          throw { code: 'FAIL', reason: 'bad parse' }
        },
        onEventError: (event, error) => {
          onEventErrorCalls.push({ event, error })
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
      source.simulateMessage('{}')

      expect(onEventErrorCalls.length).toBe(1)
      expect(onEventErrorCalls[0].error).toBeInstanceOf(Error)
    })

    it('should wrap thrown null in a proper Error for onmessage path', () => {
      const onEventErrorCalls: Array<{ event: ParsedEvent; error: unknown }> =
        []

      const config: SSEConfig = {
        url: 'http://localhost:3000/events',
        events: {},
        parseEvent: () => {
          throw null
        },
        onEventError: (event, error) => {
          onEventErrorCalls.push({ event, error })
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
      source.simulateMessage('{}')

      expect(onEventErrorCalls.length).toBe(1)
      expect(onEventErrorCalls[0].error).toBeInstanceOf(Error)
    })

    it('should wrap thrown undefined in a proper Error for onmessage path', () => {
      const onEventErrorCalls: Array<{ event: ParsedEvent; error: unknown }> =
        []

      const config: SSEConfig = {
        url: 'http://localhost:3000/events',
        events: {},
        parseEvent: () => {
          throw undefined
        },
        onEventError: (event, error) => {
          onEventErrorCalls.push({ event, error })
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
      source.simulateMessage('{}')

      expect(onEventErrorCalls.length).toBe(1)
      expect(onEventErrorCalls[0].error).toBeInstanceOf(Error)
    })

    it('should pass an Error through unchanged for onmessage path', () => {
      const onEventErrorCalls: Array<{ event: ParsedEvent; error: unknown }> =
        []
      const originalError = new Error('original parse failure')

      const config: SSEConfig = {
        url: 'http://localhost:3000/events',
        events: {},
        parseEvent: () => {
          throw originalError
        },
        onEventError: (event, error) => {
          onEventErrorCalls.push({ event, error })
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
      source.simulateMessage('{}')

      expect(onEventErrorCalls.length).toBe(1)
      expect(onEventErrorCalls[0].error).toBeInstanceOf(Error)
      expect((onEventErrorCalls[0].error as Error).message).toBe(
        'original parse failure',
      )
      // Original error is preserved as cause in the SSEProviderError wrapper
      expect((onEventErrorCalls[0].error as Error).cause).toBe(originalError)
    })

    it('should wrap a thrown string in a proper Error for named-event path', () => {
      const onEventErrorCalls: Array<{ event: ParsedEvent; error: unknown }> =
        []

      const config: SSEConfig = {
        url: 'http://localhost:3000/events',
        events: {
          'data.updated': {
            key: '/api/data',
            update: 'set',
          },
        },
        parseEvent: () => {
          throw 'string error in named event'
        },
        onEventError: (event, error) => {
          onEventErrorCalls.push({ event, error })
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
      // Trigger the named-event listener path
      source.simulateEventRaw('data.updated', '{}')

      expect(onEventErrorCalls.length).toBe(1)
      expect(onEventErrorCalls[0].error).toBeInstanceOf(Error)
      expect((onEventErrorCalls[0].error as Error).message).toContain(
        'string error in named event',
      )
    })

    it('should wrap a thrown object in a proper Error for named-event path', () => {
      const onEventErrorCalls: Array<{ event: ParsedEvent; error: unknown }> =
        []

      const config: SSEConfig = {
        url: 'http://localhost:3000/events',
        events: {
          'data.updated': {
            key: '/api/data',
            update: 'set',
          },
        },
        parseEvent: () => {
          throw { code: 'FAIL' }
        },
        onEventError: (event, error) => {
          onEventErrorCalls.push({ event, error })
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
      source.simulateEventRaw('data.updated', '{}')

      expect(onEventErrorCalls.length).toBe(1)
      expect(onEventErrorCalls[0].error).toBeInstanceOf(Error)
    })

    it('should wrap thrown null in a proper Error for named-event path', () => {
      const onEventErrorCalls: Array<{ event: ParsedEvent; error: unknown }> =
        []

      const config: SSEConfig = {
        url: 'http://localhost:3000/events',
        events: {
          'data.updated': {
            key: '/api/data',
            update: 'set',
          },
        },
        parseEvent: () => {
          throw null
        },
        onEventError: (event, error) => {
          onEventErrorCalls.push({ event, error })
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
      source.simulateEventRaw('data.updated', '{}')

      expect(onEventErrorCalls.length).toBe(1)
      expect(onEventErrorCalls[0].error).toBeInstanceOf(Error)
    })

    it('should wrap thrown undefined in a proper Error for named-event path', () => {
      const onEventErrorCalls: Array<{ event: ParsedEvent; error: unknown }> =
        []

      const config: SSEConfig = {
        url: 'http://localhost:3000/events',
        events: {
          'data.updated': {
            key: '/api/data',
            update: 'set',
          },
        },
        parseEvent: () => {
          throw undefined
        },
        onEventError: (event, error) => {
          onEventErrorCalls.push({ event, error })
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
      source.simulateEventRaw('data.updated', '{}')

      expect(onEventErrorCalls.length).toBe(1)
      expect(onEventErrorCalls[0].error).toBeInstanceOf(Error)
    })
  })
})
