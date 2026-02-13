import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { createFetchTransport } from '../fetchTransport.ts'
import type { SSETransport } from '../types.ts'

/**
 * Tests for fetch-based SSE transport (createFetchTransport).
 *
 * This transport uses fetch() + ReadableStream to establish an HTTP connection,
 * feeds response chunks into the SSE parser, and dispatches parsed events.
 *
 * These tests should FAIL until src/fetchTransport.ts is implemented.
 */

// ---- Helpers ----

/**
 * Creates a mock ReadableStream that yields the given chunks as Uint8Array.
 * Optionally calls onCancel when the stream reader is cancelled.
 */
function createMockStream(
  chunks: string[],
  options?: { onCancel?: () => void; delayMs?: number },
) {
  const encoder = new TextEncoder()
  let index = 0
  let cancelled = false

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (cancelled) return
      if (options?.delayMs) {
        await new Promise((r) => setTimeout(r, options.delayMs))
      }
      if (index < chunks.length) {
        controller.enqueue(encoder.encode(chunks[index]))
        index++
      } else {
        controller.close()
      }
    },
    cancel() {
      cancelled = true
      options?.onCancel?.()
    },
  })
}

/**
 * Creates a mock Response with the given status and body stream.
 */
function createMockResponse(
  status: number,
  chunks: string[],
  options?: { onCancel?: () => void; delayMs?: number },
): Response {
  const body = createMockStream(chunks, options)
  return new Response(body, {
    status,
    statusText: status === 200 ? 'OK' : 'Error',
    headers: { 'Content-Type': 'text/event-stream' },
  })
}

/** Flush microtasks and allow stream processing */
function flushAsync(ms = 10): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

// ---- Tests ----

let originalFetch: typeof globalThis.fetch

