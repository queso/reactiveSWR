import { afterEach, beforeEach, describe, expect, it } from 'bun:test'

/**
 * Tests for mockSSE latency simulation via setLatency().
 *
 * These tests verify that:
 * 1. setLatency(ms) exists on MockSSEControls
 * 2. sendEvent is delayed by the specified duration
 * 3. sendRaw is delayed by the specified duration
 * 4. sendSSE is delayed by the specified duration
 * 5. setLatency(0) disables the delay (resets latency)
 * 6. Latency does not affect close() or getConnection()
 * 7. Latency is independent between separate mockSSE instances
 */

describe('mockSSE setLatency()', () => {
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
    if (globalThis.fetch !== originalFetch) {
      globalThis.fetch = originalFetch
    }
  })

  describe('method existence', () => {
    it('should expose setLatency on the controls object', () => {
      const mock = mockSSE('/api/events')

      expect(mock.setLatency).toBeDefined()
      expect(typeof mock.setLatency).toBe('function')
    })

    it('should expose resetLatency on the controls object', () => {
      const mock = mockSSE('/api/events')

      expect(mock.resetLatency).toBeDefined()
      expect(typeof mock.resetLatency).toBe('function')
    })

    it('MockSSEControls should include setLatency (runtime check)', () => {
      const controls: import('../testing/index.ts').MockSSEControls =
        mockSSE('/api/events')

      expect('setLatency' in controls).toBe(true)
    })

    it('MockSSEControls should include resetLatency (runtime check)', () => {
      const controls: import('../testing/index.ts').MockSSEControls =
        mockSSE('/api/events')

      expect('resetLatency' in controls).toBe(true)
    })
  })

  describe('sendEvent delay', () => {
    it('should delay sendEvent by roughly the specified milliseconds', async () => {
      const mock = mockSSE('/api/events')
      const es = new EventSource('/api/events')

      let received = false
      es.onmessage = () => {
        received = true
      }

      mock.setLatency(50)

      const start = Date.now()
      const promise = mock.sendEvent({ type: 'test', payload: {} })

      // Event should NOT have arrived yet (we haven't awaited the promise)
      expect(received).toBe(false)

      await promise
      const elapsed = Date.now() - start

      expect(received).toBe(true)
      expect(elapsed).toBeGreaterThanOrEqual(40)
    })

    it('should not delay sendEvent when latency is 0', async () => {
      const mock = mockSSE('/api/events')
      const es = new EventSource('/api/events')

      let received = false
      es.onmessage = () => {
        received = true
      }

      mock.setLatency(0)

      const start = Date.now()
      await mock.sendEvent({ type: 'test', payload: {} })
      const elapsed = Date.now() - start

      expect(received).toBe(true)
      expect(elapsed).toBeLessThan(20)
    })

    it('should deliver the correct event data after delay', async () => {
      const mock = mockSSE('/api/events')
      const es = new EventSource('/api/events')

      let receivedData: Record<string, unknown> | null = null
      es.onmessage = (event: MessageEvent) => {
        receivedData = JSON.parse(event.data)
      }

      mock.setLatency(30)
      await mock.sendEvent({ type: 'delayed', payload: { value: 99 } })

      expect(receivedData).not.toBeNull()
      expect(receivedData?.type).toBe('delayed')
      expect((receivedData?.payload as Record<string, unknown>)?.value).toBe(99)
    })
  })

  describe('sendRaw delay', () => {
    it('should delay sendRaw by roughly the specified milliseconds', async () => {
      const mock = mockSSE('/api/stream')

      const response = await fetch('/api/stream')
      const reader = response.body?.getReader()
      const decoder = new TextDecoder()

      expect(reader).toBeDefined()
      if (!reader) throw new Error('Expected reader to be defined')

      mock.setLatency(50)

      const start = Date.now()
      const promise = mock.sendRaw('data: hello\n\n')

      await promise
      const elapsed = Date.now() - start

      const { value } = await reader.read()
      expect(decoder.decode(value)).toBe('data: hello\n\n')
      expect(elapsed).toBeGreaterThanOrEqual(40)

      reader.cancel()
    })
  })

  describe('sendSSE delay', () => {
    it('should delay sendSSE by roughly the specified milliseconds', async () => {
      const mock = mockSSE('/api/stream')

      const response = await fetch('/api/stream')
      const reader = response.body?.getReader()
      const decoder = new TextDecoder()

      expect(reader).toBeDefined()
      if (!reader) throw new Error('Expected reader to be defined')

      mock.setLatency(50)

      const start = Date.now()
      await mock.sendSSE({ id: 7 })
      const elapsed = Date.now() - start

      const { value } = await reader.read()
      expect(decoder.decode(value)).toBe('data: {"id":7}\n\n')
      expect(elapsed).toBeGreaterThanOrEqual(40)

      reader.cancel()
    })
  })

  describe('resetting latency', () => {
    it('should stop delaying after setLatency(0) is called', async () => {
      const mock = mockSSE('/api/events')
      const es = new EventSource('/api/events')

      let count = 0
      es.onmessage = () => {
        count++
      }

      // Set a non-trivial latency then immediately reset it via setLatency(0)
      mock.setLatency(200)
      mock.setLatency(0)

      const start = Date.now()
      await mock.sendEvent({ type: 'test', payload: {} })
      const elapsed = Date.now() - start

      expect(count).toBe(1)
      expect(elapsed).toBeLessThan(50)
    })

    it('should stop delaying after resetLatency() is called', async () => {
      const mock = mockSSE('/api/events')
      const es = new EventSource('/api/events')

      let count = 0
      es.onmessage = () => {
        count++
      }

      // Set a non-trivial latency then reset it via resetLatency()
      mock.setLatency(200)
      mock.resetLatency()

      const start = Date.now()
      await mock.sendEvent({ type: 'test', payload: {} })
      const elapsed = Date.now() - start

      expect(count).toBe(1)
      expect(elapsed).toBeLessThan(50)
    })

    it('should apply the most recently set latency value', async () => {
      const mock = mockSSE('/api/events')
      const es = new EventSource('/api/events')

      let received = false
      es.onmessage = () => {
        received = true
      }

      mock.setLatency(100)
      mock.setLatency(30)

      const start = Date.now()
      await mock.sendEvent({ type: 'test', payload: {} })
      const elapsed = Date.now() - start

      expect(received).toBe(true)
      // Should be close to 30ms, not 100ms
      expect(elapsed).toBeLessThan(90)
      expect(elapsed).toBeGreaterThanOrEqual(20)
    })
  })

  describe('latency does not affect other controls', () => {
    it('close() should work immediately regardless of latency setting', () => {
      const mock = mockSSE('/api/events')
      const es = new EventSource('/api/events')

      mock.setLatency(5000)

      // close() is synchronous and should not be delayed
      const start = Date.now()
      mock.close()
      const elapsed = Date.now() - start

      expect(es.readyState).toBe(EventSource.CLOSED)
      expect(elapsed).toBeLessThan(50)
    })

    it('getConnection() should work immediately regardless of latency setting', () => {
      const mock = mockSSE('/api/events')
      const es = new EventSource('/api/events')

      mock.setLatency(5000)

      const connection = mock.getConnection()
      expect(connection).toBe(es)
    })
  })

  describe('latency isolation between instances', () => {
    it('should not share latency state between different mockSSE instances', async () => {
      const mock1 = mockSSE('/api/events1')
      const mock2 = mockSSE('/api/events2')

      const es1 = new EventSource('/api/events1')
      const es2 = new EventSource('/api/events2')

      let count1 = 0
      let count2 = 0
      es1.onmessage = () => count1++
      es2.onmessage = () => count2++

      mock1.setLatency(100)
      // mock2 has no latency

      // mock2 should resolve quickly without waiting for mock1's latency
      const start = Date.now()
      await mock2.sendEvent({ type: 'test', payload: {} })
      const elapsed = Date.now() - start

      expect(count2).toBe(1)
      expect(elapsed).toBeLessThan(50)

      // mock1 should still apply its own latency
      await mock1.sendEvent({ type: 'test', payload: {} })
      expect(count1).toBe(1)
    })

    it('setting latency on one instance should not affect another', async () => {
      const mock1 = mockSSE('/api/eventsA')
      const mock2 = mockSSE('/api/eventsB')

      mock1.setLatency(500)

      // mock2 should be unaffected
      const es2 = new EventSource('/api/eventsB')
      let received2 = false
      es2.onmessage = () => {
        received2 = true
      }

      const start = Date.now()
      await mock2.sendEvent({ type: 'fast', payload: {} })
      const elapsed = Date.now() - start

      expect(received2).toBe(true)
      expect(elapsed).toBeLessThan(50)
    })
  })
})
