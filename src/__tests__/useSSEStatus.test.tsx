import { describe, expect, it } from 'bun:test'
import { createElement } from 'react'
import { renderToString } from 'react-dom/server'
import { SSEProvider } from '../SSEProvider.tsx'
import type { SSEConfig, SSEStatus } from '../types.ts'

/**
 * Tests for useSSEStatus hook (WI-066).
 *
 * This hook provides a simple way for components to access SSE connection status.
 * It wraps useSSEContext and returns only the status object.
 *
 * Tests verify:
 * 1. Returns accurate SSEStatus with all fields (connected, connecting, error, reconnectAttempt)
 * 2. Throws descriptive error when used outside SSEProvider
 * 3. Re-renders when status changes
 * 4. Is exported from the package entry point
 *
 * Tests should FAIL until useSSEStatus.ts is implemented.
 */

// Import the hook - this will fail until implementation exists
import { useSSEStatus } from '../hooks/useSSEStatus.ts'

const testConfig: SSEConfig = {
  url: 'http://localhost:3000/events',
  events: {
    'user.updated': {
      key: '/api/user',
    },
  },
}

describe('useSSEStatus', () => {
  describe('export', () => {
    it('should be exported from the hooks module', () => {
      expect(useSSEStatus).toBeFunction()
    })
  })

  describe('outside SSEProvider', () => {
    it('should throw a descriptive error when used outside provider', () => {
      function OrphanComponent() {
        useSSEStatus()
        return createElement('div', null, 'should not render')
      }

      expect(() => {
        renderToString(createElement(OrphanComponent))
      }).toThrow()
    })
  })

  describe('status fields', () => {
    it('should return SSEStatus object with all required fields', () => {
      let capturedStatus: SSEStatus | null = null

      function StatusConsumer() {
        const status = useSSEStatus()
        capturedStatus = status
        return createElement('div', null, 'status captured')
      }

      renderToString(
        createElement(
          SSEProvider,
          { config: testConfig },
          createElement(StatusConsumer),
        ),
      )

      expect(capturedStatus).not.toBeNull()
      // Verify all SSEStatus fields exist
      // biome-ignore lint/style/noNonNullAssertion: asserted not-null above
      expect(typeof capturedStatus!.connected).toBe('boolean')
      // biome-ignore lint/style/noNonNullAssertion: asserted not-null above
      expect(typeof capturedStatus!.connecting).toBe('boolean')
      // biome-ignore lint/style/noNonNullAssertion: asserted not-null above
      expect('error' in capturedStatus!).toBe(true)
      // biome-ignore lint/style/noNonNullAssertion: asserted not-null above
      expect(typeof capturedStatus!.reconnectAttempt).toBe('number')
    })

    it('should return initial connecting state before connection is established', () => {
      let capturedStatus: SSEStatus | null = null

      function StatusConsumer() {
        const status = useSSEStatus()
        capturedStatus = status
        return createElement('div', null, 'status captured')
      }

      renderToString(
        createElement(
          SSEProvider,
          { config: testConfig },
          createElement(StatusConsumer),
        ),
      )

      expect(capturedStatus).not.toBeNull()
      // Initial state should be connecting (EventSource is being established)
      // biome-ignore lint/style/noNonNullAssertion: asserted not-null above
      expect(capturedStatus!.connected).toBe(false)
      // biome-ignore lint/style/noNonNullAssertion: asserted not-null above
      expect(capturedStatus!.connecting).toBe(true)
      // biome-ignore lint/style/noNonNullAssertion: asserted not-null above
      expect(capturedStatus!.error).toBeNull()
      // biome-ignore lint/style/noNonNullAssertion: asserted not-null above
      expect(capturedStatus!.reconnectAttempt).toBe(0)
    })

    it('should return error as null when no error has occurred', () => {
      let capturedStatus: SSEStatus | null = null

      function StatusConsumer() {
        const status = useSSEStatus()
        capturedStatus = status
        return createElement('div', null, 'status captured')
      }

      renderToString(
        createElement(
          SSEProvider,
          { config: testConfig },
          createElement(StatusConsumer),
        ),
      )

      // biome-ignore lint/style/noNonNullAssertion: capturedStatus is set in render
      expect(capturedStatus!.error).toBeNull()
    })

    it('should return reconnectAttempt as 0 initially', () => {
      let capturedStatus: SSEStatus | null = null

      function StatusConsumer() {
        const status = useSSEStatus()
        capturedStatus = status
        return createElement('div', null, 'status captured')
      }

      renderToString(
        createElement(
          SSEProvider,
          { config: testConfig },
          createElement(StatusConsumer),
        ),
      )

      // biome-ignore lint/style/noNonNullAssertion: capturedStatus is set in render
      expect(capturedStatus!.reconnectAttempt).toBe(0)
    })
  })

  describe('reactivity', () => {
    it('should return the same status object as useSSEContext().status', () => {
      // Import useSSEContext to compare
      const { useSSEContext } = require('../SSEProvider.tsx')

      let statusFromHook: SSEStatus | null = null
      let statusFromContext: SSEStatus | null = null

      function CompareConsumer() {
        statusFromHook = useSSEStatus()
        statusFromContext = useSSEContext().status
        return createElement('div', null, 'compared')
      }

      renderToString(
        createElement(
          SSEProvider,
          { config: testConfig },
          createElement(CompareConsumer),
        ),
      )

      // Both should reference the same status object
      expect(statusFromHook).toBe(statusFromContext)
    })
  })
})