beforeEach(() => {
  originalFetch = globalThis.fetch
})

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe('createFetchTransport', () => {
  describe('factory and SSETransport conformance', () => {
    it('should return an object conforming to SSETransport interface', () => {
      globalThis.fetch = mock(() =>
        Promise.resolve(createMockResponse(200, [])),
      ) as typeof fetch

      const transport = createFetchTransport('http://localhost/events')

      // Verify all SSETransport members exist
      expect(transport.onmessage).toBeNull()
      expect(transport.onerror).toBeNull()
      expect(transport.onopen).toBeNull()
      expect(typeof transport.close).toBe('function')
      expect(typeof transport.readyState).toBe('number')
      expect(typeof transport.addEventListener).toBe('function')
      expect(typeof transport.removeEventListener).toBe('function')

      // Verify it satisfies the type
      const _typed: SSETransport = transport

      transport.close()
    })

    it('should expose a readonly lastEventId property', () => {
      globalThis.fetch = mock(() =>
        Promise.resolve(createMockResponse(200, [])),
      ) as typeof fetch

      const transport = createFetchTransport('http://localhost/events')
      expect(transport.lastEventId).toBe('')

      transport.close()
    })

    it('should expose an onretry callback property', () => {
      globalThis.fetch = mock(() =>
        Promise.resolve(createMockResponse(200, [])),
      ) as typeof fetch

      const transport = createFetchTransport('http://localhost/events')
      expect(transport.onretry).toBeNull()

      transport.close()
    })
  })

  describe('readyState', () => {
    it('should start as CONNECTING (0)', () => {
      globalThis.fetch = mock(
        () => new Promise<Response>(() => {}), // never resolves
      ) as typeof fetch

      const transport = createFetchTransport('http://localhost/events')
      expect(transport.readyState).toBe(0)

      transport.close()
    })

    it('should become OPEN (1) on successful connection', async () => {
      globalThis.fetch = mock(() =>
        Promise.resolve(
          createMockResponse(200, ['data: hello\n\n'], { delayMs: 5 }),
        ),
      ) as typeof fetch

      const transport = createFetchTransport('http://localhost/events')
      await flushAsync(20)

      expect(transport.readyState).toBe(1)

      transport.close()
    })

    it('should become CLOSED (2) after close()', async () => {
      globalThis.fetch = mock(() =>
        Promise.resolve(createMockResponse(200, ['data: hello\n\n'])),
      ) as typeof fetch

      const transport = createFetchTransport('http://localhost/events')
      transport.close()

      expect(transport.readyState).toBe(2)
    })
  })

  describe('onopen', () => {
    it('should call onopen when connection is established', async () => {
      globalThis.fetch = mock(() =>
        Promise.resolve(
          createMockResponse(200, ['data: hello\n\n'], { delayMs: 5 }),
        ),
      ) as typeof fetch

      const onopen = mock(() => {})
      const transport = createFetchTransport('http://localhost/events')
      transport.onopen = onopen

      await flushAsync(20)

      expect(onopen).toHaveBeenCalledTimes(1)
      const event = onopen.mock.calls[0][0]
      expect(event).toBeDefined()

      transport.close()
    })
  })

  describe('onmessage', () => {
    it('should call onmessage with MessageEvent-like objects for unnamed events', async () => {
      globalThis.fetch = mock(() =>
        Promise.resolve(createMockResponse(200, ['data: hello world\n\n'])),
      ) as typeof fetch

      const onmessage = mock(() => {})
      const transport = createFetchTransport('http://localhost/events')
      transport.onmessage = onmessage

      await flushAsync(50)

      expect(onmessage).toHaveBeenCalledTimes(1)
      const event = onmessage.mock.calls[0][0]
      expect(event.data).toBe('hello world')
      expect(event.type).toBe('message')

      transport.close()
    })

    it('should handle multiple events in a single chunk', async () => {
      globalThis.fetch = mock(() =>
        Promise.resolve(
          createMockResponse(200, [
            'data: first\n\ndata: second\n\ndata: third\n\n',
          ]),
        ),
      ) as typeof fetch

      const onmessage = mock(() => {})
      const transport = createFetchTransport('http://localhost/events')
      transport.onmessage = onmessage

      await flushAsync(50)

      expect(onmessage).toHaveBeenCalledTimes(3)
      expect(onmessage.mock.calls[0][0].data).toBe('first')
      expect(onmessage.mock.calls[1][0].data).toBe('second')
      expect(onmessage.mock.calls[2][0].data).toBe('third')

      transport.close()
    })

    it('should handle events split across multiple chunks', async () => {
      globalThis.fetch = mock(() =>
        Promise.resolve(createMockResponse(200, ['data: hel', 'lo\n\n'])),
      ) as typeof fetch

      const onmessage = mock(() => {})
      const transport = createFetchTransport('http://localhost/events')
      transport.onmessage = onmessage

      await flushAsync(50)

      expect(onmessage).toHaveBeenCalledTimes(1)
      expect(onmessage.mock.calls[0][0].data).toBe('hello')

      transport.close()
    })

    it('should NOT call onmessage for named events', async () => {
      globalThis.fetch = mock(() =>
        Promise.resolve(
          createMockResponse(200, ['event: custom\ndata: payload\n\n']),
        ),
      ) as typeof fetch

      const onmessage = mock(() => {})
      const transport = createFetchTransport('http://localhost/events')
      transport.onmessage = onmessage

      await flushAsync(50)

      // Named events go to addEventListener listeners, not onmessage
      expect(onmessage).not.toHaveBeenCalled()

      transport.close()
    })
  })

  describe('addEventListener / named events', () => {
    it('should dispatch named events to addEventListener listeners', async () => {
      globalThis.fetch = mock(() =>
        Promise.resolve(
          createMockResponse(200, ['event: user.updated\ndata: {"id":1}\n\n']),
        ),
      ) as typeof fetch

      const listener = mock(() => {})
      const transport = createFetchTransport('http://localhost/events')
      transport.addEventListener('user.updated', listener)

      await flushAsync(50)

      expect(listener).toHaveBeenCalledTimes(1)
      const event = listener.mock.calls[0][0]
      expect(event.data).toBe('{"id":1}')
      expect(event.type).toBe('user.updated')

      transport.close()
    })

    it('should support multiple listeners for the same event type', async () => {
      globalThis.fetch = mock(() =>
        Promise.resolve(
          createMockResponse(200, ['event: update\ndata: test\n\n']),
        ),
      ) as typeof fetch

      const listener1 = mock(() => {})
      const listener2 = mock(() => {})
      const transport = createFetchTransport('http://localhost/events')
      transport.addEventListener('update', listener1)
      transport.addEventListener('update', listener2)

      await flushAsync(50)

      expect(listener1).toHaveBeenCalledTimes(1)
      expect(listener2).toHaveBeenCalledTimes(1)

      transport.close()
    })

    it('should support listeners for different event types', async () => {
      globalThis.fetch = mock(() =>
        Promise.resolve(
          createMockResponse(200, [
            'event: user.created\ndata: a\n\nevent: user.deleted\ndata: b\n\n',
          ]),
        ),
      ) as typeof fetch

      const createdListener = mock(() => {})
      const deletedListener = mock(() => {})
      const transport = createFetchTransport('http://localhost/events')
      transport.addEventListener('user.created', createdListener)
      transport.addEventListener('user.deleted', deletedListener)

      await flushAsync(50)

      expect(createdListener).toHaveBeenCalledTimes(1)
      expect(createdListener.mock.calls[0][0].data).toBe('a')
      expect(deletedListener).toHaveBeenCalledTimes(1)
      expect(deletedListener.mock.calls[0][0].data).toBe('b')

      transport.close()
    })
  })

  describe('removeEventListener', () => {
    it('should stop dispatching events to removed listeners', async () => {
      globalThis.fetch = mock(() =>
        Promise.resolve(
          createMockResponse(200, [
            'event: update\ndata: first\n\n',
            'event: update\ndata: second\n\n',
          ]),
        ),
      ) as typeof fetch

      const listener = mock(() => {})
      const transport = createFetchTransport('http://localhost/events')
      transport.addEventListener('update', listener)

      await flushAsync(20)

      // Remove after first event
      transport.removeEventListener('update', listener)

      await flushAsync(50)

      // Listener should have only received the first event
      expect(listener).toHaveBeenCalledTimes(1)

      transport.close()
    })

    it('should not error when removing a listener that was never added', () => {
      globalThis.fetch = mock(() =>
        Promise.resolve(createMockResponse(200, [])),
      ) as typeof fetch

      const transport = createFetchTransport('http://localhost/events')

      expect(() => {
        transport.removeEventListener('unknown', () => {})
      }).not.toThrow()

      transport.close()
    })
  })

  describe('close()', () => {
    it('should set readyState to CLOSED (2)', () => {
      globalThis.fetch = mock(
        () => new Promise<Response>(() => {}),
      ) as typeof fetch

      const transport = createFetchTransport('http://localhost/events')
      transport.close()

      expect(transport.readyState).toBe(2)
    })

    it('should abort the fetch via AbortController', async () => {
      let abortSignal: AbortSignal | undefined

      globalThis.fetch = mock(
        (input: RequestInfo | URL, init?: RequestInit) => {
          abortSignal = init?.signal as AbortSignal
          return new Promise<Response>(() => {}) // hang forever
        },
      ) as typeof fetch

      const transport = createFetchTransport('http://localhost/events')

      // Give fetch time to be called
      await flushAsync(10)

      expect(abortSignal).toBeDefined()
      expect(abortSignal?.aborted).toBe(false)

      transport.close()

      expect(abortSignal?.aborted).toBe(true)
    })

    it('should be safe to call close() multiple times', () => {
      globalThis.fetch = mock(
        () => new Promise<Response>(() => {}),
      ) as typeof fetch

      const transport = createFetchTransport('http://localhost/events')

      expect(() => {
        transport.close()
        transport.close()
        transport.close()
      }).not.toThrow()

      expect(transport.readyState).toBe(2)
    })

    it('should be safe to call close() after stream has already ended', async () => {
      globalThis.fetch = mock(() =>
        Promise.resolve(createMockResponse(200, ['data: done\n\n'])),
      ) as typeof fetch

      const transport = createFetchTransport('http://localhost/events')
      await flushAsync(50)

      expect(() => {
        transport.close()
      }).not.toThrow()

      expect(transport.readyState).toBe(2)
    })
  })

  describe('error handling', () => {
    it('should call onerror and set readyState to CLOSED on non-2xx response', async () => {
      globalThis.fetch = mock(() =>
        Promise.resolve(createMockResponse(500, [])),
      ) as typeof fetch

      const onerror = mock(() => {})
      const transport = createFetchTransport('http://localhost/events')
      transport.onerror = onerror

      await flushAsync(50)

      expect(onerror).toHaveBeenCalledTimes(1)
      expect(transport.readyState).toBe(2)
    })

    it('should call onerror and set readyState to CLOSED on 404 response', async () => {
      globalThis.fetch = mock(() =>
        Promise.resolve(createMockResponse(404, [])),
      ) as typeof fetch

      const onerror = mock(() => {})
      const transport = createFetchTransport('http://localhost/events')
      transport.onerror = onerror

      await flushAsync(50)

      expect(onerror).toHaveBeenCalledTimes(1)
      expect(transport.readyState).toBe(2)
    })

    it('should call onerror and set readyState to CLOSED on network error', async () => {
      globalThis.fetch = mock(() =>
        Promise.reject(new TypeError('Failed to fetch')),
      ) as typeof fetch

      const onerror = mock(() => {})
      const transport = createFetchTransport('http://localhost/events')
      transport.onerror = onerror

      await flushAsync(50)

      expect(onerror).toHaveBeenCalledTimes(1)
      expect(transport.readyState).toBe(2)
    })

    it('should call onerror when stream ends unexpectedly', async () => {
      // A stream that closes immediately without any data
      globalThis.fetch = mock(() =>
        Promise.resolve(createMockResponse(200, [])),
      ) as typeof fetch

      const onerror = mock(() => {})
      const transport = createFetchTransport('http://localhost/events')
      transport.onerror = onerror

      await flushAsync(50)

      expect(onerror).toHaveBeenCalled()
      expect(transport.readyState).toBe(2)
    })
  })

  describe('request configuration', () => {
    it('should default to GET when no body is provided', async () => {
      let capturedInit: RequestInit | undefined

      globalThis.fetch = mock(
        (_input: RequestInfo | URL, init?: RequestInit) => {
          capturedInit = init
          return Promise.resolve(createMockResponse(200, ['data: ok\n\n']))
        },
      ) as typeof fetch

      const transport = createFetchTransport('http://localhost/events')
      await flushAsync(20)

      // Default method should be GET (or undefined which defaults to GET)
      expect(
        capturedInit?.method === undefined || capturedInit?.method === 'GET',
      ).toBe(true)

      transport.close()
    })

    it('should default to POST when body is provided without method', async () => {
      let capturedInit: RequestInit | undefined

      globalThis.fetch = mock(
        (_input: RequestInfo | URL, init?: RequestInit) => {
          capturedInit = init
          return Promise.resolve(createMockResponse(200, ['data: ok\n\n']))
        },
      ) as typeof fetch

      const transport = createFetchTransport('http://localhost/events', {
        body: { query: 'test' },
      })
      await flushAsync(20)

      expect(capturedInit?.method).toBe('POST')

      transport.close()
    })

    it('should JSON.stringify a plain object body and set Content-Type', async () => {
      let capturedInit: RequestInit | undefined

      globalThis.fetch = mock(
        (_input: RequestInfo | URL, init?: RequestInit) => {
          capturedInit = init
          return Promise.resolve(createMockResponse(200, ['data: ok\n\n']))
        },
      ) as typeof fetch

      const bodyObj = { query: 'test', limit: 10 }
      const transport = createFetchTransport('http://localhost/events', {
        body: bodyObj,
      })
      await flushAsync(20)

      expect(capturedInit?.body).toBe(JSON.stringify(bodyObj))

      const headers = capturedInit?.headers as Record<string, string>
      expect(headers?.['Content-Type'] ?? headers?.['content-type']).toBe(
        'application/json',
      )

      transport.close()
    })

    it('should not override Content-Type if already set in headers', async () => {
      let capturedInit: RequestInit | undefined

      globalThis.fetch = mock(
        (_input: RequestInfo | URL, init?: RequestInit) => {
          capturedInit = init
          return Promise.resolve(createMockResponse(200, ['data: ok\n\n']))
        },
      ) as typeof fetch

      const transport = createFetchTransport('http://localhost/events', {
        body: { query: 'test' },
        headers: { 'Content-Type': 'text/plain' },
      })
      await flushAsync(20)

      const headers = capturedInit?.headers as Record<string, string>
      expect(headers?.['Content-Type']).toBe('text/plain')

      transport.close()
    })

    it('should pass custom headers through to fetch', async () => {
      let capturedInit: RequestInit | undefined

      globalThis.fetch = mock(
        (_input: RequestInfo | URL, init?: RequestInit) => {
          capturedInit = init
          return Promise.resolve(createMockResponse(200, ['data: ok\n\n']))
        },
      ) as typeof fetch

      const transport = createFetchTransport('http://localhost/events', {
        headers: {
          Authorization: 'Bearer token123',
          'X-Custom': 'value',
        },
      })
      await flushAsync(20)

      const headers = capturedInit?.headers as Record<string, string>
      expect(headers?.Authorization).toBe('Bearer token123')
      expect(headers?.['X-Custom']).toBe('value')

      transport.close()
    })

    it('should use the provided method', async () => {
      let capturedInit: RequestInit | undefined

      globalThis.fetch = mock(
        (_input: RequestInfo | URL, init?: RequestInit) => {
          capturedInit = init
          return Promise.resolve(createMockResponse(200, ['data: ok\n\n']))
        },
      ) as typeof fetch

      const transport = createFetchTransport('http://localhost/events', {
        method: 'PUT',
        body: 'raw-data',
      })
      await flushAsync(20)

      expect(capturedInit?.method).toBe('PUT')

      transport.close()
    })

    it('should pass the URL to fetch', async () => {
      let capturedUrl: string | undefined

      globalThis.fetch = mock(
        (input: RequestInfo | URL, _init?: RequestInit) => {
          capturedUrl = String(input)
          return Promise.resolve(createMockResponse(200, ['data: ok\n\n']))
        },
      ) as typeof fetch

      const transport = createFetchTransport('http://localhost:3000/api/events')
      await flushAsync(20)

      expect(capturedUrl).toBe('http://localhost:3000/api/events')

      transport.close()
    })

    it('should pass non-object body as-is (no JSON.stringify)', async () => {
      let capturedInit: RequestInit | undefined

      globalThis.fetch = mock(
        (_input: RequestInfo | URL, init?: RequestInit) => {
          capturedInit = init
          return Promise.resolve(createMockResponse(200, ['data: ok\n\n']))
        },
      ) as typeof fetch

      const rawBody = 'raw string body'
      const transport = createFetchTransport('http://localhost/events', {
        body: rawBody,
      })
      await flushAsync(20)

      expect(capturedInit?.body).toBe(rawBody)

      transport.close()
    })
  })

  describe('lastEventId', () => {
    it('should start as empty string', () => {
      globalThis.fetch = mock(
        () => new Promise<Response>(() => {}),
      ) as typeof fetch

      const transport = createFetchTransport('http://localhost/events')
      expect(transport.lastEventId).toBe('')

      transport.close()
    })

    it('should track id: fields from the SSE stream', async () => {
      globalThis.fetch = mock(() =>
        Promise.resolve(
          createMockResponse(200, [
            'id: 42\ndata: first\n\nid: 99\ndata: second\n\n',
          ]),
        ),
      ) as typeof fetch

      const transport = createFetchTransport('http://localhost/events')
      await flushAsync(50)

      expect(transport.lastEventId).toBe('99')

      transport.close()
    })

    it('should persist across events without new id', async () => {
      globalThis.fetch = mock(() =>
        Promise.resolve(
          createMockResponse(200, ['id: 7\ndata: first\n\ndata: second\n\n']),
        ),
      ) as typeof fetch

      const onmessage = mock(() => {})
      const transport = createFetchTransport('http://localhost/events')
      transport.onmessage = onmessage

      await flushAsync(50)

      // lastEventId should still be "7" from the first event
      expect(transport.lastEventId).toBe('7')

      transport.close()
    })
  })

  describe('onretry', () => {
    it('should call onretry when parser encounters retry: field', async () => {
      globalThis.fetch = mock(() =>
        Promise.resolve(
          createMockResponse(200, ['retry: 3000\ndata: test\n\n']),
        ),
      ) as typeof fetch

      const onretry = mock(() => {})
      const transport = createFetchTransport('http://localhost/events')
      transport.onretry = onretry

      await flushAsync(50)

      expect(onretry).toHaveBeenCalledTimes(1)
      expect(onretry).toHaveBeenCalledWith(3000)

      transport.close()
    })
  })

  describe('no internal reconnection', () => {
    it('should NOT reconnect after stream ends', async () => {
      let fetchCount = 0

      globalThis.fetch = mock(() => {
        fetchCount++
        return Promise.resolve(createMockResponse(200, ['data: done\n\n']))
      }) as typeof fetch

      const transport = createFetchTransport('http://localhost/events')
      await flushAsync(100)

      expect(fetchCount).toBe(1)

      transport.close()
    })

    it('should NOT reconnect after error', async () => {
      let fetchCount = 0

      globalThis.fetch = mock(() => {
        fetchCount++
        return Promise.reject(new Error('Network error'))
      }) as typeof fetch

      const transport = createFetchTransport('http://localhost/events')
      await flushAsync(100)

      expect(fetchCount).toBe(1)

      transport.close()
    })
  })
})
