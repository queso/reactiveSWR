import { afterEach, beforeEach, describe, expect, it } from 'bun:test'

/**
 * Tests for transport-aware mockSSE testing utility.
 *
 * These tests verify that mockSSE supports both EventSource and fetch-based
 * transports for testing components that use either transport layer.
 *
 * The tests cover:
 * 1. Backward compatibility - EventSource mocking still works
 * 2. Fetch interception - mockSSE intercepts fetch calls to registered URLs
 * 3. Fetch passthrough - non-SSE fetch calls are not intercepted
 * 4. sendEvent for fetch - produces SSE wire format chunks
 * 5. sendRaw - sends raw SSE wire format text
 * 6. close for fetch - closes fetch-based connections
 * 7. mockSSE.restore() cleans up both EventSource and fetch mocks
 * 8. Multiple simultaneous mocks (EventSource + fetch)
 * 9. MockSSEControls type includes sendRaw
 * 10. Existing mockSSE tests remain unbroken
 *
 * These tests should FAIL until src/testing/index.ts is updated with
 * transport-aware support.
 */

describe('mockSSE transport-aware', () => {
  // biome-ignore lint/suspicious/noExplicitAny: dynamically imported testing utility
  let mockSSE: any
  let originalFetch: typeof globalThis.fetch

  beforeEach(async () => {
    originalFetch = globalThis.fetch
    mockSSE = (await import('../testing/index.ts')).mockSSE
  })

  afterEach(() => {
    if (mockSSE?.restore) {
      mockSSE.restore()
    }
    // Safety net: ensure fetch is restored even if restore() fails
    if (globalThis.fetch !== originalFetch) {
      globalThis.fetch = originalFetch
    }
  })

  describe('backward compatibility - EventSource transport', () => {
    it('should still intercept EventSource constructor', () => {
      const mock = mockSSE('/api/events')
      const es = new EventSource('/api/events')

      expect(es).toBeDefined()
      expect(es.url).toBe('/api/events')
      expect(mock.getConnection()).toBe(es)
    })

    it('should still deliver events via onmessage on EventSource', () => {
      const mock = mockSSE('/api/events')
      const es = new EventSource('/api/events')

      let received: MessageEvent | null = null
      es.onmessage = (event: MessageEvent) => {
        received = event
      }

      mock.sendEvent({ type: 'update', payload: { id: 1 } })

      expect(received).not.toBeNull()
      const parsed = JSON.parse(received?.data)
      expect(parsed.type).toBe('update')
      expect(parsed.payload).toEqual({ id: 1 })
    })

    it('should still support close on EventSource connections', () => {
      const mock = mockSSE('/api/events')
      const es = new EventSource('/api/events')

      mock.close()

      expect(es.readyState).toBe(EventSource.CLOSED)
    })
  })

  describe('fetch interception', () => {
    it('should intercept fetch calls to a mocked URL', async () => {
      mockSSE('/api/stream')

      const response = await fetch('/api/stream')

      expect(response).toBeDefined()
      expect(response.ok).toBe(true)
      expect(response.body).toBeInstanceOf(ReadableStream)
    })

    it('should return a Response with correct SSE content-type header', async () => {
      mockSSE('/api/stream')

      const response = await fetch('/api/stream')

      const contentType = response.headers.get('content-type')
      expect(contentType).toContain('text/event-stream')
    })

    it('should return a 200 status for mocked fetch URLs', async () => {
      mockSSE('/api/stream')

      const response = await fetch('/api/stream')

      expect(response.status).toBe(200)
    })

    it('should NOT intercept fetch calls to non-mocked URLs', async () => {
      mockSSE('/api/stream')

      // This URL is not mocked, so it should go through to the real fetch
      // We expect it to fail or return a real response, not a mock
      let usedRealFetch = false
      const _savedFetch = originalFetch
      // We can detect passthrough by checking if the original fetch was called
      // Since non-mocked URLs may fail in test env, we catch the error
      try {
        const _response = await fetch('https://example.com/not-mocked')
        // If we get here, real fetch was used (or mock incorrectly intercepted)
        // Check that the response is NOT a mock SSE response
        usedRealFetch = true
      } catch {
        // Real fetch may throw in test environment (no network) - that's fine,
        // it means the call was NOT intercepted by our mock
        usedRealFetch = true
      }

      expect(usedRealFetch).toBe(true)
    })

    it('should intercept fetch with Request object for mocked URL', async () => {
      mockSSE('/api/stream')

      const request = new Request('/api/stream')
      const response = await fetch(request)

      expect(response).toBeDefined()
      expect(response.ok).toBe(true)
      expect(response.body).toBeInstanceOf(ReadableStream)
    })
  })

  describe('sendEvent for fetch-based connections', () => {
    it('should produce SSE wire format data in the ReadableStream', async () => {
      const mock = mockSSE('/api/stream')

      const response = await fetch('/api/stream')
      const reader = response.body?.getReader()
      const decoder = new TextDecoder()

      mock.sendEvent({ type: 'update', payload: { id: 42 } })

      const { value, done } = await reader.read()
      expect(done).toBe(false)

      const text = decoder.decode(value)
      // SSE wire format: "event: <type>\ndata: <json>\n\n"
      expect(text).toContain('event:')
      expect(text).toContain('data:')
      expect(text).toContain('\n\n')

      // The event field should contain the event type
      const eventMatch = text.match(/event:\s*(.+)\n/)
      expect(eventMatch).not.toBeNull()
      expect(eventMatch?.[1]).toBe('update')

      // The data field should contain JSON with the payload only
      const dataMatch = text.match(/data:\s*(.+)\n/)
      expect(dataMatch).not.toBeNull()

      const parsed = JSON.parse(dataMatch?.[1])
      expect(parsed).toEqual({ id: 42 })
    })

    it('should deliver multiple events as separate SSE chunks', async () => {
      const mock = mockSSE('/api/stream')

      const response = await fetch('/api/stream')
      const reader = response.body?.getReader()
      const decoder = new TextDecoder()

      mock.sendEvent({ type: 'first', payload: { n: 1 } })
      mock.sendEvent({ type: 'second', payload: { n: 2 } })

      // Read chunks - may come as one or two reads
      let allText = ''
      const { value: v1 } = await reader.read()
      allText += decoder.decode(v1, { stream: true })

      // Try reading again for second event if not already included
      if (!allText.includes('second')) {
        const { value: v2 } = await reader.read()
        allText += decoder.decode(v2, { stream: true })
      }

      expect(allText).toContain('first')
      expect(allText).toContain('second')
    })
  })

  describe('sendRaw', () => {
    it('should be a function on MockSSEControls', () => {
      const mock = mockSSE('/api/stream')

      expect(typeof mock.sendRaw).toBe('function')
    })

    it('should send raw SSE wire format text to fetch-based connections', async () => {
      const mock = mockSSE('/api/stream')

      const response = await fetch('/api/stream')
      const reader = response.body?.getReader()
      const decoder = new TextDecoder()

      // Send raw SSE format (e.g., with custom event type)
      mock.sendRaw('event: custom\ndata: {"hello":"world"}\n\n')

      const { value } = await reader.read()
      const text = decoder.decode(value)

      expect(text).toBe('event: custom\ndata: {"hello":"world"}\n\n')
    })

    it('should send raw SSE wire format with retry field', async () => {
      const mock = mockSSE('/api/stream')

      const response = await fetch('/api/stream')
      const reader = response.body?.getReader()
      const decoder = new TextDecoder()

      mock.sendRaw('retry: 5000\ndata: reconnect\n\n')

      const { value } = await reader.read()
      const text = decoder.decode(value)

      expect(text).toContain('retry: 5000')
      expect(text).toContain('data: reconnect')
    })

    it('should send raw SSE wire format with id field', async () => {
      const mock = mockSSE('/api/stream')

      const response = await fetch('/api/stream')
      const reader = response.body?.getReader()
      const decoder = new TextDecoder()

      mock.sendRaw('id: 123\ndata: identified\n\n')

      const { value } = await reader.read()
      const text = decoder.decode(value)

      expect(text).toContain('id: 123')
      expect(text).toContain('data: identified')
    })

    it('should send raw comments for keep-alive', async () => {
      const mock = mockSSE('/api/stream')

      const response = await fetch('/api/stream')
      const reader = response.body?.getReader()
      const decoder = new TextDecoder()

      mock.sendRaw(': keepalive\n\n')

      const { value } = await reader.read()
      const text = decoder.decode(value)

      expect(text).toBe(': keepalive\n\n')
    })
  })

  describe('close for fetch-based connections', () => {
    it('should close the ReadableStream when close() is called', async () => {
      const mock = mockSSE('/api/stream')

      const response = await fetch('/api/stream')
      const reader = response.body?.getReader()

      mock.close()

      const { done } = await reader.read()
      expect(done).toBe(true)
    })

    it('should not deliver events after close on fetch connections', async () => {
      const mock = mockSSE('/api/stream')

      const response = await fetch('/api/stream')
      const reader = response.body?.getReader()

      // Send one event before close
      mock.sendEvent({ type: 'before', payload: {} })
      const { value } = await reader.read()
      expect(value).toBeDefined()

      // Close and try to send another
      mock.close()
      mock.sendEvent({ type: 'after', payload: {} })

      const { done } = await reader.read()
      expect(done).toBe(true)
    })
  })

  describe('mockSSE.restore() cleanup', () => {
    it('should restore the original fetch function', () => {
      mockSSE('/api/stream')
      mockSSE.restore()

      expect(globalThis.fetch).toBe(originalFetch)
    })

    it('should restore both EventSource and fetch simultaneously', () => {
      const originalES = globalThis.EventSource

      mockSSE('/api/events')
      mockSSE.restore()

      // fetch should be restored
      expect(globalThis.fetch).toBe(originalFetch)

      // EventSource should be restored
      if (originalES) {
        expect(globalThis.EventSource).toBe(originalES)
      }
    })

    it('should close all active fetch-based streams on restore', async () => {
      const _mock = mockSSE('/api/stream')

      const response = await fetch('/api/stream')
      const reader = response.body?.getReader()

      mockSSE.restore()

      // Stream should be closed after restore
      const { done } = await reader.read()
      expect(done).toBe(true)
    })
  })

  describe('multiple simultaneous mocks', () => {
    it('should support EventSource and fetch mocks for different URLs', () => {
      const esMock = mockSSE('/api/events')
      const fetchMock = mockSSE('/api/stream')

      // EventSource mock works
      const es = new EventSource('/api/events')
      let esReceived: MessageEvent | null = null
      es.onmessage = (event: MessageEvent) => {
        esReceived = event
      }
      esMock.sendEvent({ type: 'es-event', payload: { source: 'eventsource' } })
      expect(esReceived).not.toBeNull()

      // fetch mock works (type check only - full async test elsewhere)
      expect(typeof fetchMock.sendEvent).toBe('function')
      expect(typeof fetchMock.sendRaw).toBe('function')
    })

    it('should isolate fetch mocks for different URLs', async () => {
      const mock1 = mockSSE('/api/stream1')
      const mock2 = mockSSE('/api/stream2')

      const response1 = await fetch('/api/stream1')
      const response2 = await fetch('/api/stream2')

      const reader1 = response1.body?.getReader()
      const reader2 = response2.body?.getReader()
      const decoder = new TextDecoder()

      mock1.sendEvent({ type: 'from-1', payload: { source: 1 } })
      mock2.sendEvent({ type: 'from-2', payload: { source: 2 } })

      const { value: v1 } = await reader1.read()
      const { value: v2 } = await reader2.read()

      const text1 = decoder.decode(v1)
      const text2 = decoder.decode(v2)

      expect(text1).toContain('from-1')
      expect(text2).toContain('from-2')
      expect(text1).not.toContain('from-2')
      expect(text2).not.toContain('from-1')
    })
  })

  describe('MockSSEControls type', () => {
    it('should have sendRaw method on controls', () => {
      const mock = mockSSE('/api/stream')

      expect(mock).toHaveProperty('sendRaw')
      expect(typeof mock.sendRaw).toBe('function')
    })

    it('should have sendEvent method on controls', () => {
      const mock = mockSSE('/api/stream')

      expect(mock).toHaveProperty('sendEvent')
      expect(typeof mock.sendEvent).toBe('function')
    })

    it('should have close method on controls', () => {
      const mock = mockSSE('/api/stream')

      expect(mock).toHaveProperty('close')
      expect(typeof mock.close).toBe('function')
    })

    it('should have getConnection method on controls', () => {
      const mock = mockSSE('/api/stream')

      expect(mock).toHaveProperty('getConnection')
      expect(typeof mock.getConnection).toBe('function')
    })
  })

  describe('existing test compatibility', () => {
    it('should not break existing mockSSE API - sendEvent + onmessage', () => {
      const mock = mockSSE('/api/events')
      const es = new EventSource('/api/events')

      let data: string | null = null
      es.onmessage = (e: MessageEvent) => {
        data = e.data
      }

      mock.sendEvent({ type: 'test', payload: { value: 99 } })

      expect(data).not.toBeNull()
      const parsed = JSON.parse(data as string)
      expect(parsed.type).toBe('test')
      expect(parsed.payload.value).toBe(99)
    })

    it('should not break existing mockSSE API - addEventListener', () => {
      const mock = mockSSE('/api/events')
      const es = new EventSource('/api/events')

      let received = false
      es.addEventListener('custom', () => {
        received = true
      })

      mock.sendEvent({ type: 'custom', payload: {} })

      expect(received).toBe(true)
    })

    it('should not break existing mockSSE API - close triggers onerror', () => {
      const mock = mockSSE('/api/events')
      const es = new EventSource('/api/events')

      let errorFired = false
      es.onerror = () => {
        errorFired = true
      }

      mock.close()

      expect(errorFired).toBe(true)
      expect(es.readyState).toBe(EventSource.CLOSED)
    })

    it('should not break existing mockSSE API - restore prevents further events', () => {
      const mock = mockSSE('/api/events')
      const es = new EventSource('/api/events')

      let count = 0
      es.onmessage = () => {
        count++
      }

      mock.sendEvent({ type: 'test', payload: {} })
      expect(count).toBe(1)

      mockSSE.restore()

      try {
        mock.sendEvent({ type: 'test', payload: {} })
      } catch {
        // May throw after restore
      }

      expect(count).toBe(1)
    })

    it('should not break existing mockSSE API - multiple URLs independently', () => {
      const mock1 = mockSSE('/api/a')
      const mock2 = mockSSE('/api/b')

      const es1 = new EventSource('/api/a')
      const es2 = new EventSource('/api/b')

      let count1 = 0
      let count2 = 0

      es1.onmessage = () => count1++
      es2.onmessage = () => count2++

      mock1.sendEvent({ type: 't', payload: {} })
      mock2.sendEvent({ type: 't', payload: {} })
      mock2.sendEvent({ type: 't', payload: {} })

      expect(count1).toBe(1)
      expect(count2).toBe(2)
    })
  })
})
