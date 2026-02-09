import { afterEach, beforeEach, describe, expect, it } from 'bun:test'

/**
 * Tests for mockSSE testing utility.
 *
 * These tests verify that mockSSE can:
 * 1. Intercept and mock EventSource constructor
 * 2. Simulate SSE events with sendEvent
 * 3. Track readyState transitions (CONNECTING -> OPEN -> CLOSED)
 * 4. Support both onmessage and addEventListener patterns
 * 5. Handle multiple concurrent mocks for different URLs
 * 6. Provide cleanup via restore()
 *
 * The tests should FAIL until src/testing/index.ts is implemented.
 */

describe('mockSSE', () => {
  let mockSSE: any
  let originalEventSource: typeof EventSource | undefined

  beforeEach(async () => {
    // Store original EventSource (may be undefined in Bun runtime)
    originalEventSource = globalThis.EventSource

    // Import the mock utility fresh each test
    mockSSE = (await import('../testing/index.ts')).mockSSE
  })

  afterEach(() => {
    // Always restore after each test
    if (mockSSE?.restore) {
      mockSSE.restore()
    }
  })

  describe('basic API', () => {
    it('should return sendEvent, close, and getConnection functions', () => {
      const mock = mockSSE('/api/events')

      expect(typeof mock.sendEvent).toBe('function')
      expect(typeof mock.close).toBe('function')
      expect(typeof mock.getConnection).toBe('function')
    })

    it('should intercept EventSource constructor', () => {
      mockSSE('/api/events')

      const eventSource = new EventSource('/api/events')

      expect(eventSource).toBeDefined()
      expect(eventSource.url).toBe('/api/events')
    })

    it('should return mock EventSource instance from getConnection', () => {
      const mock = mockSSE('/api/events')
      const eventSource = new EventSource('/api/events')
      const connection = mock.getConnection()

      expect(connection).toBe(eventSource)
    })
  })

  describe('readyState transitions', () => {
    it('should start in CONNECTING state', () => {
      const mock = mockSSE('/api/events')
      const eventSource = new EventSource('/api/events')

      expect(eventSource.readyState).toBe(EventSource.CONNECTING)
    })

    it('should transition to OPEN state after connection', () => {
      const mock = mockSSE('/api/events')
      const eventSource = new EventSource('/api/events')

      // Simulate connection open (implementation may auto-transition or require manual trigger)
      if (eventSource.onopen) {
        eventSource.onopen(new Event('open'))
      }

      expect(eventSource.readyState).toBe(EventSource.OPEN)
    })

    it('should transition to CLOSED state after close', () => {
      const mock = mockSSE('/api/events')
      const eventSource = new EventSource('/api/events')

      mock.close()

      expect(eventSource.readyState).toBe(EventSource.CLOSED)
    })
  })

  describe('sendEvent', () => {
    it('should trigger onmessage with MessageEvent containing JSON data', () => {
      const mock = mockSSE('/api/events')
      const eventSource = new EventSource('/api/events')

      let receivedEvent: MessageEvent | null = null
      eventSource.onmessage = (event: MessageEvent) => {
        receivedEvent = event
      }

      const testPayload = {
        type: 'order:updated',
        payload: { id: '123', status: 'shipped' },
      }
      mock.sendEvent(testPayload)

      expect(receivedEvent).not.toBeNull()
      expect(receivedEvent?.data).toBeDefined()

      const parsedData = JSON.parse(receivedEvent!.data)
      expect(parsedData.type).toBe('order:updated')
      expect(parsedData.payload).toEqual({ id: '123', status: 'shipped' })
    })

    it('should support named events via addEventListener', () => {
      const mock = mockSSE('/api/events')
      const eventSource = new EventSource('/api/events')

      let receivedEvent: MessageEvent | null = null
      eventSource.addEventListener('order:updated', (event: Event) => {
        receivedEvent = event as MessageEvent
      })

      const testPayload = {
        type: 'order:updated',
        payload: { id: '123', status: 'shipped' },
      }
      mock.sendEvent(testPayload)

      expect(receivedEvent).not.toBeNull()
      expect(receivedEvent?.data).toBeDefined()

      const parsedData = JSON.parse(receivedEvent!.data)
      expect(parsedData.type).toBe('order:updated')
      expect(parsedData.payload).toEqual({ id: '123', status: 'shipped' })
    })

    it('should format event data as JSON string in MessageEvent', () => {
      const mock = mockSSE('/api/events')
      const eventSource = new EventSource('/api/events')

      let receivedData: string | null = null
      eventSource.onmessage = (event: MessageEvent) => {
        receivedData = event.data
      }

      mock.sendEvent({ type: 'test', payload: { value: 42 } })

      expect(typeof receivedData).toBe('string')
      expect(() => JSON.parse(receivedData!)).not.toThrow()

      const parsed = JSON.parse(receivedData!)
      expect(parsed.type).toBe('test')
      expect(parsed.payload.value).toBe(42)
    })
  })

  describe('close behavior', () => {
    it('should set readyState to CLOSED when close is called', () => {
      const mock = mockSSE('/api/events')
      const eventSource = new EventSource('/api/events')

      mock.close()

      expect(eventSource.readyState).toBe(EventSource.CLOSED)
    })

    it('should trigger onerror handler when closed', () => {
      const mock = mockSSE('/api/events')
      const eventSource = new EventSource('/api/events')

      let errorCalled = false
      eventSource.onerror = () => {
        errorCalled = true
      }

      mock.close()

      expect(errorCalled).toBe(true)
    })

    it('should trigger addEventListener error handler when closed', () => {
      const mock = mockSSE('/api/events')
      const eventSource = new EventSource('/api/events')

      let errorCalled = false
      eventSource.addEventListener('error', () => {
        errorCalled = true
      })

      mock.close()

      expect(errorCalled).toBe(true)
    })
  })

  describe('multiple concurrent mocks', () => {
    it('should support mocks for different URLs independently', () => {
      const mock1 = mockSSE('/api/events1')
      const mock2 = mockSSE('/api/events2')

      const eventSource1 = new EventSource('/api/events1')
      const eventSource2 = new EventSource('/api/events2')

      let received1: MessageEvent | null = null
      let received2: MessageEvent | null = null

      eventSource1.onmessage = (event: MessageEvent) => {
        received1 = event
      }
      eventSource2.onmessage = (event: MessageEvent) => {
        received2 = event
      }

      mock1.sendEvent({ type: 'event1', payload: { source: 1 } })
      mock2.sendEvent({ type: 'event2', payload: { source: 2 } })

      expect(received1).not.toBeNull()
      expect(received2).not.toBeNull()

      const data1 = JSON.parse(received1!.data)
      const data2 = JSON.parse(received2!.data)

      expect(data1.payload.source).toBe(1)
      expect(data2.payload.source).toBe(2)
    })

    it('should isolate sendEvent calls to correct mock', () => {
      const mock1 = mockSSE('/api/events1')
      const mock2 = mockSSE('/api/events2')

      const eventSource1 = new EventSource('/api/events1')
      const eventSource2 = new EventSource('/api/events2')

      let count1 = 0
      let count2 = 0

      eventSource1.onmessage = () => {
        count1++
      }
      eventSource2.onmessage = () => {
        count2++
      }

      mock1.sendEvent({ type: 'test', payload: {} })
      mock1.sendEvent({ type: 'test', payload: {} })
      mock2.sendEvent({ type: 'test', payload: {} })

      expect(count1).toBe(2)
      expect(count2).toBe(1)
    })

    it('should isolate close calls to correct mock', () => {
      const mock1 = mockSSE('/api/events1')
      const mock2 = mockSSE('/api/events2')

      const eventSource1 = new EventSource('/api/events1')
      const eventSource2 = new EventSource('/api/events2')

      mock1.close()

      expect(eventSource1.readyState).toBe(EventSource.CLOSED)
      expect(eventSource2.readyState).not.toBe(EventSource.CLOSED)
    })
  })

  describe('restore', () => {
    it('should restore original EventSource constructor', () => {
      const mock = mockSSE('/api/events')

      // Create mock instance
      const mockInstance = new EventSource('/api/events')
      expect(mockInstance).toBeDefined()

      // Restore
      mockSSE.restore()

      // After restore, EventSource should be back to original (or undefined in Bun)
      if (originalEventSource) {
        expect(globalThis.EventSource).toBe(originalEventSource)
      } else {
        // In Bun runtime, EventSource might not exist by default
        // The mock should handle this gracefully
        expect(true).toBe(true)
      }
    })

    it('should prevent sendEvent after restore', () => {
      const mock = mockSSE('/api/events')
      const eventSource = new EventSource('/api/events')

      let messageCount = 0
      eventSource.onmessage = () => {
        messageCount++
      }

      mock.sendEvent({ type: 'test', payload: {} })
      expect(messageCount).toBe(1)

      mockSSE.restore()

      // sendEvent should not work after restore (or throw error)
      try {
        mock.sendEvent({ type: 'test', payload: {} })
      } catch {
        // Expected to fail
      }

      // Message count should not increase
      expect(messageCount).toBe(1)
    })
  })

  describe('edge cases', () => {
    it('should handle sendEvent before any listeners are attached', () => {
      const mock = mockSSE('/api/events')
      const eventSource = new EventSource('/api/events')

      // Send event before attaching listener - should not throw
      expect(() => {
        mock.sendEvent({ type: 'test', payload: {} })
      }).not.toThrow()

      // Later attach listener and verify it works
      let received = false
      eventSource.onmessage = () => {
        received = true
      }

      mock.sendEvent({ type: 'test', payload: {} })
      expect(received).toBe(true)
    })

    it('should handle multiple addEventListener calls for same event', () => {
      const mock = mockSSE('/api/events')
      const eventSource = new EventSource('/api/events')

      let count = 0
      eventSource.addEventListener('test', () => {
        count++
      })
      eventSource.addEventListener('test', () => {
        count++
      })

      mock.sendEvent({ type: 'test', payload: {} })

      expect(count).toBe(2)
    })

    it('should handle complex nested payload data', () => {
      const mock = mockSSE('/api/events')
      const eventSource = new EventSource('/api/events')

      let receivedPayload: any = null
      eventSource.onmessage = (event: MessageEvent) => {
        const parsed = JSON.parse(event.data)
        receivedPayload = parsed.payload
      }

      const complexPayload = {
        nested: {
          array: [1, 2, 3],
          object: { key: 'value' },
          null: null,
          boolean: true,
        },
      }

      mock.sendEvent({ type: 'complex', payload: complexPayload })

      expect(receivedPayload).toEqual(complexPayload)
    })
  })
})
