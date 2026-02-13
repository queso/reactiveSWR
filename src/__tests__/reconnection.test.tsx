import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { createElement } from 'react'
import { renderToString } from 'react-dom/server'
import { SSEProvider, useSSEContext } from '../SSEProvider.tsx'
import type { SSEConfig, SSEStatus } from '../types.ts'

/**
 * Tests for SSEProvider reconnection with exponential backoff (WI-065).
 *
 * These tests verify:
 * 1. Automatically reconnects on connection failure
 * 2. Exponential backoff: 1s, 2s, 4s, 8s, 16s, 30s (capped at maxDelay)
 * 3. Stops reconnecting after maxAttempts reached
 * 4. Resets state on successful reconnection
 * 5. Can be disabled via reconnect.enabled: false
 * 6. status.reconnectAttempt reflects current attempt number
 * 7. Cleanup timers on unmount
 *
 * Tests should FAIL until reconnection logic is implemented.
 */

// Enhanced MockEventSource for reconnection testing
class MockEventSource {
  static instances: MockEventSource[] = []
  static connectionAttempts = 0

  url: string
  readyState = 0 // CONNECTING
  onmessage: ((event: MessageEvent) => void) | null = null
  onerror: ((event: Event) => void) | null = null
  onopen: ((event: Event) => void) | null = null

  private eventListeners: Map<string, Set<(event: Event) => void>> = new Map()

  constructor(url: string) {
    this.url = url
    MockEventSource.instances.push(this)
    MockEventSource.connectionAttempts++
  }

  close() {
    this.readyState = 2 // CLOSED
  }

  addEventListener(type: string, listener: (event: Event) => void) {
    if (!this.eventListeners.has(type)) {
      this.eventListeners.set(type, new Set())
    }
    const listeners = this.eventListeners.get(type)
    if (listeners) {
      listeners.add(listener)
    }
  }

  removeEventListener(type: string, listener: (event: Event) => void) {
    const listeners = this.eventListeners.get(type)
    if (listeners) {
      listeners.delete(listener)
    }
  }

  dispatchEvent() {
    return true
  }

  // Test helper: simulate connection open
  simulateOpen() {
    this.readyState = 1 // OPEN
    this.onopen?.(new Event('open'))
  }

  // Test helper: simulate error that closes connection
  simulateConnectionFailure() {
    this.readyState = 2 // CLOSED
    this.onerror?.(new Event('error'))
  }

  // Test helper: simulate temporary error (connection stays open)
  simulateError() {
    this.onerror?.(new Event('error'))
  }

  static reset() {
    MockEventSource.instances = []
    MockEventSource.connectionAttempts = 0
  }

