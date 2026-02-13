import { describe, expect, it } from 'bun:test'

/**
 * Tests for the shared reconnection utility module (src/reconnect.ts).
 *
 * This module extracts calculateBackoffDelay and DEFAULT_RECONNECT
 * from SSEProvider.tsx into a standalone, pure utility module.
 *
 * Tests will FAIL until src/reconnect.ts is created with the correct exports.
 */

describe('reconnect utilities', () => {
  describe('module exports', () => {
    it('should export calculateBackoffDelay as a function', async () => {
      const { calculateBackoffDelay } = await import('../reconnect.ts')

      expect(calculateBackoffDelay).toBeDefined()
      expect(typeof calculateBackoffDelay).toBe('function')
    })

    it('should export DEFAULT_RECONNECT as an object', async () => {
      const { DEFAULT_RECONNECT } = await import('../reconnect.ts')

      expect(DEFAULT_RECONNECT).toBeDefined()
      expect(typeof DEFAULT_RECONNECT).toBe('object')
    })
  })

  describe('DEFAULT_RECONNECT', () => {
    it('should have the expected shape with all required fields', async () => {
      const { DEFAULT_RECONNECT } = await import('../reconnect.ts')

      expect(DEFAULT_RECONNECT).toHaveProperty('enabled')
      expect(DEFAULT_RECONNECT).toHaveProperty('initialDelay')
      expect(DEFAULT_RECONNECT).toHaveProperty('maxDelay')
      expect(DEFAULT_RECONNECT).toHaveProperty('backoffMultiplier')
      expect(DEFAULT_RECONNECT).toHaveProperty('maxAttempts')
    })

    it('should have correct default values matching SSEProvider', async () => {
      const { DEFAULT_RECONNECT } = await import('../reconnect.ts')

      expect(DEFAULT_RECONNECT.enabled).toBe(true)
      expect(DEFAULT_RECONNECT.initialDelay).toBe(1000)
      expect(DEFAULT_RECONNECT.maxDelay).toBe(30000)
      expect(DEFAULT_RECONNECT.backoffMultiplier).toBe(2)
      expect(DEFAULT_RECONNECT.maxAttempts).toBe(Number.POSITIVE_INFINITY)
    })

    it('should have boolean enabled field', async () => {
      const { DEFAULT_RECONNECT } = await import('../reconnect.ts')

      expect(typeof DEFAULT_RECONNECT.enabled).toBe('boolean')
    })

    it('should have numeric initialDelay field', async () => {
      const { DEFAULT_RECONNECT } = await import('../reconnect.ts')

      expect(typeof DEFAULT_RECONNECT.initialDelay).toBe('number')
    })

    it('should have numeric maxDelay field', async () => {
      const { DEFAULT_RECONNECT } = await import('../reconnect.ts')

      expect(typeof DEFAULT_RECONNECT.maxDelay).toBe('number')
    })

    it('should have numeric backoffMultiplier field', async () => {
      const { DEFAULT_RECONNECT } = await import('../reconnect.ts')

      expect(typeof DEFAULT_RECONNECT.backoffMultiplier).toBe('number')
    })

    it('should have numeric maxAttempts field', async () => {
      const { DEFAULT_RECONNECT } = await import('../reconnect.ts')

      expect(typeof DEFAULT_RECONNECT.maxAttempts).toBe('number')
    })
  })

  describe('calculateBackoffDelay', () => {
    it('should return initialDelay for attempt 0', async () => {
      const { calculateBackoffDelay, DEFAULT_RECONNECT } = await import(
        '../reconnect.ts'
      )

      const delay = calculateBackoffDelay(0, DEFAULT_RECONNECT)

      // initialDelay * backoffMultiplier^0 = 1000 * 1 = 1000
      expect(delay).toBe(1000)
    })

    it('should apply exponential backoff for subsequent attempts', async () => {
      const { calculateBackoffDelay, DEFAULT_RECONNECT } = await import(
        '../reconnect.ts'
      )

      // attempt 1: 1000 * 2^1 = 2000
      expect(calculateBackoffDelay(1, DEFAULT_RECONNECT)).toBe(2000)

      // attempt 2: 1000 * 2^2 = 4000
      expect(calculateBackoffDelay(2, DEFAULT_RECONNECT)).toBe(4000)

      // attempt 3: 1000 * 2^3 = 8000
      expect(calculateBackoffDelay(3, DEFAULT_RECONNECT)).toBe(8000)

      // attempt 4: 1000 * 2^4 = 16000
      expect(calculateBackoffDelay(4, DEFAULT_RECONNECT)).toBe(16000)
    })

    it('should cap delay at maxDelay', async () => {
      const { calculateBackoffDelay, DEFAULT_RECONNECT } = await import(
        '../reconnect.ts'
      )

      // attempt 5: 1000 * 2^5 = 32000, capped at 30000
      expect(calculateBackoffDelay(5, DEFAULT_RECONNECT)).toBe(30000)

      // attempt 10: 1000 * 2^10 = 1024000, capped at 30000
      expect(calculateBackoffDelay(10, DEFAULT_RECONNECT)).toBe(30000)
    })

    it('should respect custom config values', async () => {
      const { calculateBackoffDelay } = await import('../reconnect.ts')

      const customConfig = {
        enabled: true,
        initialDelay: 500,
        maxDelay: 10000,
        backoffMultiplier: 3,
        maxAttempts: 5,
      }

      // attempt 0: 500 * 3^0 = 500
      expect(calculateBackoffDelay(0, customConfig)).toBe(500)

      // attempt 1: 500 * 3^1 = 1500
      expect(calculateBackoffDelay(1, customConfig)).toBe(1500)

      // attempt 2: 500 * 3^2 = 4500
      expect(calculateBackoffDelay(2, customConfig)).toBe(4500)

      // attempt 3: 500 * 3^3 = 13500, capped at 10000
      expect(calculateBackoffDelay(3, customConfig)).toBe(10000)
    })

    it('should handle backoffMultiplier of 1 (constant delay)', async () => {
      const { calculateBackoffDelay } = await import('../reconnect.ts')

      const config = {
        enabled: true,
        initialDelay: 2000,
        maxDelay: 60000,
        backoffMultiplier: 1,
        maxAttempts: 10,
      }

      // With multiplier 1, delay should always be initialDelay
      expect(calculateBackoffDelay(0, config)).toBe(2000)
      expect(calculateBackoffDelay(1, config)).toBe(2000)
      expect(calculateBackoffDelay(5, config)).toBe(2000)
    })

    it('should handle large attempt numbers without exceeding maxDelay', async () => {
      const { calculateBackoffDelay, DEFAULT_RECONNECT } = await import(
        '../reconnect.ts'
      )

      // Very large attempt number should be capped at maxDelay
      expect(calculateBackoffDelay(100, DEFAULT_RECONNECT)).toBe(30000)
      expect(calculateBackoffDelay(1000, DEFAULT_RECONNECT)).toBe(30000)
    })

    it('should be a pure function with no side effects', async () => {
      const { calculateBackoffDelay, DEFAULT_RECONNECT } = await import(
        '../reconnect.ts'
      )

      const configCopy = { ...DEFAULT_RECONNECT }

      // Call multiple times
      calculateBackoffDelay(0, DEFAULT_RECONNECT)
      calculateBackoffDelay(1, DEFAULT_RECONNECT)
      calculateBackoffDelay(2, DEFAULT_RECONNECT)

      // Config should not be mutated
      expect(DEFAULT_RECONNECT).toEqual(configCopy)
    })

    it('should return consistent results for the same inputs', async () => {
      const { calculateBackoffDelay, DEFAULT_RECONNECT } = await import(
        '../reconnect.ts'
      )

      const result1 = calculateBackoffDelay(3, DEFAULT_RECONNECT)
      const result2 = calculateBackoffDelay(3, DEFAULT_RECONNECT)

      expect(result1).toBe(result2)
    })

    it('should handle maxDelay equal to initialDelay', async () => {
      const { calculateBackoffDelay } = await import('../reconnect.ts')

      const config = {
        enabled: true,
        initialDelay: 1000,
        maxDelay: 1000,
        backoffMultiplier: 2,
        maxAttempts: 10,
      }

      // All attempts should return 1000 since maxDelay === initialDelay
      expect(calculateBackoffDelay(0, config)).toBe(1000)
      expect(calculateBackoffDelay(1, config)).toBe(1000)
      expect(calculateBackoffDelay(5, config)).toBe(1000)
    })

    it('should handle very large backoffMultiplier without exceeding maxDelay', async () => {
      const { calculateBackoffDelay } = await import('../reconnect.ts')

      const config = {
        enabled: true,
        initialDelay: 100,
        maxDelay: 5000,
        backoffMultiplier: 10,
        maxAttempts: 5,
      }

      // attempt 0: 100 * 10^0 = 100
      expect(calculateBackoffDelay(0, config)).toBe(100)
      // attempt 1: 100 * 10^1 = 1000
      expect(calculateBackoffDelay(1, config)).toBe(1000)
      // attempt 2: 100 * 10^2 = 10000, capped at 5000
      expect(calculateBackoffDelay(2, config)).toBe(5000)
    })

    it('should handle Infinity from very large exponents gracefully', async () => {
      const { calculateBackoffDelay } = await import('../reconnect.ts')

      const config = {
        enabled: true,
        initialDelay: 1000,
        maxDelay: 30000,
        backoffMultiplier: 2,
        maxAttempts: Number.POSITIVE_INFINITY,
      }

      // 2^10000 = Infinity, 1000 * Infinity = Infinity
      // Math.min(Infinity, 30000) should be 30000
      const result = calculateBackoffDelay(10000, config)
      expect(result).toBe(30000)
      expect(Number.isFinite(result)).toBe(true)
    })

    it('should return initialDelay when backoffMultiplier is 0 and attempt is 0', async () => {
      const { calculateBackoffDelay } = await import('../reconnect.ts')

      const config = {
        enabled: true,
        initialDelay: 1000,
        maxDelay: 30000,
        backoffMultiplier: 0,
        maxAttempts: 10,
      }

      // 0^0 = 1 in JavaScript, so 1000 * 1 = 1000
      expect(calculateBackoffDelay(0, config)).toBe(1000)
    })
  })
})
