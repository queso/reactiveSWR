import { describe, expect, it } from 'bun:test'

/**
 * Tests for defineSchema() function.
 *
 * These tests verify that defineSchema():
 * 1. Accepts a definition object and returns a frozen schema
 * 2. Preserves event names as string literals
 * 3. Supports key, update, filter, transform properties per event
 * 4. Defaults update to 'set' when not specified
 * 5. Handles an empty schema definition
 * 6. Is exported from the main entry point (src/index.ts)
 * 7. Accepts key as string, string[], or function
 * 8. Treats filter and transform as optional
 *
 * Tests FAIL initially because defineSchema has not been implemented yet.
 */

describe('defineSchema()', () => {
  describe('Req #8 - export from main entry point', () => {
    it('should be exported from src/index.ts', async () => {
      const exports = await import('../index.ts')

      expect((exports as Record<string, unknown>).defineSchema).toBeDefined()
      expect(typeof (exports as Record<string, unknown>).defineSchema).toBe(
        'function',
      )
    })
  })

  describe('Req #7 - frozen return value', () => {
    it('should return a frozen object', async () => {
      const { defineSchema } = await import('../index.ts')

      const schema = defineSchema({
        'user.updated': {
          key: '/api/users',
          update: 'set',
        },
      })

      expect(Object.isFrozen(schema)).toBe(true)
    })

    it('should not be modifiable after creation', async () => {
      const { defineSchema } = await import('../index.ts')

      const schema = defineSchema({
        'user.updated': {
          key: '/api/users',
        },
      }) as Record<string, unknown>

      expect(() => {
        schema.newKey = 'value'
      }).toThrow()
    })
  })

  describe('Req #6 - empty schema edge case', () => {
    it('defineSchema({}) should return a valid frozen object', async () => {
      const { defineSchema } = await import('../index.ts')

      const schema = defineSchema({})

      expect(schema).toBeDefined()
      expect(Object.isFrozen(schema)).toBe(true)
      expect(Object.keys(schema).length).toBe(0)
    })
  })

  describe('Req #9 - event names preserved', () => {
    it('should preserve event names as keys on the returned schema', async () => {
      const { defineSchema } = await import('../index.ts')

      const schema = defineSchema({
        'user.updated': { key: '/api/users' },
        'order.placed': { key: '/api/orders' },
      }) as Record<string, unknown>

      expect(Object.keys(schema)).toContain('user.updated')
      expect(Object.keys(schema)).toContain('order.placed')
    })

    it('should not add extra keys beyond the event definitions', async () => {
      const { defineSchema } = await import('../index.ts')

      const schema = defineSchema({
        'item.deleted': { key: '/api/items' },
      }) as Record<string, unknown>

      expect(Object.keys(schema)).toHaveLength(1)
      expect(Object.keys(schema)[0]).toBe('item.deleted')
    })
  })

  describe('Req #10 - event definition properties', () => {
    describe('key property', () => {
      it('should accept a string key', async () => {
        const { defineSchema } = await import('../index.ts')

        const schema = defineSchema({
          'user.updated': { key: '/api/users/1' },
        }) as Record<string, { key: unknown }>

        expect(schema['user.updated']?.key).toBe('/api/users/1')
      })

      it('should accept a string array key', async () => {
        const { defineSchema } = await import('../index.ts')

        const keys = ['/api/users/1', '/api/users/2']
        const schema = defineSchema({
          'user.updated': { key: keys },
        }) as Record<string, { key: unknown }>

        expect(schema['user.updated']?.key).toEqual(keys)
      })

      it('should accept a function key that returns a string', async () => {
        const { defineSchema } = await import('../index.ts')

        const keyFn = (payload: { id: number }) => `/api/users/${payload.id}`
        const schema = defineSchema({
          'user.updated': { key: keyFn },
        }) as Record<string, { key: unknown }>

        expect(typeof schema['user.updated']?.key).toBe('function')
        expect(
          (schema['user.updated']?.key as (p: { id: number }) => string)({
            id: 42,
          }),
        ).toBe('/api/users/42')
      })

      it('should accept a function key that returns a string array', async () => {
        const { defineSchema } = await import('../index.ts')

        const keyFn = (payload: { id: number }) => [
          `/api/users/${payload.id}`,
          '/api/users',
        ]
        const schema = defineSchema({
          'user.updated': { key: keyFn },
        }) as Record<string, { key: unknown }>

        expect(typeof schema['user.updated']?.key).toBe('function')
        expect(
          (schema['user.updated']?.key as (p: { id: number }) => string[])({
            id: 5,
          }),
        ).toEqual(['/api/users/5', '/api/users'])
      })
    })

    describe('update property', () => {
      it('should accept "set" as update strategy', async () => {
        const { defineSchema } = await import('../index.ts')

        const schema = defineSchema({
          'user.updated': { key: '/api/users', update: 'set' },
        }) as Record<string, { update: unknown }>

        expect(schema['user.updated']?.update).toBe('set')
      })

      it('should accept "refetch" as update strategy', async () => {
        const { defineSchema } = await import('../index.ts')

        const schema = defineSchema({
          'user.updated': { key: '/api/users', update: 'refetch' },
        }) as Record<string, { update: unknown }>

        expect(schema['user.updated']?.update).toBe('refetch')
      })

      it('should accept a custom function as update strategy', async () => {
        const { defineSchema } = await import('../index.ts')

        const mergeFn = (
          current: string[] | undefined,
          payload: string,
        ): string[] => [...(current ?? []), payload]

        const schema = defineSchema({
          'item.added': { key: '/api/items', update: mergeFn },
        }) as Record<string, { update: unknown }>

        expect(typeof schema['item.added']?.update).toBe('function')
        expect(
          (
            schema['item.added']?.update as (c: string[], p: string) => string[]
          )(['a'], 'b'),
        ).toEqual(['a', 'b'])
      })

      it('should default update to "set" when not specified', async () => {
        const { defineSchema } = await import('../index.ts')

        const schema = defineSchema({
          'user.updated': { key: '/api/users' },
        }) as Record<string, { update: unknown }>

        expect(schema['user.updated']?.update).toBe('set')
      })
    })

    describe('filter property (optional)', () => {
      it('should accept an optional filter function', async () => {
        const { defineSchema } = await import('../index.ts')

        const filterFn = (payload: { active: boolean }) => payload.active

        const schema = defineSchema({
          'user.updated': { key: '/api/users', filter: filterFn },
        }) as Record<string, { filter: unknown }>

        expect(typeof schema['user.updated']?.filter).toBe('function')
        expect(
          (
            schema['user.updated']?.filter as (p: {
              active: boolean
            }) => boolean
          )({ active: true }),
        ).toBe(true)
      })

      it('should allow filter to be omitted', async () => {
        const { defineSchema } = await import('../index.ts')

        const schema = defineSchema({
          'user.updated': { key: '/api/users' },
        }) as Record<string, { filter: unknown }>

        // filter should be undefined or absent when not provided
        expect(schema['user.updated']?.filter).toBeUndefined()
      })
    })

    describe('transform property (optional)', () => {
      it('should accept an optional transform function', async () => {
        const { defineSchema } = await import('../index.ts')

        const transformFn = (payload: { name: string }) => ({
          ...payload,
          name: payload.name.toUpperCase(),
        })

        const schema = defineSchema({
          'user.updated': { key: '/api/users', transform: transformFn },
        }) as Record<string, { transform: unknown }>

        expect(typeof schema['user.updated']?.transform).toBe('function')
        expect(
          (
            schema['user.updated']?.transform as (p: { name: string }) => {
              name: string
            }
          )({ name: 'alice' }),
        ).toEqual({ name: 'ALICE' })
      })

      it('should allow transform to be omitted', async () => {
        const { defineSchema } = await import('../index.ts')

        const schema = defineSchema({
          'user.updated': { key: '/api/users' },
        }) as Record<string, { transform: unknown }>

        expect(schema['user.updated']?.transform).toBeUndefined()
      })
    })

    describe('multiple events in one schema', () => {
      it('should preserve all event definitions when multiple events are provided', async () => {
        const { defineSchema } = await import('../index.ts')

        const schema = defineSchema({
          'user.updated': { key: '/api/users', update: 'set' },
          'order.placed': {
            key: (payload: { orderId: string }) =>
              `/api/orders/${payload.orderId}`,
            update: 'refetch',
          },
          'item.deleted': {
            key: ['/api/items', '/api/cache'],
            filter: (payload: { soft: boolean }) => !payload.soft,
          },
        }) as Record<string, unknown>

        expect(Object.keys(schema)).toHaveLength(3)
        expect(Object.keys(schema)).toContain('user.updated')
        expect(Object.keys(schema)).toContain('order.placed')
        expect(Object.keys(schema)).toContain('item.deleted')
      })

      it('each event in the schema should carry its own definition', async () => {
        const { defineSchema } = await import('../index.ts')

        const schema = defineSchema({
          'a.event': { key: '/api/a', update: 'set' },
          'b.event': { key: '/api/b', update: 'refetch' },
        }) as Record<string, { key: string; update: string }>

        expect(schema['a.event']?.key).toBe('/api/a')
        expect(schema['a.event']?.update).toBe('set')
        expect(schema['b.event']?.key).toBe('/api/b')
        expect(schema['b.event']?.update).toBe('refetch')
      })
    })
  })
})
