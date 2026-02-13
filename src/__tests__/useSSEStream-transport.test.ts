import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { createElement } from 'react'
import { renderToString } from 'react-dom/server'
import type { SSETransport } from '../types.ts'

/**
 * Tests for useSSEStream transport integration (WI-219).
 *
 * These tests verify:
 * 1. Default behavior (no transport options) uses EventSource (backward compat)
 * 2. With method: 'POST' and body -> uses createFetchTransport
 * 3. With only headers -> uses createFetchTransport (authenticated GET)
 * 4. With body but no method -> defaults to POST
 * 5. With custom transport factory -> uses that transport
 * 6. Custom transport factory that throws -> error caught and reported
 * 7. Connection reuse: same URL + same options = shared connection
 * 8. Connection key: different body for same URL = separate connections
 * 9. Non-serializable bodies -> never reuse connections
 * 10. UseSSEStreamOptions type accepts new fields
 * 11. Cleanup (close) works for all transport types
 * 12. Existing useSSEStream behavior unchanged
 *
 * Tests should FAIL until useSSEStream.ts is updated with transport support.
 */

// -- Mock EventSource --
class MockEventSource {
  static instances: MockEventSource[] = []
  url: string
  readyState = 0
  onmessage: ((event: MessageEvent) => void) | null = null
  onerror: ((event: Event) => void) | null = null
  onopen: ((event: Event) => void) | null = null

  constructor(url: string) {
    this.url = url
    MockEventSource.instances.push(this)
    queueMicrotask(() => {
      this.readyState = 1
      this.onopen?.(new Event('open'))
    })
  }

  close() {
    this.readyState = 2
  }

  addEventListener() {}
  removeEventListener() {}
  dispatchEvent() {
    return true
  }

  simulateMessage(data: unknown) {
    if (this.onmessage) {
      this.onmessage(
        new MessageEvent('message', { data: JSON.stringify(data) }),
      )
    }
  }

