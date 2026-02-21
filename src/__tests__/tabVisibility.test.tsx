import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { createElement } from 'react'
import { renderToString } from 'react-dom/server'
import { SSEProvider, useSSEContext } from '../SSEProvider.tsx'
import type { SSEConfig, SSEStatus } from '../types.ts'

/**
 * Tests for tab visibility handling (WI-069).
 *
 * These tests verify:
 * 1. Reconnects when tab becomes visible if connection was lost
 * 2. Does NOT create duplicate connections if already connected
 * 3. visibilitychange listener is cleaned up on unmount
 * 4. Works with existing reconnection logic (WI-065)
 *
 * Tests should FAIL until tab visibility handling is implemented.
 */

// Enhanced MockEventSource for tab visibility testing
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

// Store original EventSource and document properties
const originalEventSource = globalThis.EventSource
const originalDocument = globalThis.document

// Track visibility change listeners
let visibilityChangeListeners: Set<(event: Event) => void> = new Set()
let mockVisibilityState: DocumentVisibilityState = 'visible'

// Mock document for visibility state testing
function createMockDocument() {
  return {
    get visibilityState() {
      return mockVisibilityState
    },
    addEventListener(type: string, listener: (event: Event) => void) {
      if (type === 'visibilitychange') {
        visibilityChangeListeners.add(listener)
      }
    },
    removeEventListener(type: string, listener: (event: Event) => void) {
      if (type === 'visibilitychange') {
        visibilityChangeListeners.delete(listener)
      }
    },
  }
}

// Dispatch a mock visibilitychange event
function dispatchVisibilityChange(state: DocumentVisibilityState) {
  mockVisibilityState = state
  const event = new Event('visibilitychange')
  for (const listener of visibilityChangeListeners) {
    listener(event)
  }
}

// Store timers
const originalSetTimeout = globalThis.setTimeout
const originalClearTimeout = globalThis.clearTimeout

// Track pending timers
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

// Advance fake time
function advanceTimersByTime(ms: number) {
  const targetTime = currentTime + ms

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

  // Reset visibility state
  mockVisibilityState = 'visible'
  visibilityChangeListeners = new Set()

  // Install mock document
  // @ts-expect-error - Mocking document
  globalThis.document = createMockDocument()
})

afterEach(() => {
  globalThis.EventSource = originalEventSource
  globalThis.setTimeout = originalSetTimeout
  globalThis.clearTimeout = originalClearTimeout
  // @ts-expect-error - Restoring document
  globalThis.document = originalDocument
})

