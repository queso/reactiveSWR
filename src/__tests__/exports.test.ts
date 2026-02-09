import { describe, expect, it } from 'bun:test'

/**
 * Export verification tests for reactiveSWR package.
 *
 * These tests verify that all public APIs are correctly exported
 * from the main entry point and testing utilities module.
 *
 * Tests will FAIL if:
 * - Exports are missing from index files
 * - Exports have incorrect types
 * - Type exports are not available
 */

describe('Package exports', () => {
  describe('Main entry point (src/index.ts)', () => {
    it('should export SSEProvider component', async () => {
      const exports = await import('../index.ts')

      expect(exports.SSEProvider).toBeDefined()
      expect(typeof exports.SSEProvider).toBe('function')
    })

    it('should export useSSEContext hook', async () => {
      const exports = await import('../index.ts')

      expect(exports.useSSEContext).toBeDefined()
      expect(typeof exports.useSSEContext).toBe('function')
    })

    it('should export useSSEStatus hook', async () => {
      const exports = await import('../index.ts')

      expect(exports.useSSEStatus).toBeDefined()
      expect(typeof exports.useSSEStatus).toBe('function')
    })

    it('should export useSSEEvent hook', async () => {
      const exports = await import('../index.ts')

      expect(exports.useSSEEvent).toBeDefined()
      expect(typeof exports.useSSEEvent).toBe('function')
    })

    it('should export useSSEStream hook', async () => {
      const exports = await import('../index.ts')

      expect(exports.useSSEStream).toBeDefined()
      expect(typeof exports.useSSEStream).toBe('function')
    })
  })

  describe('Type exports from main entry point', () => {
    it('should export SSEConfig type', async () => {
      // Type imports are verified at compile time
      // Runtime verification uses type satisfies pattern
      const { SSEProvider } = await import('../index.ts')

      // Create a minimal valid config to verify the type is usable
      const config: import('../index.ts').SSEConfig = {
        url: '/api/events',
        events: {},
      }

      expect(config.url).toBe('/api/events')
      expect(SSEProvider).toBeDefined()
    })

    it('should export SSEStatus type', async () => {
      const status: import('../index.ts').SSEStatus = {
        connected: false,
        connecting: true,
        error: null,
        reconnectAttempt: 0,
      }

      expect(status.connected).toBe(false)
      expect(status.connecting).toBe(true)
    })

    it('should export SSEProviderProps type', async () => {
      const props: import('../index.ts').SSEProviderProps = {
        config: {
          url: '/api/events',
          events: {},
        },
        children: null,
      }

      expect(props.config.url).toBe('/api/events')
    })

    it('should export EventMapping type', async () => {
      const mapping: import('../index.ts').EventMapping<{ id: number }, unknown> = {
        key: '/api/items',
        update: 'set',
      }

      expect(mapping.key).toBe('/api/items')
    })

    it('should export ParsedEvent type', async () => {
      const event: import('../index.ts').ParsedEvent = {
        type: 'test',
        payload: { data: 'value' },
      }

      expect(event.type).toBe('test')
    })

    it('should export ReconnectConfig type', async () => {
      const reconnectConfig: import('../index.ts').ReconnectConfig = {
        enabled: true,
        initialDelay: 1000,
        maxDelay: 30000,
        backoffMultiplier: 2,
        maxAttempts: 5,
      }

      expect(reconnectConfig.enabled).toBe(true)
    })

    it('should export UpdateStrategy type', async () => {
      // Test all variants of UpdateStrategy
      const setStrategy: import('../index.ts').UpdateStrategy<string, string> = 'set'
      const refetchStrategy: import('../index.ts').UpdateStrategy<string, string> = 'refetch'
      const fnStrategy: import('../index.ts').UpdateStrategy<string, string[]> = (current, payload) => [
        ...(current ?? []),
        payload,
      ]

      expect(setStrategy).toBe('set')
      expect(refetchStrategy).toBe('refetch')
      expect(typeof fnStrategy).toBe('function')
    })

    it('should export UseSSEStreamOptions type', async () => {
      const options: import('../index.ts').UseSSEStreamOptions<{ id: number }> = {
        transform: (data) => data as { id: number },
      }

      expect(options.transform).toBeDefined()
    })

    it('should export UseSSEStreamResult type', async () => {
      const result: import('../index.ts').UseSSEStreamResult<{ id: number }> = {
        data: { id: 1 },
        error: undefined,
      }

      expect(result.data?.id).toBe(1)
    })
  })

  describe('Testing utilities (src/testing/index.ts)', () => {
    it('should export mockSSE function', async () => {
      const { mockSSE } = await import('../testing/index.ts')

      expect(mockSSE).toBeDefined()
      expect(typeof mockSSE).toBe('function')
    })

    it('should export mockSSE.restore method', async () => {
      const { mockSSE } = await import('../testing/index.ts')

      expect(mockSSE.restore).toBeDefined()
      expect(typeof mockSSE.restore).toBe('function')
    })

    it('should export MockSSEControls type', async () => {
      const { mockSSE } = await import('../testing/index.ts')

      // Create a mock and verify the controls interface
      const controls: import('../testing/index.ts').MockSSEControls = mockSSE('/test-url')

      expect(controls.sendEvent).toBeDefined()
      expect(controls.close).toBeDefined()
      expect(controls.getConnection).toBeDefined()

      // Clean up
      mockSSE.restore()
    })

    it('should export SSEEventData type', async () => {
      const eventData: import('../testing/index.ts').SSEEventData = {
        type: 'test.event',
        payload: { id: 1, name: 'test' },
      }

      expect(eventData.type).toBe('test.event')
      expect(eventData.payload).toEqual({ id: 1, name: 'test' })
    })
  })

  describe('Export completeness', () => {
    it('should have all expected exports from main entry point', async () => {
      const exports = await import('../index.ts')
      const exportKeys = Object.keys(exports)

      // Verify runtime exports (functions/components)
      const expectedRuntimeExports = [
        'SSEProvider',
        'useSSEContext',
        'useSSEStatus',
        'useSSEEvent',
        'useSSEStream',
      ]

      for (const name of expectedRuntimeExports) {
        expect(exportKeys).toContain(name)
      }
    })

    it('should have all expected exports from testing utilities', async () => {
      const exports = await import('../testing/index.ts')
      const exportKeys = Object.keys(exports)

      expect(exportKeys).toContain('mockSSE')
    })
  })
})