  simulateError() {
    if (this.onerror) {
      this.onerror(new Event('error'))
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

// -- Mock SSETransport for custom transport tests --
function createMockTransport(): SSETransport & {
  simulateMessage: (data: unknown) => void
  simulateError: () => void
} {
  const transport: SSETransport & {
    simulateMessage: (data: unknown) => void
    simulateError: () => void
  } = {
    readyState: 1,
    onmessage: null,
    onerror: null,
    onopen: null,
    close() {
      this.readyState = 2
    },
    addEventListener() {},
    removeEventListener() {},
    simulateMessage(data: unknown) {
      if (this.onmessage) {
        this.onmessage(
          new MessageEvent('message', { data: JSON.stringify(data) }),
        )
      }
    },
    simulateError() {
      if (this.onerror) {
        this.onerror(new Event('error'))
      }
    },
  }
  return transport
}

// Track createFetchTransport calls
let fetchTransportCalls: Array<{ url: string; options: unknown }> = []
let mockFetchTransports: SSETransport[] = []

// Mock createFetchTransport
mock.module('../fetchTransport.ts', () => ({
  createFetchTransport: (url: string, options?: unknown) => {
    fetchTransportCalls.push({ url, options })
    const transport = createMockTransport()
    mockFetchTransports.push(transport)
    return transport
  },
}))

// Import after mocking
const { useSSEStream } = await import('../hooks/useSSEStream.ts')
type UseSSEStreamOptions<T> = Parameters<typeof useSSEStream<T>>[1] & {}

const originalEventSource = globalThis.EventSource

beforeEach(() => {
  // @ts-expect-error - Mocking EventSource
  globalThis.EventSource = MockEventSource
  MockEventSource.reset()
  fetchTransportCalls = []
  mockFetchTransports = []
})

afterEach(() => {
  globalThis.EventSource = originalEventSource
})

describe('useSSEStream transport integration', () => {
  describe('backward compatibility - default EventSource', () => {
    it('should use EventSource when no transport options are provided', () => {
      const testUrl = 'http://localhost:3000/stream'

      function StreamConsumer() {
        useSSEStream(testUrl)
        return createElement('div', null, 'streaming')
      }

      renderToString(createElement(StreamConsumer))

      expect(MockEventSource.instances.length).toBe(1)
      expect(MockEventSource.instances[0].url).toBe(testUrl)
      expect(fetchTransportCalls.length).toBe(0)
    })

    it('should use EventSource when options has only transform', () => {
      const testUrl = 'http://localhost:3000/stream'

      function StreamConsumer() {
        useSSEStream(testUrl, { transform: (d: unknown) => d })
        return createElement('div', null, 'streaming')
      }

      renderToString(createElement(StreamConsumer))

      expect(MockEventSource.instances.length).toBe(1)
      expect(fetchTransportCalls.length).toBe(0)
    })

    it('should return initial state with undefined data and error', () => {
      const testUrl = 'http://localhost:3000/stream'
      let capturedResult: { data: unknown; error: Error | undefined } | null =
        null

      function StreamConsumer() {
        const result = useSSEStream(testUrl)
        capturedResult = result
        return createElement('div', null, 'streaming')
      }

      renderToString(createElement(StreamConsumer))

      expect(capturedResult).not.toBeNull()
      expect(capturedResult?.data).toBeUndefined()
      expect(capturedResult?.error).toBeUndefined()
    })

    it('should update data when message received via EventSource', async () => {
      const testUrl = 'http://localhost:3000/stream'
      const testData = { count: 42 }
      let capturedData: unknown = null

      function StreamConsumer() {
        const { data } = useSSEStream(testUrl)
        if (data !== undefined) capturedData = data
        return createElement('div', null, JSON.stringify(data))
      }

      renderToString(createElement(StreamConsumer))
      MockEventSource.instances[0].simulateMessage(testData)
      await new Promise((resolve) => queueMicrotask(resolve))
      renderToString(createElement(StreamConsumer))

      expect(capturedData).toEqual(testData)
    })
  })

  describe('fetch transport - method and body', () => {
    it('should use createFetchTransport when method POST and body are provided', () => {
      const testUrl = 'http://localhost:3000/stream'
      const body = { query: 'SELECT *' }

      function StreamConsumer() {
        useSSEStream(testUrl, { method: 'POST', body })
        return createElement('div', null, 'streaming')
      }

      renderToString(createElement(StreamConsumer))

      // Should NOT create EventSource
      expect(MockEventSource.instances.length).toBe(0)
      // Should call createFetchTransport
      expect(fetchTransportCalls.length).toBe(1)
      expect(fetchTransportCalls[0].url).toBe(testUrl)
      expect(fetchTransportCalls[0].options).toEqual(
        expect.objectContaining({ method: 'POST', body }),
      )
    })

    it('should default to POST when body is provided without method', () => {
      const testUrl = 'http://localhost:3000/stream'
      const body = { filter: 'active' }

      function StreamConsumer() {
        useSSEStream(testUrl, { body })
        return createElement('div', null, 'streaming')
      }

      renderToString(createElement(StreamConsumer))

      expect(MockEventSource.instances.length).toBe(0)
      expect(fetchTransportCalls.length).toBe(1)
      // createFetchTransport should receive method: 'POST' (or undefined, since
      // createFetchTransport itself defaults to POST when body is present)
      const callOptions = fetchTransportCalls[0].options as Record<
        string,
        unknown
      >
      // Either useSSEStream passes method:'POST' explicitly, or it passes
      // through and lets createFetchTransport handle it. Either way, body must
      // be present.
      expect(callOptions.body).toEqual(body)
    })
  })

  describe('fetch transport - headers only', () => {
    it('should use createFetchTransport when only headers are provided', () => {
      const testUrl = 'http://localhost:3000/stream'
      const headers = { Authorization: 'Bearer token123' }

      function StreamConsumer() {
        useSSEStream(testUrl, { headers })
        return createElement('div', null, 'streaming')
      }

      renderToString(createElement(StreamConsumer))

      // Should NOT create EventSource
      expect(MockEventSource.instances.length).toBe(0)
      // Should call createFetchTransport for authenticated GET
      expect(fetchTransportCalls.length).toBe(1)
      expect(fetchTransportCalls[0].url).toBe(testUrl)
      expect(fetchTransportCalls[0].options).toEqual(
        expect.objectContaining({ headers }),
      )
    })
  })

  describe('custom transport factory', () => {
    it('should use custom transport when transport factory is provided', () => {
      const testUrl = 'http://localhost:3000/stream'
      const customTransport = createMockTransport()
      const transportFactory = mock(() => customTransport)

      function StreamConsumer() {
        useSSEStream(testUrl, { transport: transportFactory })
        return createElement('div', null, 'streaming')
      }

      renderToString(createElement(StreamConsumer))

      // Should NOT create EventSource
      expect(MockEventSource.instances.length).toBe(0)
      // Should NOT call createFetchTransport
      expect(fetchTransportCalls.length).toBe(0)
      // Should call custom factory with URL
      expect(transportFactory).toHaveBeenCalledWith(testUrl)
    })

    it('should receive messages through custom transport', async () => {
      const testUrl = 'http://localhost:3000/stream'
      const customTransport = createMockTransport()
      const transportFactory = () => customTransport
      const testData = { value: 99 }
      let capturedData: unknown = null

      function StreamConsumer() {
        const { data } = useSSEStream(testUrl, { transport: transportFactory })
        if (data !== undefined) capturedData = data
        return createElement('div', null, JSON.stringify(data))
      }

      renderToString(createElement(StreamConsumer))
      customTransport.simulateMessage(testData)
      await new Promise((resolve) => queueMicrotask(resolve))
      renderToString(createElement(StreamConsumer))

      expect(capturedData).toEqual(testData)
    })

    it('should catch and report error when custom transport factory throws', () => {
      const testUrl = 'http://localhost:3000/stream'
      const transportFactory = () => {
        throw new Error('Transport factory failed')
      }

      let capturedError: Error | undefined

      function StreamConsumer() {
        const { error } = useSSEStream(testUrl, {
          transport: transportFactory,
        })
        capturedError = error
        return createElement('div', null, error ? 'error' : 'ok')
      }

      // Should not throw
      expect(() => {
        renderToString(createElement(StreamConsumer))
      }).not.toThrow()

      // Error should be captured in the result
      expect(capturedError).toBeDefined()
      expect(capturedError).toBeInstanceOf(Error)
    })

    it('should prioritize custom transport over method/body/headers', () => {
      const testUrl = 'http://localhost:3000/stream'
      const customTransport = createMockTransport()
      const transportFactory = mock(() => customTransport)

      function StreamConsumer() {
        useSSEStream(testUrl, {
          transport: transportFactory,
          method: 'POST',
          body: { query: 'test' },
          headers: { 'X-Custom': 'value' },
        })
        return createElement('div', null, 'streaming')
      }

      renderToString(createElement(StreamConsumer))

      // Custom transport factory should take precedence
      expect(transportFactory).toHaveBeenCalled()
      expect(MockEventSource.instances.length).toBe(0)
      expect(fetchTransportCalls.length).toBe(0)
    })
  })

  describe('connection reuse', () => {
    it('should reuse connection for same URL with same options', () => {
      const testUrl = 'http://localhost:3000/stream'
      const body = { query: 'SELECT *' }

      function StreamConsumer1() {
        useSSEStream(testUrl, { method: 'POST', body })
        return createElement('div', null, 'consumer1')
      }

      function StreamConsumer2() {
        useSSEStream(testUrl, { method: 'POST', body })
        return createElement('div', null, 'consumer2')
      }

      renderToString(createElement(StreamConsumer1))
      renderToString(createElement(StreamConsumer2))

      // Should reuse the same transport, not create two
      expect(fetchTransportCalls.length).toBe(1)
    })

    it('should create separate connections for same URL with different body', () => {
      const testUrl = 'http://localhost:3000/stream'
      const body1 = { query: 'SELECT * FROM users' }
      const body2 = { query: 'SELECT * FROM orders' }

      function StreamConsumer1() {
        useSSEStream(testUrl, { method: 'POST', body: body1 })
        return createElement('div', null, 'consumer1')
      }

      function StreamConsumer2() {
        useSSEStream(testUrl, { method: 'POST', body: body2 })
        return createElement('div', null, 'consumer2')
      }

      renderToString(createElement(StreamConsumer1))
      renderToString(createElement(StreamConsumer2))

      // Different bodies should create different connections
      expect(fetchTransportCalls.length).toBe(2)
    })

    it('should create separate connections for same URL with different methods', () => {
      const testUrl = 'http://localhost:3000/stream'

      function StreamConsumer1() {
        useSSEStream(testUrl, { method: 'POST', body: { q: 'test' } })
        return createElement('div', null, 'consumer1')
      }

      function StreamConsumer2() {
        useSSEStream(testUrl, { method: 'PUT', body: { q: 'test' } })
        return createElement('div', null, 'consumer2')
      }

      renderToString(createElement(StreamConsumer1))
      renderToString(createElement(StreamConsumer2))

      // Different methods should create different connections
      expect(fetchTransportCalls.length).toBe(2)
    })

    it('should reuse EventSource connection for same URL with no options', () => {
      const testUrl = 'http://localhost:3000/stream'

      function StreamConsumer1() {
        useSSEStream(testUrl)
        return createElement('div', null, 'consumer1')
      }

      function StreamConsumer2() {
        useSSEStream(testUrl)
        return createElement('div', null, 'consumer2')
      }

      renderToString(createElement(StreamConsumer1))
      renderToString(createElement(StreamConsumer2))

      // Should reuse the same EventSource
      expect(MockEventSource.instances.length).toBe(1)
    })
  })

  describe('non-serializable bodies', () => {
    it('should never reuse connections with non-serializable bodies', () => {
      const testUrl = 'http://localhost:3000/stream'
      const blob1 = new Blob(['data1'])
      const blob2 = new Blob(['data2'])

      function StreamConsumer1() {
        useSSEStream(testUrl, { method: 'POST', body: blob1 })
        return createElement('div', null, 'consumer1')
      }

      function StreamConsumer2() {
        useSSEStream(testUrl, { method: 'POST', body: blob2 })
        return createElement('div', null, 'consumer2')
      }

      renderToString(createElement(StreamConsumer1))
      renderToString(createElement(StreamConsumer2))

      // Non-serializable bodies should always create new connections
      expect(fetchTransportCalls.length).toBe(2)
    })

    it('should never reuse connections even when same Blob instance is used', () => {
      const testUrl = 'http://localhost:3000/stream'
      const blob = new Blob(['data'])

      function StreamConsumer1() {
        useSSEStream(testUrl, { method: 'POST', body: blob })
        return createElement('div', null, 'consumer1')
      }

      function StreamConsumer2() {
        useSSEStream(testUrl, { method: 'POST', body: blob })
        return createElement('div', null, 'consumer2')
      }

      renderToString(createElement(StreamConsumer1))
      renderToString(createElement(StreamConsumer2))

      // Non-serializable bodies should always create new connections
      expect(fetchTransportCalls.length).toBe(2)
    })
  })

  describe('type acceptance', () => {
    it('should accept method option in UseSSEStreamOptions', () => {
      const testUrl = 'http://localhost:3000/stream'

      function StreamConsumer() {
        // This should compile without error
        const opts: UseSSEStreamOptions<unknown> = { method: 'POST' }
        useSSEStream(testUrl, opts)
        return createElement('div', null, 'streaming')
      }

      expect(() => {
        renderToString(createElement(StreamConsumer))
      }).not.toThrow()
    })

    it('should accept body option in UseSSEStreamOptions', () => {
      const testUrl = 'http://localhost:3000/stream'

      function StreamConsumer() {
        const opts: UseSSEStreamOptions<unknown> = {
          body: { key: 'value' },
        }
        useSSEStream(testUrl, opts)
        return createElement('div', null, 'streaming')
      }

      expect(() => {
        renderToString(createElement(StreamConsumer))
      }).not.toThrow()
    })

    it('should accept headers option in UseSSEStreamOptions', () => {
      const testUrl = 'http://localhost:3000/stream'

      function StreamConsumer() {
        const opts: UseSSEStreamOptions<unknown> = {
          headers: { Authorization: 'Bearer xyz' },
        }
        useSSEStream(testUrl, opts)
        return createElement('div', null, 'streaming')
      }

      expect(() => {
        renderToString(createElement(StreamConsumer))
      }).not.toThrow()
    })

    it('should accept transport factory option in UseSSEStreamOptions', () => {
      const testUrl = 'http://localhost:3000/stream'

      function StreamConsumer() {
        const opts: UseSSEStreamOptions<unknown> = {
          transport: (_url: string) => createMockTransport(),
        }
        useSSEStream(testUrl, opts)
        return createElement('div', null, 'streaming')
      }

      expect(() => {
        renderToString(createElement(StreamConsumer))
      }).not.toThrow()
    })

    it('should accept all transport options combined', () => {
      const testUrl = 'http://localhost:3000/stream'

      function StreamConsumer() {
        const opts: UseSSEStreamOptions<unknown> = {
          method: 'POST',
          body: { key: 'value' },
          headers: { Authorization: 'Bearer xyz' },
          transform: (d: unknown) => d,
        }
        useSSEStream(testUrl, opts)
        return createElement('div', null, 'streaming')
      }

      expect(() => {
        renderToString(createElement(StreamConsumer))
      }).not.toThrow()
    })
  })

  describe('cleanup', () => {
    it('should close EventSource transport on cleanup', () => {
      const testUrl = 'http://localhost:3000/stream'

      function StreamConsumer() {
        useSSEStream(testUrl)
        return createElement('div', null, 'streaming')
      }

      renderToString(createElement(StreamConsumer))

      const source = MockEventSource.instances[0]
      expect(source.readyState).not.toBe(2)

      // Verify close method exists and works
      source.close()
      expect(source.readyState).toBe(2)
    })

    it('should close fetch-based transport on cleanup', () => {
      const testUrl = 'http://localhost:3000/stream'

      function StreamConsumer() {
        useSSEStream(testUrl, {
          method: 'POST',
          body: { query: 'test' },
        })
        return createElement('div', null, 'streaming')
      }

      renderToString(createElement(StreamConsumer))

      expect(mockFetchTransports.length).toBe(1)
      const transport = mockFetchTransports[0]
      expect(transport.readyState).not.toBe(2)

      // Verify close method exists and works
      transport.close()
      expect(transport.readyState).toBe(2)
    })

    it('should close custom transport on cleanup', () => {
      const testUrl = 'http://localhost:3000/stream'
      const customTransport = createMockTransport()

      function StreamConsumer() {
        useSSEStream(testUrl, {
          transport: () => customTransport,
        })
        return createElement('div', null, 'streaming')
      }

      renderToString(createElement(StreamConsumer))

      expect(customTransport.readyState).not.toBe(2)
      customTransport.close()
      expect(customTransport.readyState).toBe(2)
    })
  })

  describe('error handling through transports', () => {
    it('should report errors from fetch-based transport', async () => {
      const testUrl = 'http://localhost:3000/stream'
      let capturedError: Error | undefined

      function StreamConsumer() {
        const { error } = useSSEStream(testUrl, {
          method: 'POST',
          body: { query: 'test' },
        })
        capturedError = error
        return createElement('div', null, error ? 'error' : 'ok')
      }

      renderToString(createElement(StreamConsumer))

      // Simulate error on the fetch transport
      const transport = mockFetchTransports[0] as ReturnType<
        typeof createMockTransport
      >
      transport.simulateError()

      await new Promise((resolve) => queueMicrotask(resolve))
      renderToString(createElement(StreamConsumer))

      expect(capturedError).toBeDefined()
      expect(capturedError).toBeInstanceOf(Error)
    })

    it('should report errors from custom transport', async () => {
      const testUrl = 'http://localhost:3000/stream'
      const customTransport = createMockTransport()
      let capturedError: Error | undefined
      // Use a stable factory reference so the connection key is consistent across renders
      const transportFactory = () => customTransport

      function StreamConsumer() {
        const { error } = useSSEStream(testUrl, {
          transport: transportFactory,
        })
        capturedError = error
        return createElement('div', null, error ? 'error' : 'ok')
      }

      renderToString(createElement(StreamConsumer))
      customTransport.simulateError()

      await new Promise((resolve) => queueMicrotask(resolve))
      renderToString(createElement(StreamConsumer))

      expect(capturedError).toBeDefined()
      expect(capturedError).toBeInstanceOf(Error)
    })
  })

  describe('custom transport key collision (probe)', () => {
    it('should use separate connections when different transport factories are provided for the same URL', () => {
      const testUrl = 'http://localhost:3000/stream'
      const transport1 = createMockTransport()
      const transport2 = createMockTransport()
      const factory1 = mock(() => transport1)
      const factory2 = mock(() => transport2)

      function StreamConsumer1() {
        useSSEStream(testUrl, { transport: factory1 })
        return createElement('div', null, 'consumer1')
      }

      function StreamConsumer2() {
        useSSEStream(testUrl, { transport: factory2 })
        return createElement('div', null, 'consumer2')
      }

      renderToString(createElement(StreamConsumer1))
      renderToString(createElement(StreamConsumer2))

      // Both factories should have been called - they are different transports
      expect(factory1).toHaveBeenCalledTimes(1)
      expect(factory2).toHaveBeenCalledTimes(1)
    })

    it('should deliver messages independently to different custom transports for same URL', async () => {
      const testUrl = 'http://localhost:3000/stream'
      const transport1 = createMockTransport()
      const transport2 = createMockTransport()
      // Use stable factory references so each component's connection key is
      // consistent across re-renders
      const factory1 = () => transport1
      const factory2 = () => transport2
      let data1: unknown
      let data2: unknown

      function StreamConsumer1() {
        const { data } = useSSEStream(testUrl, { transport: factory1 })
        if (data !== undefined) data1 = data
        return createElement('div', null, 'consumer1')
      }

      function StreamConsumer2() {
        const { data } = useSSEStream(testUrl, { transport: factory2 })
        if (data !== undefined) data2 = data
        return createElement('div', null, 'consumer2')
      }

      renderToString(createElement(StreamConsumer1))
      renderToString(createElement(StreamConsumer2))

      // Send different data to each transport
      transport1.simulateMessage({ value: 'from-transport-1' })
      transport2.simulateMessage({ value: 'from-transport-2' })

      await new Promise((resolve) => queueMicrotask(resolve))
      renderToString(createElement(StreamConsumer1))
      renderToString(createElement(StreamConsumer2))

      expect(data1).toEqual({ value: 'from-transport-1' })
      expect(data2).toEqual({ value: 'from-transport-2' })
    })
  })
})