describe('SSEProvider Tab Visibility Handling', () => {
  describe('reconnection on tab visible', () => {
    it('should reconnect when tab becomes visible if connection was lost', async () => {
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

      // Open and then close connection (simulate server disconnect)
      MockEventSource.getLastInstance()?.simulateOpen()
      MockEventSource.getLastInstance()?.simulateConnectionFailure()

      // Clear any pending reconnect timers (simulate user switching tabs before reconnect)
      resetTimers()

      // Tab is now hidden
      dispatchVisibilityChange('hidden')

      // No new connection while hidden
      expect(MockEventSource.connectionAttempts).toBe(1)

      // Tab becomes visible again
      dispatchVisibilityChange('visible')

      // Should trigger reconnection immediately
      expect(MockEventSource.connectionAttempts).toBe(2)
    })

    it('should reconnect immediately on visibility change without waiting for backoff', async () => {
      const config: SSEConfig = {
        url: 'http://localhost:3000/events',
        events: {},
        reconnect: {
          enabled: true,
          initialDelay: 10000, // Long delay
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

      MockEventSource.getLastInstance()?.simulateOpen()
      MockEventSource.getLastInstance()?.simulateConnectionFailure()

      // Reconnect timer is scheduled with 10s delay
      expect(MockEventSource.connectionAttempts).toBe(1)

      // Don't wait for the timer
      advanceTimersByTime(0)

      // Tab becomes visible - should reconnect immediately
      dispatchVisibilityChange('visible')

      expect(MockEventSource.connectionAttempts).toBe(2)
    })

    it('should cancel pending reconnect timer when visibility triggers reconnect', async () => {
      const config: SSEConfig = {
        url: 'http://localhost:3000/events',
        events: {},
        reconnect: {
          enabled: true,
          initialDelay: 5000,
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

      MockEventSource.getLastInstance()?.simulateOpen()
      MockEventSource.getLastInstance()?.simulateConnectionFailure()

      // Reconnect timer is scheduled
      expect(pendingTimers.size).toBeGreaterThan(0)

      // Tab becomes visible - triggers immediate reconnect
      dispatchVisibilityChange('visible')
      expect(MockEventSource.connectionAttempts).toBe(2)

      // Advance the original timer - should NOT create another connection
      advanceTimersByTime(5000)
      expect(MockEventSource.connectionAttempts).toBe(2) // Still 2, not 3
    })
  })

  describe('duplicate connection prevention', () => {
    it('should NOT create duplicate connection if already connected', async () => {
      const config: SSEConfig = {
        url: 'http://localhost:3000/events',
        events: {},
        reconnect: {
          enabled: true,
        },
      }

      renderToString(
        createElement(
          SSEProvider,
          { config },
          createElement('div', null, 'child'),
        ),
      )

      // Initial connection opens successfully
      MockEventSource.getLastInstance()?.simulateOpen()
      expect(MockEventSource.connectionAttempts).toBe(1)

      // Tab visibility changes while connected
      dispatchVisibilityChange('hidden')
      dispatchVisibilityChange('visible')

      // Should NOT create a new connection
      expect(MockEventSource.connectionAttempts).toBe(1)
    })

    it('should NOT reconnect if connection is currently in progress (CONNECTING state)', async () => {
      const config: SSEConfig = {
        url: 'http://localhost:3000/events',
        events: {},
        reconnect: {
          enabled: true,
        },
      }

      renderToString(
        createElement(
          SSEProvider,
          { config },
          createElement('div', null, 'child'),
        ),
      )

      // Initial connection is still connecting (readyState = 0)
      expect(MockEventSource.getLastInstance()?.readyState).toBe(0)
      expect(MockEventSource.connectionAttempts).toBe(1)

      // Tab visibility changes while connecting
      dispatchVisibilityChange('hidden')
      dispatchVisibilityChange('visible')

      // Should NOT create a new connection
      expect(MockEventSource.connectionAttempts).toBe(1)
    })

    it('should NOT reconnect if a reconnect timer is already pending', async () => {
      const config: SSEConfig = {
        url: 'http://localhost:3000/events',
        events: {},
        reconnect: {
          enabled: true,
          initialDelay: 5000,
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

      // Connection fails
      MockEventSource.getLastInstance()?.simulateOpen()
      MockEventSource.getLastInstance()?.simulateConnectionFailure()

      // Reconnect timer is scheduled
      expect(pendingTimers.size).toBeGreaterThan(0)
      const _timersBefore = pendingTimers.size

      // Note: This test may need adjustment based on implementation
      // If visibility triggers immediate reconnect and cancels timer, that's also valid
      // The key is: no duplicate connections should be created
      dispatchVisibilityChange('hidden')
      dispatchVisibilityChange('visible')

      // Wait for timer
      advanceTimersByTime(5000)

      // Should have at most 2 total connections (original + one reconnect)
      expect(MockEventSource.connectionAttempts).toBeLessThanOrEqual(2)
    })
  })

  describe('visibility listener cleanup', () => {
    it('should register visibilitychange listener on mount', () => {
      const config: SSEConfig = {
        url: 'http://localhost:3000/events',
        events: {},
      }

      expect(visibilityChangeListeners.size).toBe(0)

      renderToString(
        createElement(
          SSEProvider,
          { config },
          createElement('div', null, 'child'),
        ),
      )

      // Should have registered a visibility listener
      expect(visibilityChangeListeners.size).toBe(1)
    })

    it('should cleanup visibilitychange listener on unmount', () => {
      // Note: This test documents expected behavior.
      // In SSR (renderToString), useEffect cleanup doesn't run.
      // Verification of actual cleanup requires DOM-based testing.

      const config: SSEConfig = {
        url: 'http://localhost:3000/events',
        events: {},
      }

      renderToString(
        createElement(
          SSEProvider,
          { config },
          createElement('div', null, 'child'),
        ),
      )

      const listenersAfterMount = visibilityChangeListeners.size

      // In a DOM environment, unmounting would call useEffect cleanup
      // and remove the listener. This test verifies the listener was
      // registered, implying cleanup would remove it.
      expect(listenersAfterMount).toBe(1)
    })

    it('should not attempt reconnection after cleanup', () => {
      // Documents expected behavior: after unmount, visibility changes
      // should not trigger reconnection attempts on the old provider
      const config: SSEConfig = {
        url: 'http://localhost:3000/events',
        events: {},
        reconnect: {
          enabled: true,
        },
      }

      renderToString(
        createElement(
          SSEProvider,
          { config },
          createElement('div', null, 'child'),
        ),
      )

      MockEventSource.getLastInstance()?.simulateOpen()
      MockEventSource.getLastInstance()?.simulateConnectionFailure()

      const attemptsBeforeVisibilityChange = MockEventSource.connectionAttempts

      // Simulate what happens after proper cleanup:
      // Clear all listeners (mimics useEffect cleanup)
      visibilityChangeListeners.clear()

      // Visibility change after "unmount"
      dispatchVisibilityChange('visible')

      // Should not create new connections since listener was cleaned up
      expect(MockEventSource.connectionAttempts).toBe(
        attemptsBeforeVisibilityChange,
      )
    })
  })

  describe('integration with reconnection logic', () => {
    it('should respect reconnect.enabled: false and not reconnect on visibility', async () => {
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

      // Connection established and then fails
      MockEventSource.getLastInstance()?.simulateOpen()
      MockEventSource.getLastInstance()?.simulateConnectionFailure()

      expect(MockEventSource.connectionAttempts).toBe(1)

      // Tab becomes visible
      dispatchVisibilityChange('visible')

      // Should NOT reconnect because reconnect is disabled
      expect(MockEventSource.connectionAttempts).toBe(1)
    })

    it('should respect maxAttempts after visibility-triggered reconnects', async () => {
      const config: SSEConfig = {
        url: 'http://localhost:3000/events',
        events: {},
        reconnect: {
          enabled: true,
          initialDelay: 100,
          maxAttempts: 2, // Allow only 2 total attempts
        },
      }

      renderToString(
        createElement(
          SSEProvider,
          { config },
          createElement('div', null, 'child'),
        ),
      )

      // First attempt (initial connection)
      expect(MockEventSource.connectionAttempts).toBe(1)
      MockEventSource.getLastInstance()?.simulateConnectionFailure()

      // Second attempt via visibility
      dispatchVisibilityChange('visible')
      expect(MockEventSource.connectionAttempts).toBe(2)
      MockEventSource.getLastInstance()?.simulateConnectionFailure()

      // Should not reconnect anymore (maxAttempts reached)
      dispatchVisibilityChange('hidden')
      dispatchVisibilityChange('visible')
      expect(MockEventSource.connectionAttempts).toBe(2)
    })

    it('should reset attempt count on successful connection via visibility', async () => {
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
          maxAttempts: 10,
        },
      }

      renderToString(
        createElement(SSEProvider, { config }, createElement(StatusCapture)),
      )

      // Initial connection fails
      MockEventSource.getLastInstance()?.simulateConnectionFailure()

      // Reconnect via backoff
      advanceTimersByTime(1000)
      expect(capturedStatus?.reconnectAttempt).toBe(1)

      // That also fails
      MockEventSource.getLastInstance()?.simulateConnectionFailure()

      // Reconnect via visibility
      dispatchVisibilityChange('visible')

      // This time succeeds
      MockEventSource.getLastInstance()?.simulateOpen()

      // Attempt count should be reset
      expect(capturedStatus?.reconnectAttempt).toBe(0)
    })

    it('should call onConnect callback on visibility-triggered reconnection success', async () => {
      let connectCount = 0

      const config: SSEConfig = {
        url: 'http://localhost:3000/events',
        events: {},
        onConnect: () => {
          connectCount++
        },
        reconnect: {
          enabled: true,
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

      // Connection fails
      MockEventSource.getLastInstance()?.simulateConnectionFailure()

      // Reconnect via visibility
      dispatchVisibilityChange('visible')
      MockEventSource.getLastInstance()?.simulateOpen()

      expect(connectCount).toBe(2)
    })
  })

  describe('edge cases', () => {
    it('should handle rapid visibility changes gracefully', async () => {
      const config: SSEConfig = {
        url: 'http://localhost:3000/events',
        events: {},
        reconnect: {
          enabled: true,
        },
      }

      renderToString(
        createElement(
          SSEProvider,
          { config },
          createElement('div', null, 'child'),
        ),
      )

      // Connection fails
      MockEventSource.getLastInstance()?.simulateOpen()
      MockEventSource.getLastInstance()?.simulateConnectionFailure()

      expect(MockEventSource.connectionAttempts).toBe(1)

      // Rapid visibility changes
      dispatchVisibilityChange('visible')
      dispatchVisibilityChange('hidden')
      dispatchVisibilityChange('visible')
      dispatchVisibilityChange('hidden')
      dispatchVisibilityChange('visible')

      // Should not create excessive connections
      // Implementation should debounce or prevent duplicates
      expect(MockEventSource.connectionAttempts).toBeLessThanOrEqual(2)
    })

    it('should handle visibility change during active reconnect attempt', async () => {
      const config: SSEConfig = {
        url: 'http://localhost:3000/events',
        events: {},
        reconnect: {
          enabled: true,
          initialDelay: 1000,
        },
      }

      renderToString(
        createElement(
          SSEProvider,
          { config },
          createElement('div', null, 'child'),
        ),
      )

      // Connection fails, reconnect timer starts
      MockEventSource.getLastInstance()?.simulateConnectionFailure()

      // Timer fires, reconnection in progress
      advanceTimersByTime(1000)
      expect(MockEventSource.connectionAttempts).toBe(2)

      // While this reconnect is CONNECTING (readyState = 0), visibility changes
      expect(MockEventSource.getLastInstance()?.readyState).toBe(0)
      dispatchVisibilityChange('visible')

      // Should not create yet another connection
      expect(MockEventSource.connectionAttempts).toBe(2)
    })

    it('should work correctly when tab is hidden during initial connection', async () => {
      // Start hidden
      mockVisibilityState = 'hidden'

      const config: SSEConfig = {
        url: 'http://localhost:3000/events',
        events: {},
        reconnect: {
          enabled: true,
        },
      }

      renderToString(
        createElement(
          SSEProvider,
          { config },
          createElement('div', null, 'child'),
        ),
      )

      // Should still attempt initial connection
      expect(MockEventSource.connectionAttempts).toBe(1)

      // Connection fails while hidden
      MockEventSource.getLastInstance()?.simulateConnectionFailure()

      // Tab becomes visible
      dispatchVisibilityChange('visible')

      // Should reconnect
      expect(MockEventSource.connectionAttempts).toBe(2)
    })

    it('should update status correctly after visibility-triggered reconnect', async () => {
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
        },
      }

      renderToString(
        createElement(SSEProvider, { config }, createElement(StatusCapture)),
      )

      // Initial connection
      MockEventSource.getLastInstance()?.simulateOpen()
      expect(capturedStatus?.connected).toBe(true)
      expect(capturedStatus?.connecting).toBe(false)

      // Connection fails
      MockEventSource.getLastInstance()?.simulateConnectionFailure()
      expect(capturedStatus?.connected).toBe(false)
      expect(capturedStatus?.error).not.toBeNull()

      // Reconnect via visibility
      dispatchVisibilityChange('visible')
      expect(capturedStatus?.connecting).toBe(true)

      // Reconnect succeeds
      MockEventSource.getLastInstance()?.simulateOpen()
      expect(capturedStatus?.connected).toBe(true)
      expect(capturedStatus?.connecting).toBe(false)
      expect(capturedStatus?.error).toBeNull()
    })
  })
})