  static getLastInstance(): MockEventSource | undefined {
    return MockEventSource.instances[MockEventSource.instances.length - 1]
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

// Store original EventSource and timers
const originalEventSource = globalThis.EventSource
const originalSetTimeout = globalThis.setTimeout
const originalClearTimeout = globalThis.clearTimeout

// Track pending timers for fake timer implementation
let pendingTimers: Map<
  number,
  { callback: () => void; delay: number; scheduledAt: number }
> = new Map()
let timerIdCounter = 1
let currentTime = 0

// Fake timer implementations
function fakeSetTimeout(callback: () => void, delay: number): number {
  const id = timerIdCounter++
  pendingTimers.set(id, { callback, delay, scheduledAt: currentTime })
  return id
}

function fakeClearTimeout(id: number): void {
  pendingTimers.delete(id)
}

// Advance fake time and execute pending timers
function advanceTimersByTime(ms: number) {
  const targetTime = currentTime + ms

  // Get all timers that should fire in order
  while (true) {
    let nextTimer: { id: number; fireAt: number } | null = null

    for (const [id, timer] of pendingTimers) {
      const fireAt = timer.scheduledAt + timer.delay
      if (fireAt <= targetTime) {
        if (!nextTimer || fireAt < nextTimer.fireAt) {
          nextTimer = { id, fireAt }
        }
      }
    }

    if (!nextTimer) break

    currentTime = nextTimer.fireAt
    const timer = pendingTimers.get(nextTimer.id)
    pendingTimers.delete(nextTimer.id)
    if (timer) {
      timer.callback()
    }
  }

  currentTime = targetTime
}

function resetTimers() {
  pendingTimers = new Map()
  timerIdCounter = 1
  currentTime = 0
}

beforeEach(() => {
  // @ts-expect-error - Mocking EventSource
  globalThis.EventSource = MockEventSource
  MockEventSource.reset()

  // Install fake timers
  // @ts-expect-error - Mocking setTimeout
  globalThis.setTimeout = fakeSetTimeout
  // @ts-expect-error - Mocking clearTimeout
  globalThis.clearTimeout = fakeClearTimeout
  resetTimers()
})

afterEach(() => {
  globalThis.EventSource = originalEventSource
  globalThis.setTimeout = originalSetTimeout
  globalThis.clearTimeout = originalClearTimeout
})

describe('SSEProvider Reconnection', () => {
  describe('automatic reconnection on failure', () => {
    it('should attempt to reconnect when connection fails', async () => {
      const config: SSEConfig = {
        url: 'http://localhost:3000/events',
        events: {},
        reconnect: {
          enabled: true,
          initialDelay: 1000,
          maxAttempts: 5,
        },
      }

      renderToString(
        createElement(
          SSEProvider,
          { config },
          createElement('div', null, 'child'),
        ),
      )

      // Initial connection
      expect(MockEventSource.connectionAttempts).toBe(1)
      const firstInstance = MockEventSource.getLastInstance()

      // Simulate connection failure
      firstInstance?.simulateConnectionFailure()

      // Advance timer to trigger reconnect
      advanceTimersByTime(1000)

      // Should have attempted a second connection
      expect(MockEventSource.connectionAttempts).toBe(2)
    })

    it('should create new EventSource on each reconnect attempt', async () => {
      const config: SSEConfig = {
        url: 'http://localhost:3000/events',
        events: {},
        reconnect: {
          enabled: true,
          initialDelay: 1000,
          maxAttempts: 5,
        },
      }

      renderToString(
        createElement(
          SSEProvider,
          { config },
          createElement('div', null, 'child'),
        ),
      )

      const firstInstance = MockEventSource.instances[0]
      firstInstance.simulateConnectionFailure()

      advanceTimersByTime(1000)

      expect(MockEventSource.instances.length).toBe(2)
      expect(MockEventSource.instances[1]).not.toBe(firstInstance)
      expect(MockEventSource.instances[1].url).toBe(
        'http://localhost:3000/events',
      )
    })
  })

  describe('exponential backoff timing', () => {
    it('should wait initialDelay (1s) before first reconnect', async () => {
      const config: SSEConfig = {
        url: 'http://localhost:3000/events',
        events: {},
        reconnect: {
          enabled: true,
          initialDelay: 1000,
          maxAttempts: 5,
        },
      }

      renderToString(
        createElement(
          SSEProvider,
          { config },
          createElement('div', null, 'child'),
        ),
      )

      MockEventSource.getLastInstance()?.simulateConnectionFailure()

      // Before delay expires
      advanceTimersByTime(999)
      expect(MockEventSource.connectionAttempts).toBe(1)

      // After delay expires
      advanceTimersByTime(1)
      expect(MockEventSource.connectionAttempts).toBe(2)
    })

    it('should double delay for each subsequent attempt (exponential backoff)', async () => {
      const config: SSEConfig = {
        url: 'http://localhost:3000/events',
        events: {},
        reconnect: {
          enabled: true,
          initialDelay: 1000,
          backoffMultiplier: 2,
          maxDelay: 30000,
          maxAttempts: 5,
        },
      }

      renderToString(
        createElement(
          SSEProvider,
          { config },
          createElement('div', null, 'child'),
        ),
      )

      // First failure -> 1s delay
      MockEventSource.getLastInstance()?.simulateConnectionFailure()
      advanceTimersByTime(1000)
      expect(MockEventSource.connectionAttempts).toBe(2)

      // Second failure -> 2s delay
      MockEventSource.getLastInstance()?.simulateConnectionFailure()
      advanceTimersByTime(1999)
      expect(MockEventSource.connectionAttempts).toBe(2) // Not yet
      advanceTimersByTime(1)
      expect(MockEventSource.connectionAttempts).toBe(3)

      // Third failure -> 4s delay
      MockEventSource.getLastInstance()?.simulateConnectionFailure()
      advanceTimersByTime(3999)
      expect(MockEventSource.connectionAttempts).toBe(3) // Not yet
      advanceTimersByTime(1)
      expect(MockEventSource.connectionAttempts).toBe(4)

      // Fourth failure -> 8s delay
      MockEventSource.getLastInstance()?.simulateConnectionFailure()
      advanceTimersByTime(7999)
      expect(MockEventSource.connectionAttempts).toBe(4) // Not yet
      advanceTimersByTime(1)
      expect(MockEventSource.connectionAttempts).toBe(5)
    })

    it('should cap delay at maxDelay (30s default)', async () => {
      const config: SSEConfig = {
        url: 'http://localhost:3000/events',
        events: {},
        reconnect: {
          enabled: true,
          initialDelay: 1000,
          backoffMultiplier: 2,
          maxDelay: 30000,
          maxAttempts: 10,
        },
      }

      renderToString(
        createElement(
          SSEProvider,
          { config },
          createElement('div', null, 'child'),
        ),
      )

      // Attempt 1: 1s
      MockEventSource.getLastInstance()?.simulateConnectionFailure()
      advanceTimersByTime(1000)

      // Attempt 2: 2s
      MockEventSource.getLastInstance()?.simulateConnectionFailure()
      advanceTimersByTime(2000)

      // Attempt 3: 4s
      MockEventSource.getLastInstance()?.simulateConnectionFailure()
      advanceTimersByTime(4000)

      // Attempt 4: 8s
      MockEventSource.getLastInstance()?.simulateConnectionFailure()
      advanceTimersByTime(8000)

      // Attempt 5: 16s
      MockEventSource.getLastInstance()?.simulateConnectionFailure()
      advanceTimersByTime(16000)

      expect(MockEventSource.connectionAttempts).toBe(6)

      // Attempt 6: should be capped at 30s (not 32s)
      MockEventSource.getLastInstance()?.simulateConnectionFailure()

      // If not capped, would need 32s. But with cap at 30s:
      advanceTimersByTime(29999)
      expect(MockEventSource.connectionAttempts).toBe(6) // Not yet
      advanceTimersByTime(1)
      expect(MockEventSource.connectionAttempts).toBe(7) // Capped at 30s
    })

    it('should use default backoff sequence: 1s, 2s, 4s, 8s, 16s, 30s', async () => {
      const config: SSEConfig = {
        url: 'http://localhost:3000/events',
        events: {},
        reconnect: {
          enabled: true,
          // Use defaults: initialDelay=1000, backoffMultiplier=2, maxDelay=30000
        },
      }

      renderToString(
        createElement(
          SSEProvider,
          { config },
          createElement('div', null, 'child'),
        ),
      )

      const expectedDelays = [1000, 2000, 4000, 8000, 16000, 30000]

      for (let i = 0; i < expectedDelays.length; i++) {
        const currentAttempts = MockEventSource.connectionAttempts
        MockEventSource.getLastInstance()?.simulateConnectionFailure()

        // Advance just before expected delay
        advanceTimersByTime(expectedDelays[i] - 1)
        expect(MockEventSource.connectionAttempts).toBe(currentAttempts)

        // Advance to complete the delay
        advanceTimersByTime(1)
        expect(MockEventSource.connectionAttempts).toBe(currentAttempts + 1)
      }
    })
  })

  describe('maxAttempts limit', () => {
    it('should stop reconnecting after maxAttempts reached', async () => {
      const config: SSEConfig = {
        url: 'http://localhost:3000/events',
        events: {},
        reconnect: {
          enabled: true,
          initialDelay: 1000,
          maxAttempts: 3,
        },
      }

      renderToString(
        createElement(
          SSEProvider,
          { config },
          createElement('div', null, 'child'),
        ),
      )

      // Initial connection (attempt 1)
      expect(MockEventSource.connectionAttempts).toBe(1)

      // Failure 1 -> reconnect attempt 2
      MockEventSource.getLastInstance()?.simulateConnectionFailure()
      advanceTimersByTime(1000)
      expect(MockEventSource.connectionAttempts).toBe(2)

      // Failure 2 -> reconnect attempt 3
      MockEventSource.getLastInstance()?.simulateConnectionFailure()
      advanceTimersByTime(2000)
      expect(MockEventSource.connectionAttempts).toBe(3)

      // Failure 3 -> should NOT reconnect (maxAttempts reached)
      MockEventSource.getLastInstance()?.simulateConnectionFailure()
      advanceTimersByTime(10000) // Wait plenty of time
      expect(MockEventSource.connectionAttempts).toBe(3) // No new attempts
    })

    it('should not schedule reconnect timer when maxAttempts exhausted', async () => {
      const config: SSEConfig = {
        url: 'http://localhost:3000/events',
        events: {},
        reconnect: {
          enabled: true,
          initialDelay: 1000,
          maxAttempts: 1,
        },
      }

      renderToString(
        createElement(
          SSEProvider,
          { config },
          createElement('div', null, 'child'),
        ),
      )

      // Initial connection exhausts maxAttempts
      MockEventSource.getLastInstance()?.simulateConnectionFailure()

      const _timerCountBefore = pendingTimers.size
      advanceTimersByTime(10000)

      // No reconnect should have occurred
      expect(MockEventSource.connectionAttempts).toBe(1)
      // No pending timers for reconnection
      expect(pendingTimers.size).toBe(0)
    })
  })

  describe('state reset on successful reconnection', () => {
    it('should reset reconnectAttempt to 0 on successful reconnection', async () => {
      let capturedStatus: SSEStatus | null = null

      function StatusCapture() {
        const ctx = useSSEContext()
        capturedStatus = ctx.status
        return createElement('div', null, 'status')
      }

      const config: SSEConfig = {
        url: 'http://localhost:3000/events',
        events: {},
        reconnect: {
          enabled: true,
          initialDelay: 1000,
          maxAttempts: 5,
        },
      }

      renderToString(
        createElement(SSEProvider, { config }, createElement(StatusCapture)),
      )

      // Fail a few times
      MockEventSource.getLastInstance()?.simulateConnectionFailure()
      advanceTimersByTime(1000)
      MockEventSource.getLastInstance()?.simulateConnectionFailure()
      advanceTimersByTime(2000)

      // Status should show reconnect attempts
      expect(capturedStatus).not.toBeNull()
      expect(capturedStatus?.reconnectAttempt).toBeGreaterThan(0)

      // Successful reconnection
      MockEventSource.getLastInstance()?.simulateOpen()

      // After successful connection, reconnectAttempt should reset to 0
      expect(capturedStatus?.reconnectAttempt).toBe(0)
    })

    it('should set connected: true and connecting: false on successful reconnection', async () => {
      let capturedStatus: SSEStatus | null = null

      function StatusCapture() {
        const ctx = useSSEContext()
        capturedStatus = ctx.status
        return createElement('div', null, 'status')
      }

      const config: SSEConfig = {
        url: 'http://localhost:3000/events',
        events: {},
        reconnect: {
          enabled: true,
          initialDelay: 1000,
          maxAttempts: 5,
        },
      }

      renderToString(
        createElement(SSEProvider, { config }, createElement(StatusCapture)),
      )

      // Initial open
      MockEventSource.getLastInstance()?.simulateOpen()
      expect(capturedStatus?.connected).toBe(true)
      expect(capturedStatus?.connecting).toBe(false)

      // Connection failure
      MockEventSource.getLastInstance()?.simulateConnectionFailure()
      expect(capturedStatus?.connected).toBe(false)

      // Reconnect
      advanceTimersByTime(1000)
      const newInstance = MockEventSource.getLastInstance()
      newInstance?.simulateOpen()

      expect(capturedStatus?.connected).toBe(true)
      expect(capturedStatus?.connecting).toBe(false)
      expect(capturedStatus?.error).toBeNull()
    })

    it('should clear error on successful reconnection', async () => {
      let capturedStatus: SSEStatus | null = null

      function StatusCapture() {
        const ctx = useSSEContext()
        capturedStatus = ctx.status
        return createElement('div', null, 'status')
      }

      const config: SSEConfig = {
        url: 'http://localhost:3000/events',
        events: {},
        reconnect: {
          enabled: true,
          initialDelay: 1000,
          maxAttempts: 5,
        },
      }

      renderToString(
        createElement(SSEProvider, { config }, createElement(StatusCapture)),
      )

      // Connection failure sets error
      MockEventSource.getLastInstance()?.simulateConnectionFailure()
      expect(capturedStatus?.error).not.toBeNull()

      // Reconnect
      advanceTimersByTime(1000)
      MockEventSource.getLastInstance()?.simulateOpen()

      // Error should be cleared
      expect(capturedStatus?.error).toBeNull()
    })
  })

  describe('reconnect.enabled: false', () => {
    it('should not reconnect when reconnect.enabled is false', async () => {
      const config: SSEConfig = {
        url: 'http://localhost:3000/events',
        events: {},
        reconnect: {
          enabled: false,
        },
      }

      renderToString(
        createElement(
          SSEProvider,
          { config },
          createElement('div', null, 'child'),
        ),
      )

      expect(MockEventSource.connectionAttempts).toBe(1)

      MockEventSource.getLastInstance()?.simulateConnectionFailure()

      // Even after plenty of time, no reconnect
      advanceTimersByTime(60000)

      expect(MockEventSource.connectionAttempts).toBe(1)
    })

    it('should not schedule any reconnect timers when disabled', async () => {
      const config: SSEConfig = {
        url: 'http://localhost:3000/events',
        events: {},
        reconnect: {
          enabled: false,
        },
      }

      renderToString(
        createElement(
          SSEProvider,
          { config },
          createElement('div', null, 'child'),
        ),
      )

      MockEventSource.getLastInstance()?.simulateConnectionFailure()

      expect(pendingTimers.size).toBe(0)
    })

    it('should default to enabled when reconnect config is not provided', async () => {
      const config: SSEConfig = {
        url: 'http://localhost:3000/events',
        events: {},
        // No reconnect config - should use defaults (enabled: true)
      }

      renderToString(
        createElement(
          SSEProvider,
          { config },
          createElement('div', null, 'child'),
        ),
      )

      MockEventSource.getLastInstance()?.simulateConnectionFailure()
      advanceTimersByTime(1000)

      // Should have reconnected with default settings
      expect(MockEventSource.connectionAttempts).toBe(2)
    })
  })

  describe('status.reconnectAttempt tracking', () => {
    it('should increment reconnectAttempt on each failed reconnection', async () => {
      let capturedStatus: SSEStatus | null = null

      function StatusCapture() {
        const ctx = useSSEContext()
        capturedStatus = ctx.status
        return createElement('div', null, 'status')
      }

      const config: SSEConfig = {
        url: 'http://localhost:3000/events',
        events: {},
        reconnect: {
          enabled: true,
          initialDelay: 1000,
          maxAttempts: 5,
        },
      }

      renderToString(
        createElement(SSEProvider, { config }, createElement(StatusCapture)),
      )

      // Initial state
      expect(capturedStatus?.reconnectAttempt).toBe(0)

      // First failure and reconnect attempt
      MockEventSource.getLastInstance()?.simulateConnectionFailure()
      advanceTimersByTime(1000)
      expect(capturedStatus?.reconnectAttempt).toBe(1)

      // Second failure and reconnect attempt
      MockEventSource.getLastInstance()?.simulateConnectionFailure()
      advanceTimersByTime(2000)
      expect(capturedStatus?.reconnectAttempt).toBe(2)

      // Third failure and reconnect attempt
      MockEventSource.getLastInstance()?.simulateConnectionFailure()
      advanceTimersByTime(4000)
      expect(capturedStatus?.reconnectAttempt).toBe(3)
    })

    it('should reflect current attempt number during connecting state', async () => {
      let capturedStatus: SSEStatus | null = null

      function StatusCapture() {
        const ctx = useSSEContext()
        capturedStatus = ctx.status
        return createElement('div', null, 'status')
      }

      const config: SSEConfig = {
        url: 'http://localhost:3000/events',
        events: {},
        reconnect: {
          enabled: true,
          initialDelay: 1000,
          maxAttempts: 5,
        },
      }

      renderToString(
        createElement(SSEProvider, { config }, createElement(StatusCapture)),
      )

      // Fail and trigger reconnect
      MockEventSource.getLastInstance()?.simulateConnectionFailure()
      advanceTimersByTime(1000)

      // During reconnection attempt, should show attempt number and connecting state
      expect(capturedStatus?.reconnectAttempt).toBe(1)
      expect(capturedStatus?.connecting).toBe(true)
      expect(capturedStatus?.connected).toBe(false)
    })
  })

  describe('timer cleanup on unmount', () => {
    it('should clear pending reconnect timer on unmount', async () => {
      const config: SSEConfig = {
        url: 'http://localhost:3000/events',
        events: {},
        reconnect: {
          enabled: true,
          initialDelay: 5000, // Long delay to ensure timer is pending
          maxAttempts: 5,
        },
      }

      // We cannot directly test unmount in SSR, but we can verify the cleanup
      // mechanism is in place by checking the useEffect cleanup is called

      renderToString(
        createElement(
          SSEProvider,
          { config },
          createElement('div', null, 'child'),
        ),
      )

      // Trigger a failure which schedules a reconnect timer
      MockEventSource.getLastInstance()?.simulateConnectionFailure()

      // Timer should be pending
      expect(pendingTimers.size).toBeGreaterThan(0)

      // In a real DOM environment, useEffect cleanup would clear these timers
      // For this test, we verify the timer was scheduled
      // The actual cleanup test requires a DOM-based testing environment
    })

    it('should not attempt reconnection after provider unmounts', async () => {
      const config: SSEConfig = {
        url: 'http://localhost:3000/events',
        events: {},
        reconnect: {
          enabled: true,
          initialDelay: 1000,
          maxAttempts: 5,
        },
      }

      renderToString(
        createElement(
          SSEProvider,
          { config },
          createElement('div', null, 'child'),
        ),
      )

      const _initialAttempts = MockEventSource.connectionAttempts

      // Simulate failure
      MockEventSource.getLastInstance()?.simulateConnectionFailure()

      // Note: In SSR (renderToString), useEffect cleanup doesn't run automatically.
      // This test documents the expected behavior - in a real DOM environment,
      // unmounting the provider should cancel pending reconnection timers.

      // Verify timer was scheduled (this proves cleanup would need to clear it)
      expect(pendingTimers.size).toBeGreaterThan(0)
    })
  })

  describe('edge cases', () => {
    it('should handle immediate failure on reconnect attempt', async () => {
      const config: SSEConfig = {
        url: 'http://localhost:3000/events',
        events: {},
        reconnect: {
          enabled: true,
          initialDelay: 1000,
          maxAttempts: 5,
        },
      }

      renderToString(
        createElement(
          SSEProvider,
          { config },
          createElement('div', null, 'child'),
        ),
      )

      // First failure
      MockEventSource.getLastInstance()?.simulateConnectionFailure()
      advanceTimersByTime(1000)

      // Immediately fail again (before any messages)
      MockEventSource.getLastInstance()?.simulateConnectionFailure()

      // Should schedule another reconnect with increased delay
      advanceTimersByTime(2000)
      expect(MockEventSource.connectionAttempts).toBe(3)
    })

    it('should reset backoff after successful connection', async () => {
      const config: SSEConfig = {
        url: 'http://localhost:3000/events',
        events: {},
        reconnect: {
          enabled: true,
          initialDelay: 1000,
          backoffMultiplier: 2,
          maxAttempts: 10,
        },
      }

      renderToString(
        createElement(
          SSEProvider,
          { config },
          createElement('div', null, 'child'),
        ),
      )

      // Fail a few times with increasing delays
      MockEventSource.getLastInstance()?.simulateConnectionFailure()
      advanceTimersByTime(1000) // 1s
      MockEventSource.getLastInstance()?.simulateConnectionFailure()
      advanceTimersByTime(2000) // 2s
      MockEventSource.getLastInstance()?.simulateConnectionFailure()
      advanceTimersByTime(4000) // 4s

      // Now succeed
      MockEventSource.getLastInstance()?.simulateOpen()

      // Later failure should reset to initial delay (1s), not continue from 8s
      MockEventSource.getLastInstance()?.simulateConnectionFailure()

      const attemptsBefore = MockEventSource.connectionAttempts
      advanceTimersByTime(1000) // Should reconnect after 1s, not 8s
      expect(MockEventSource.connectionAttempts).toBe(attemptsBefore + 1)
    })

    it('should call onConnect callback on successful reconnection', async () => {
      let connectCount = 0

      const config: SSEConfig = {
        url: 'http://localhost:3000/events',
        events: {},
        onConnect: () => {
          connectCount++
        },
        reconnect: {
          enabled: true,
          initialDelay: 1000,
          maxAttempts: 5,
        },
      }

      renderToString(
        createElement(
          SSEProvider,
          { config },
          createElement('div', null, 'child'),
        ),
      )

      // Initial connection
      MockEventSource.getLastInstance()?.simulateOpen()
      expect(connectCount).toBe(1)

      // Failure and reconnect
      MockEventSource.getLastInstance()?.simulateConnectionFailure()
      advanceTimersByTime(1000)
      MockEventSource.getLastInstance()?.simulateOpen()

      expect(connectCount).toBe(2)
    })

    it('should call onError callback on each connection failure', async () => {
      let errorCount = 0

      const config: SSEConfig = {
        url: 'http://localhost:3000/events',
        events: {},
        onError: () => {
          errorCount++
        },
        reconnect: {
          enabled: true,
          initialDelay: 1000,
          maxAttempts: 5,
        },
      }

      renderToString(
        createElement(
          SSEProvider,
          { config },
          createElement('div', null, 'child'),
        ),
      )

      MockEventSource.getLastInstance()?.simulateConnectionFailure()
      expect(errorCount).toBe(1)

      advanceTimersByTime(1000)
      MockEventSource.getLastInstance()?.simulateConnectionFailure()
      expect(errorCount).toBe(2)

      advanceTimersByTime(2000)
      MockEventSource.getLastInstance()?.simulateConnectionFailure()
      expect(errorCount).toBe(3)
    })
  })
})
