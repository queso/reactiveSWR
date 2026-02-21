import { afterEach, beforeEach, describe, expect, it } from 'bun:test'

/**
 * Tests for mockSSE.sendSSE() convenience method.
 *
 * These tests verify that the new sendSSE(data) method:
 * 1. Exists on MockSSEControls
 * 2. Sends the correct SSE wire format: `data: <json>\n\n`
 * 3. Works with objects, arrays, strings, numbers, and null
 * 4. Does not break existing sendEvent() and sendRaw() methods
 * 5. Works with fetch-based transports
 *
 * Tests FAIL initially because sendSSE has not been implemented yet.
 */

describe('mockSSE.sendSSE()', () => {
  // biome-ignore lint/suspicious/noExplicitAny: dynamically imported testing utility
  let mockSSE: any
  let originalFetch: typeof globalThis.fetch

  beforeEach(async () => {
    originalFetch = globalThis.fetch
    // Always re-import to get a fresh module state
    mockSSE = (await import('../testing/index.ts')).mockSSE
  })

  afterEach(() => {
    if (mockSSE?.restore) {
      mockSSE.restore()
    }
    if (globalThis.fetch !== originalFetch) {
      globalThis.fetch = originalFetch
    }
  })

  describe('Req #31 - method existence on MockSSEControls', () => {
    it('sendSSE should exist on the controls object returned by mockSSE()', () => {
      const controls = mockSSE('/api/events')

      expect(controls.sendSSE).toBeDefined()
      expect(typeof controls.sendSSE).toBe('function')
    })

    it('MockSSEControls type should include sendSSE (runtime check)', () => {
      const controls: import('../testing/index.ts').MockSSEControls =
        mockSSE('/api/events')

      // Type-level: MockSSEControls must have sendSSE
      expect('sendSSE' in controls).toBe(true)
    })
  })

  describe('Req #32 - correct SSE wire format via fetch stream', () => {
    it('sendSSE(object) should enqueue `data: <json>\\n\\n` to fetch stream', async () => {
      const mock = mockSSE('/api/events')

      const chunks: string[] = []
      const decoder = new TextDecoder()

      const response = await fetch('/api/events')
      const reader = response.body?.getReader()

      // Send via sendSSE
      mock.sendSSE({ type: 'test', value: 42 })

      const { value } = await reader.read()
      chunks.push(decoder.decode(value))

      reader.cancel()

      expect(chunks[0]).toBe('data: {"type":"test","value":42}\n\n')
    })

    it('sendSSE should produce the same wire format as sendRaw would manually', async () => {
      const url = '/api/events-compare'
      const mockA = mockSSE(url)

      const chunksSSE: string[] = []
      const decoder = new TextDecoder()

      const response = await fetch(url)
      const reader = response.body?.getReader()

      const data = { id: 1, name: 'alice' }
      mockA.sendSSE(data)

      const { value } = await reader.read()
      chunksSSE.push(decoder.decode(value))

      reader.cancel()

      const expected = `data: ${JSON.stringify(data)}\n\n`
      expect(chunksSSE[0]).toBe(expected)
    })
  })

  describe('Req #32 - various data types', () => {
    async function captureSendSSE(data: unknown): Promise<string> {
      const url = `/api/events-type-${Math.random()}`
      const mock = mockSSE(url)
      const decoder = new TextDecoder()

      const response = await fetch(url)
      const reader = response.body?.getReader()

      mock.sendSSE(data)

      const { value } = await reader.read()
      const text = decoder.decode(value)
      reader.cancel()
      return text
    }

    it('should correctly encode a plain object', async () => {
      const result = await captureSendSSE({ foo: 'bar', count: 3 })
      expect(result).toBe('data: {"foo":"bar","count":3}\n\n')
    })

    it('should correctly encode an array', async () => {
      const result = await captureSendSSE([1, 2, 3])
      expect(result).toBe('data: [1,2,3]\n\n')
    })

    it('should correctly encode a string', async () => {
      const result = await captureSendSSE('hello world')
      expect(result).toBe('data: "hello world"\n\n')
    })

    it('should correctly encode a number', async () => {
      const result = await captureSendSSE(99)
      expect(result).toBe('data: 99\n\n')
    })

    it('should correctly encode null', async () => {
      const result = await captureSendSSE(null)
      expect(result).toBe('data: null\n\n')
    })

    it('should correctly encode a boolean true', async () => {
      const result = await captureSendSSE(true)
      expect(result).toBe('data: true\n\n')
    })

    it('should correctly encode a nested object', async () => {
      const result = await captureSendSSE({ user: { id: 7, roles: ['admin'] } })
      expect(result).toBe('data: {"user":{"id":7,"roles":["admin"]}}\n\n')
    })
  })

  describe('Req #33 - no breaking changes to existing methods', () => {
    it('sendEvent() should still work after sendSSE is added', () => {
      const mock = mockSSE('/api/events')
      const es = new EventSource('/api/events')

      let received: MessageEvent | null = null
      es.onmessage = (event: MessageEvent) => {
        received = event
      }

      // sendEvent should still work
      mock.sendEvent({ type: 'user.updated', payload: { id: 1 } })

      expect(received).not.toBeNull()
      const parsed = JSON.parse((received as MessageEvent).data)
      expect(parsed.type).toBe('user.updated')
      expect(parsed.payload).toEqual({ id: 1 })
    })

    it('sendRaw() should still work after sendSSE is added', async () => {
      const mock = mockSSE('/api/events')
      const decoder = new TextDecoder()

      const response = await fetch('/api/events')
      const reader = response.body?.getReader()

      const rawText = 'data: raw line\n\n'
      mock.sendRaw(rawText)

      const { value } = await reader.read()
      const text = decoder.decode(value)
      reader.cancel()

      expect(text).toBe(rawText)
    })

    it('close() should still work after sendSSE is added', () => {
      const mock = mockSSE('/api/events')
      const es = new EventSource('/api/events')

      mock.close()

      expect(es.readyState).toBe(EventSource.CLOSED)
    })

    it('getConnection() should still work after sendSSE is added', () => {
      const mock = mockSSE('/api/events')
      const es = new EventSource('/api/events')

      expect(mock.getConnection()).toBe(es)
    })

    it('mockSSE.restore() should still work after sendSSE is added', () => {
      mockSSE('/api/events')

      expect(() => {
        mockSSE.restore()
      }).not.toThrow()
    })
  })

  describe('sendSSE with EventSource transport', () => {
    it('sendSSE should not throw when only an EventSource connection exists (no fetch stream)', () => {
      const mock = mockSSE('/api/events')
      // Open via EventSource, not fetch
      new EventSource('/api/events')

      // sendSSE delegates to sendRaw which targets fetch streams;
      // if no fetch stream exists it should silently no-op, not throw
      expect(() => {
        mock.sendSSE({ type: 'ping', value: 1 })
      }).not.toThrow()
    })
  })

  describe('sendSSE called multiple times', () => {
    it('should deliver each call as a separate SSE chunk', async () => {
      const mock = mockSSE('/api/events')
      const decoder = new TextDecoder()

      const response = await fetch('/api/events')
      const reader = response.body?.getReader()

      mock.sendSSE({ seq: 1 })
      mock.sendSSE({ seq: 2 })

      const first = await reader.read()
      const second = await reader.read()

      reader.cancel()

      expect(decoder.decode(first.value)).toBe('data: {"seq":1}\n\n')
      expect(decoder.decode(second.value)).toBe('data: {"seq":2}\n\n')
    })
  })
})
