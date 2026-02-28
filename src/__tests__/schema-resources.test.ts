import { afterEach, describe, expect, it, spyOn } from 'bun:test'

/**
 * Tests for the enhanced defineSchema() `resources` field.
 *
 * These tests verify that defineSchema():
 * 1. Accepts an optional `resources` field alongside existing top-level event keys
 * 2. Expands each resource key into <resource>.created, <resource>.updated, <resource>.deleted
 * 3. Supports custom key derivation per operation (string, string[], or function)
 * 4. Merges expanded resource events with explicitly defined events
 * 5. Explicit event definitions take precedence over generated resource events
 * 6. Empty resources field ({}) is a no-op
 * 7. Returns a frozen SchemaResult that reflects all expanded events
 * 8. Backward compatible — existing behavior unchanged when resources is omitted
 *
 * Tests FAIL initially because src/schema.ts and src/types.ts have not been updated yet.
 */

describe('defineSchema() - resources field', () => {
  describe('basic resource expansion', () => {
    it('should expand a single resource into .created, .updated, .deleted events', async () => {
      const { defineSchema } = await import('../index.ts')

      const schema = defineSchema({
        resources: {
          orders: {},
        },
      }) as Record<string, unknown>

      expect(Object.keys(schema)).toContain('orders.created')
      expect(Object.keys(schema)).toContain('orders.updated')
      expect(Object.keys(schema)).toContain('orders.deleted')
    })

    it('should expand multiple resources independently', async () => {
      const { defineSchema } = await import('../index.ts')

      const schema = defineSchema({
        resources: {
          orders: {},
          users: {},
          products: {},
        },
      }) as Record<string, unknown>

      // orders
      expect(Object.keys(schema)).toContain('orders.created')
      expect(Object.keys(schema)).toContain('orders.updated')
      expect(Object.keys(schema)).toContain('orders.deleted')

      // users
      expect(Object.keys(schema)).toContain('users.created')
      expect(Object.keys(schema)).toContain('users.updated')
      expect(Object.keys(schema)).toContain('users.deleted')

      // products
      expect(Object.keys(schema)).toContain('products.created')
      expect(Object.keys(schema)).toContain('products.updated')
      expect(Object.keys(schema)).toContain('products.deleted')
    })

    it('should produce exactly 3 events per resource (no extras)', async () => {
      const { defineSchema } = await import('../index.ts')

      const schema = defineSchema({
        resources: {
          orders: {},
        },
      }) as Record<string, unknown>

      const orderKeys = Object.keys(schema).filter((k) =>
        k.startsWith('orders.'),
      )
      expect(orderKeys).toHaveLength(3)
      expect(orderKeys.sort()).toEqual([
        'orders.created',
        'orders.deleted',
        'orders.updated',
      ])
    })

    it('should default update to "set" for all generated resource events', async () => {
      const { defineSchema } = await import('../index.ts')

      const schema = defineSchema({
        resources: {
          orders: {},
        },
      }) as Record<string, { update: unknown }>

      expect(schema['orders.created']?.update).toBe('set')
      expect(schema['orders.updated']?.update).toBe('set')
      expect(schema['orders.deleted']?.update).toBe('set')
    })

    it('should generate a default key for each expanded event based on resource name', async () => {
      const { defineSchema } = await import('../index.ts')

      const schema = defineSchema({
        resources: {
          orders: {},
        },
      }) as Record<string, { key: unknown }>

      // Each expanded event must have a key — exact format is implementation-defined
      // but must be a non-empty string or function
      const createdKey = schema['orders.created']?.key
      const updatedKey = schema['orders.updated']?.key
      const deletedKey = schema['orders.deleted']?.key

      expect(createdKey).toBeDefined()
      expect(updatedKey).toBeDefined()
      expect(deletedKey).toBeDefined()
    })
  })

  describe('custom key per operation', () => {
    it('should accept a custom key for the created operation', async () => {
      const { defineSchema } = await import('../index.ts')

      const schema = defineSchema({
        resources: {
          orders: {
            created: { key: '/api/orders/new' },
          },
        },
      }) as Record<string, { key: unknown }>

      expect(schema['orders.created']?.key).toBe('/api/orders/new')
    })

    it('should accept a custom key for the updated operation', async () => {
      const { defineSchema } = await import('../index.ts')

      const schema = defineSchema({
        resources: {
          orders: {
            updated: { key: (p: { id: string }) => `/api/orders/${p.id}` },
          },
        },
      }) as Record<string, { key: unknown }>

      expect(typeof schema['orders.updated']?.key).toBe('function')
      const keyFn = schema['orders.updated']?.key as (p: {
        id: string
      }) => string
      expect(keyFn({ id: '42' })).toBe('/api/orders/42')
    })

    it('should accept a custom key for the deleted operation', async () => {
      const { defineSchema } = await import('../index.ts')

      const schema = defineSchema({
        resources: {
          orders: {
            deleted: { key: ['/api/orders', '/api/cache/orders'] },
          },
        },
      }) as Record<string, { key: unknown }>

      expect(schema['orders.deleted']?.key).toEqual([
        '/api/orders',
        '/api/cache/orders',
      ])
    })

    it('should accept custom keys for all three operations independently', async () => {
      const { defineSchema } = await import('../index.ts')

      const schema = defineSchema({
        resources: {
          orders: {
            created: { key: '/api/orders' },
            updated: { key: (p: { id: string }) => `/api/orders/${p.id}` },
            deleted: { key: ['/api/orders', '/api/orders/list'] },
          },
        },
      }) as Record<string, { key: unknown }>

      expect(schema['orders.created']?.key).toBe('/api/orders')
      expect(typeof schema['orders.updated']?.key).toBe('function')
      expect(schema['orders.deleted']?.key).toEqual([
        '/api/orders',
        '/api/orders/list',
      ])
    })
  })

  describe('custom update strategy per operation', () => {
    it('should accept a custom update strategy for the created operation', async () => {
      const { defineSchema } = await import('../index.ts')

      const schema = defineSchema({
        resources: {
          orders: {
            created: { key: '/api/orders', update: 'refetch' },
          },
        },
      }) as Record<string, { update: unknown }>

      expect(schema['orders.created']?.update).toBe('refetch')
    })

    it('should accept a custom merge function for the updated operation', async () => {
      const { defineSchema } = await import('../index.ts')

      const mergeFn = (
        current: Array<{ id: string }> | undefined,
        payload: { id: string },
      ): Array<{ id: string }> => {
        const list = current ?? []
        return list.map((item) => (item.id === payload.id ? payload : item))
      }

      const schema = defineSchema({
        resources: {
          orders: {
            updated: { key: '/api/orders', update: mergeFn },
          },
        },
      }) as Record<string, { update: unknown }>

      expect(typeof schema['orders.updated']?.update).toBe('function')
    })
  })

  describe('merging resources with explicit events', () => {
    it('should include both resource-expanded events and explicit top-level events', async () => {
      const { defineSchema } = await import('../index.ts')

      const schema = defineSchema({
        resources: {
          orders: {},
        },
        'user.updated': { key: '/api/users' },
      }) as Record<string, unknown>

      // Resource events
      expect(Object.keys(schema)).toContain('orders.created')
      expect(Object.keys(schema)).toContain('orders.updated')
      expect(Object.keys(schema)).toContain('orders.deleted')

      // Explicit events
      expect(Object.keys(schema)).toContain('user.updated')
    })

    it('should have exactly the right number of events when mixing resources and explicit events', async () => {
      const { defineSchema } = await import('../index.ts')

      const schema = defineSchema({
        resources: {
          orders: {},
        },
        'notification.sent': { key: '/api/notifications' },
        'session.expired': { key: '/api/sessions' },
      }) as Record<string, unknown>

      // 3 from orders resource + 2 explicit = 5 total
      expect(Object.keys(schema)).toHaveLength(5)
    })

    it('should preserve explicit event definitions alongside resource events', async () => {
      const { defineSchema } = await import('../index.ts')

      const filterFn = (payload: { active: boolean }) => payload.active

      const schema = defineSchema({
        resources: {
          products: {},
        },
        'cart.updated': {
          key: (p: { userId: string }) => `/api/cart/${p.userId}`,
          update: 'refetch',
          filter: filterFn,
        },
      }) as Record<string, { key: unknown; update: unknown; filter: unknown }>

      expect(schema['cart.updated']?.update).toBe('refetch')
      expect(typeof schema['cart.updated']?.filter).toBe('function')
    })
  })

  describe('explicit events take precedence over generated resource events', () => {
    it('should use explicit event definition when it conflicts with a generated resource event', async () => {
      const { defineSchema } = await import('../index.ts')

      const schema = defineSchema({
        resources: {
          orders: {},
        },
        // Explicit override of the generated orders.created event
        'orders.created': {
          key: '/api/orders/explicit',
          update: 'refetch',
        },
      }) as Record<string, { key: unknown; update: unknown }>

      // Explicit definition wins
      expect(schema['orders.created']?.key).toBe('/api/orders/explicit')
      expect(schema['orders.created']?.update).toBe('refetch')
    })

    it('should only override the conflicting event, leaving other resource events intact', async () => {
      const { defineSchema } = await import('../index.ts')

      const schema = defineSchema({
        resources: {
          orders: {},
        },
        'orders.deleted': { key: '/api/orders/trash' },
      }) as Record<string, { key: unknown }>

      // The explicit override applies only to orders.deleted
      expect(schema['orders.deleted']?.key).toBe('/api/orders/trash')

      // orders.created and orders.updated come from the resource expansion
      expect(schema['orders.created']).toBeDefined()
      expect(schema['orders.updated']).toBeDefined()
    })
  })

  describe('collision warning — explicit event overrides resource-generated event', () => {
    afterEach(() => {
      // Restore console.warn after each test in this describe block
    })

    it('should log a console.warn when an explicit event collides with a resource-generated event', async () => {
      const { defineSchema } = await import('../index.ts')
      const warnSpy = spyOn(console, 'warn').mockImplementation(() => {})

      defineSchema({
        resources: {
          orders: {},
        },
        'orders.created': {
          key: '/api/orders/explicit',
          update: 'refetch' as const,
        },
      })

      expect(warnSpy).toHaveBeenCalledTimes(1)
      expect(warnSpy.mock.calls[0]?.[0]).toContain('orders.created')
      warnSpy.mockRestore()
    })

    it('should warn once per colliding key (not for non-colliding explicit events)', async () => {
      const { defineSchema } = await import('../index.ts')
      const warnSpy = spyOn(console, 'warn').mockImplementation(() => {})

      defineSchema({
        resources: {
          orders: {},
        },
        // This collides with resource-generated orders.deleted
        'orders.deleted': { key: '/api/orders/trash' },
        // This does NOT collide — it is a new explicit event
        'notification.sent': { key: '/api/notifications' },
      })

      // Only orders.deleted causes a warning, not notification.sent
      expect(warnSpy).toHaveBeenCalledTimes(1)
      expect(warnSpy.mock.calls[0]?.[0]).toContain('orders.deleted')
      warnSpy.mockRestore()
    })

    it('should NOT warn when an explicit event does not collide with any resource-generated event', async () => {
      const { defineSchema } = await import('../index.ts')
      const warnSpy = spyOn(console, 'warn').mockImplementation(() => {})

      defineSchema({
        resources: {
          orders: {},
        },
        'user.updated': { key: '/api/users' },
      })

      expect(warnSpy).not.toHaveBeenCalled()
      warnSpy.mockRestore()
    })

    it('should warn for each colliding key when multiple collisions occur', async () => {
      const { defineSchema } = await import('../index.ts')
      const warnSpy = spyOn(console, 'warn').mockImplementation(() => {})

      defineSchema({
        resources: {
          orders: {},
        },
        'orders.created': { key: '/api/orders/c' },
        'orders.updated': { key: '/api/orders/u' },
      })

      expect(warnSpy).toHaveBeenCalledTimes(2)
      warnSpy.mockRestore()
    })
  })

  describe('empty resources field', () => {
    it('should treat empty resources ({}) as a no-op', async () => {
      const { defineSchema } = await import('../index.ts')

      const schema = defineSchema({
        resources: {},
      }) as Record<string, unknown>

      expect(Object.keys(schema)).toHaveLength(0)
    })

    it('should still include explicit events when resources is empty', async () => {
      const { defineSchema } = await import('../index.ts')

      const schema = defineSchema({
        resources: {},
        'user.updated': { key: '/api/users' },
      }) as Record<string, unknown>

      expect(Object.keys(schema)).toHaveLength(1)
      expect(Object.keys(schema)).toContain('user.updated')
    })
  })

  describe('frozen SchemaResult', () => {
    it('should return a frozen object when using resources', async () => {
      const { defineSchema } = await import('../index.ts')

      const schema = defineSchema({
        resources: {
          orders: {},
        },
      })

      expect(Object.isFrozen(schema)).toBe(true)
    })

    it('should not be modifiable after creation when using resources', async () => {
      const { defineSchema } = await import('../index.ts')

      const schema = defineSchema({
        resources: {
          orders: {},
        },
      }) as Record<string, unknown>

      expect(() => {
        schema['orders.created'] = 'overwritten'
      }).toThrow()
    })
  })

  describe('backward compatibility', () => {
    it('should work exactly as before when resources is not provided', async () => {
      const { defineSchema } = await import('../index.ts')

      const schema = defineSchema({
        'user.updated': { key: '/api/users', update: 'set' },
        'order.placed': {
          key: (p: { orderId: string }) => `/api/orders/${p.orderId}`,
          update: 'refetch',
        },
      }) as Record<string, { key: unknown; update: unknown }>

      expect(Object.keys(schema)).toHaveLength(2)
      expect(schema['user.updated']?.key).toBe('/api/users')
      expect(schema['user.updated']?.update).toBe('set')
      expect(typeof schema['order.placed']?.key).toBe('function')
      expect(schema['order.placed']?.update).toBe('refetch')
    })

    it('should still default update to "set" for explicit events without resources', async () => {
      const { defineSchema } = await import('../index.ts')

      const schema = defineSchema({
        'item.deleted': { key: '/api/items' },
      }) as Record<string, { update: unknown }>

      expect(schema['item.deleted']?.update).toBe('set')
    })

    it('should still return a frozen object when resources is not provided', async () => {
      const { defineSchema } = await import('../index.ts')

      const schema = defineSchema({
        'session.ended': { key: '/api/sessions' },
      })

      expect(Object.isFrozen(schema)).toBe(true)
    })

    it('should handle defineSchema({}) with no events and no resources', async () => {
      const { defineSchema } = await import('../index.ts')

      const schema = defineSchema({})

      expect(Object.isFrozen(schema)).toBe(true)
      expect(Object.keys(schema)).toHaveLength(0)
    })
  })

  describe('filter and transform per resource operation', () => {
    it('should accept an optional filter for the created operation', async () => {
      const { defineSchema } = await import('../index.ts')

      const filterFn = (payload: { status: string }) =>
        payload.status === 'active'

      const schema = defineSchema({
        resources: {
          orders: {
            created: {
              key: '/api/orders',
              filter: filterFn,
            },
          },
        },
      }) as Record<string, { filter: unknown }>

      expect(typeof schema['orders.created']?.filter).toBe('function')
      const fn = schema['orders.created']?.filter as (p: {
        status: string
      }) => boolean
      expect(fn({ status: 'active' })).toBe(true)
      expect(fn({ status: 'inactive' })).toBe(false)
    })

    it('should accept an optional transform for the updated operation', async () => {
      const { defineSchema } = await import('../index.ts')

      const transformFn = (payload: { total: number }) => ({
        ...payload,
        total: Math.round(payload.total),
      })

      const schema = defineSchema({
        resources: {
          orders: {
            updated: {
              key: '/api/orders',
              transform: transformFn,
            },
          },
        },
      }) as Record<string, { transform: unknown }>

      expect(typeof schema['orders.updated']?.transform).toBe('function')
      const fn = schema['orders.updated']?.transform as (p: {
        total: number
      }) => { total: number }
      expect(fn({ total: 9.7 })).toEqual({ total: 10 })
    })

    it('should allow filter and transform to be omitted on resource operations', async () => {
      const { defineSchema } = await import('../index.ts')

      const schema = defineSchema({
        resources: {
          orders: {},
        },
      }) as Record<string, { filter: unknown; transform: unknown }>

      expect(schema['orders.created']?.filter).toBeUndefined()
      expect(schema['orders.created']?.transform).toBeUndefined()
      expect(schema['orders.updated']?.filter).toBeUndefined()
      expect(schema['orders.updated']?.transform).toBeUndefined()
      expect(schema['orders.deleted']?.filter).toBeUndefined()
      expect(schema['orders.deleted']?.transform).toBeUndefined()
    })
  })

  describe('schema exported from index', () => {
    it('should still export defineSchema from src/index.ts', async () => {
      const exports = await import('../index.ts')
      expect(typeof (exports as Record<string, unknown>).defineSchema).toBe(
        'function',
      )
    })
  })
})
