import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { createElement } from 'react'
import { renderToString } from 'react-dom/server'
import { SSEProvider, useSSEContext } from '../SSEProvider.tsx'
import { defineSchema } from '../schema.ts'
import type { SSEConfig } from '../types.ts'

/**
 * Tests for SSEProvider schema prop (WI-040).
 *
 * Verifies that SSEProvider accepts an optional `schema` prop that
 * auto-derives the `events` mapping instead of requiring manual EventMapping records.
 *
 * Tests cover:
 * 1. SSEProvider accepts a schema prop and renders children
 * 2. Schema-derived events mapping carries key, update, filter, transform
 * 3. schema takes precedence at runtime when both schema and events are provided (with warning)
 * 4. parseEvent remains configurable alongside schema
 * 5. Empty schema produces empty events mapping
 * 6. All existing SSEProvider behavior unaffected (no regressions)
 * 7. Derived events mapping matches EventMapping shape
 *
 * Tests FAIL initially because the schema prop has not been added yet.
 */

// --------------------------------------------------------------------------
// Schemas used across tests
// --------------------------------------------------------------------------

const userSchema = defineSchema({
  'user.updated': { key: '/api/users', update: 'set' },
})

const orderSchema = defineSchema({
  'order.placed': {
    key: (p: { id: string }) => `/api/orders/${p.id}`,
    update: 'refetch',
  },
})

const filterTransformSchema = defineSchema({
  'item.added': {
    key: '/api/items',
    update: 'set',
    filter: (p: { active: boolean }) => p.active,
    transform: (p: { name: string }) => ({ ...p, name: p.name.toUpperCase() }),
  },
})

const emptySchema = defineSchema({})

const multiSchema = defineSchema({
  'user.updated': { key: '/api/users', update: 'set' },
  'order.placed': { key: '/api/orders', update: 'refetch' },
  'item.deleted': { key: ['/api/items', '/api/cache'] },
})

// --------------------------------------------------------------------------
// Helper: capture the SSEContext value from within a rendered provider
// --------------------------------------------------------------------------

function captureContext(
  config: SSEConfig,
): ReturnType<typeof useSSEContext> | null {
  let captured: ReturnType<typeof useSSEContext> | null = null

  function Capture() {
    captured = useSSEContext()
    return createElement('span', null, 'ok')
  }

  renderToString(createElement(SSEProvider, { config }, createElement(Capture)))
  return captured
}

// --------------------------------------------------------------------------
// Tests
// --------------------------------------------------------------------------

describe('SSEProvider schema prop', () => {
  let consoleWarnSpy: typeof console.warn
  const warnCalls: unknown[][] = []

  beforeEach(() => {
    consoleWarnSpy = console.warn
    console.warn = (...args: unknown[]) => warnCalls.push(args)
    warnCalls.length = 0
  })

  afterEach(() => {
    console.warn = consoleWarnSpy
  })

  // -------------------------------------------------------------------------
  // Req #25 - SSEConfig accepts schema prop
  // -------------------------------------------------------------------------

  describe('Req #25 - SSEConfig accepts schema prop', () => {
    it('SSEProvider should render children when given schema instead of events', () => {
      const html = renderToString(
        createElement(
          SSEProvider,
          { config: { url: '/api/events', schema: userSchema } as SSEConfig },
          createElement('div', null, 'child rendered'),
        ),
      )
      expect(html).toContain('child rendered')
    })

    it('SSEConfig should accept a schema property without events', () => {
      // This is primarily a type-level assertion, but we verify it at runtime
      // by ensuring SSEProvider does not throw when schema is provided
      expect(() => {
        renderToString(
          createElement(
            SSEProvider,
            {
              config: {
                url: '/api/events',
                schema: userSchema,
              } as SSEConfig,
            },
            createElement('span', null, 'ok'),
          ),
        )
      }).not.toThrow()
    })

    it('SSEConfig should still accept events without schema (backward compat)', () => {
      expect(() => {
        renderToString(
          createElement(
            SSEProvider,
            {
              config: {
                url: '/api/events',
                events: { 'user.updated': { key: '/api/users' } },
              },
            },
            createElement('span', null, 'ok'),
          ),
        )
      }).not.toThrow()
    })
  })

  // -------------------------------------------------------------------------
  // Req #26 - Auto-derived events from schema
  // -------------------------------------------------------------------------

  describe('Req #26 - auto-derived events from schema', () => {
    it('context config.events should contain keys from the schema', () => {
      const ctx = captureContext({
        url: '/api/events',
        schema: userSchema,
      } as SSEConfig)

      expect(ctx).not.toBeNull()
      const events = (ctx as NonNullable<typeof ctx>).config.events
      expect(events).toBeDefined()
      expect(Object.keys(events)).toContain('user.updated')
    })

    it('derived event mapping should have the correct key from schema', () => {
      const ctx = captureContext({
        url: '/api/events',
        schema: userSchema,
      } as SSEConfig)

      const events = (ctx as NonNullable<typeof ctx>).config.events
      expect(events['user.updated']?.key).toBe('/api/users')
    })

    it('derived event mapping should have the correct update strategy from schema', () => {
      const ctx = captureContext({
        url: '/api/events',
        schema: userSchema,
      } as SSEConfig)

      const events = (ctx as NonNullable<typeof ctx>).config.events
      expect(events['user.updated']?.update).toBe('set')
    })

    it('derived event mapping should include filter from schema', () => {
      const ctx = captureContext({
        url: '/api/events',
        schema: filterTransformSchema,
      } as SSEConfig)

      const events = (ctx as NonNullable<typeof ctx>).config.events
      expect(typeof events['item.added']?.filter).toBe('function')
    })

    it('derived filter should behave correctly', () => {
      const ctx = captureContext({
        url: '/api/events',
        schema: filterTransformSchema,
      } as SSEConfig)

      const filter = (ctx as NonNullable<typeof ctx>).config.events[
        'item.added'
      ]?.filter as ((p: { active: boolean }) => boolean) | undefined

      expect(filter?.({ active: true })).toBe(true)
      expect(filter?.({ active: false })).toBe(false)
    })

    it('derived event mapping should include transform from schema', () => {
      const ctx = captureContext({
        url: '/api/events',
        schema: filterTransformSchema,
      } as SSEConfig)

      const events = (ctx as NonNullable<typeof ctx>).config.events
      expect(typeof events['item.added']?.transform).toBe('function')
    })

    it('derived transform should behave correctly', () => {
      const ctx = captureContext({
        url: '/api/events',
        schema: filterTransformSchema,
      } as SSEConfig)

      const transform = (ctx as NonNullable<typeof ctx>).config.events[
        'item.added'
      ]?.transform as ((p: { name: string }) => { name: string }) | undefined

      expect(transform?.({ name: 'alice' })).toEqual({ name: 'ALICE' })
    })

    it('derived event should use "refetch" update strategy when schema specifies it', () => {
      const ctx = captureContext({
        url: '/api/events',
        schema: orderSchema,
      } as SSEConfig)

      const events = (ctx as NonNullable<typeof ctx>).config.events
      expect(events['order.placed']?.update).toBe('refetch')
    })

    it('function key from schema should be preserved in derived events', () => {
      const ctx = captureContext({
        url: '/api/events',
        schema: orderSchema,
      } as SSEConfig)

      const keyFn = (ctx as NonNullable<typeof ctx>).config.events[
        'order.placed'
      ]?.key

      expect(typeof keyFn).toBe('function')
      expect((keyFn as (p: { id: string }) => string)({ id: '99' })).toBe(
        '/api/orders/99',
      )
    })

    it('array key from schema should be preserved in derived events', () => {
      const ctx = captureContext({
        url: '/api/events',
        schema: multiSchema,
      } as SSEConfig)

      const events = (ctx as NonNullable<typeof ctx>).config.events
      expect(events['item.deleted']?.key).toEqual(['/api/items', '/api/cache'])
    })

    it('all events from a multi-event schema should be in derived mapping', () => {
      const ctx = captureContext({
        url: '/api/events',
        schema: multiSchema,
      } as SSEConfig)

      const events = (ctx as NonNullable<typeof ctx>).config.events
      expect(Object.keys(events)).toContain('user.updated')
      expect(Object.keys(events)).toContain('order.placed')
      expect(Object.keys(events)).toContain('item.deleted')
    })
  })

  // -------------------------------------------------------------------------
  // Req #27 - Mutual exclusivity (runtime: schema takes precedence)
  // -------------------------------------------------------------------------

  describe('Req #27 - schema takes precedence over events at runtime', () => {
    it('when both schema and events are provided, schema events should be used', () => {
      const ctx = captureContext({
        url: '/api/events',
        schema: userSchema,
        events: { 'unrelated.event': { key: '/api/other' } },
        // biome-ignore lint/suspicious/noExplicitAny: deliberately bypass type check to test runtime fallback
      } as any)

      const events = (ctx as NonNullable<typeof ctx>).config.events
      // Schema-derived events take precedence
      expect(Object.keys(events)).toContain('user.updated')
    })

    it('when both schema and events are provided in debug mode, a warning should be logged', () => {
      renderToString(
        createElement(
          SSEProvider,
          {
            config: {
              url: '/api/events',
              schema: userSchema,
              events: { 'unrelated.event': { key: '/api/other' } },
              debug: true,
              // biome-ignore lint/suspicious/noExplicitAny: deliberately bypass type check to test runtime fallback
            } as any,
          },
          createElement('span', null, 'ok'),
        ),
      )

      // A warning should have been logged about conflict
      const warned = warnCalls.some((args) =>
        args.some(
          (a) => typeof a === 'string' && a.toLowerCase().includes('schema'),
        ),
      )
      expect(warned).toBe(true)
    })
  })

  // -------------------------------------------------------------------------
  // Req #29 - parseEvent remains configurable with schema
  // -------------------------------------------------------------------------

  describe('Req #29 - parseEvent configurable alongside schema', () => {
    it('SSEConfig with schema should still accept parseEvent', () => {
      const customParseEvent = (event: MessageEvent) => ({
        type: 'user.updated',
        payload: JSON.parse(event.data),
      })

      expect(() => {
        renderToString(
          createElement(
            SSEProvider,
            {
              config: {
                url: '/api/events',
                schema: userSchema,
                parseEvent: customParseEvent,
              } as SSEConfig,
            },
            createElement('span', null, 'ok'),
          ),
        )
      }).not.toThrow()
    })

    it('custom parseEvent is preserved in context config when schema is used', () => {
      const customParseEvent = (event: MessageEvent) => ({
        type: 'user.updated',
        payload: JSON.parse(event.data),
      })

      const ctx = captureContext({
        url: '/api/events',
        schema: userSchema,
        parseEvent: customParseEvent,
      } as SSEConfig)

      expect((ctx as NonNullable<typeof ctx>).config.parseEvent).toBe(
        customParseEvent,
      )
    })
  })

  // -------------------------------------------------------------------------
  // Empty schema edge case
  // -------------------------------------------------------------------------

  describe('empty schema produces empty events mapping', () => {
    it('defineSchema({}) as schema prop should produce empty events', () => {
      const ctx = captureContext({
        url: '/api/events',
        schema: emptySchema,
      } as SSEConfig)

      const events = (ctx as NonNullable<typeof ctx>).config.events
      expect(Object.keys(events)).toHaveLength(0)
    })

    it('SSEProvider should render successfully with an empty schema', () => {
      const html = renderToString(
        createElement(
          SSEProvider,
          {
            config: {
              url: '/api/events',
              schema: emptySchema,
            } as SSEConfig,
          },
          createElement('span', null, 'rendered'),
        ),
      )
      expect(html).toContain('rendered')
    })
  })

  // -------------------------------------------------------------------------
  // Req #30 - No regressions: existing events-based config still works
  // -------------------------------------------------------------------------

  describe('Req #30 - no regressions from existing SSEProvider behavior', () => {
    it('events-only config still provides correct events in context', () => {
      const ctx = captureContext({
        url: '/api/events',
        events: {
          'user.updated': { key: '/api/users', update: 'set' },
        },
      })

      const events = (ctx as NonNullable<typeof ctx>).config.events
      expect(events['user.updated']?.key).toBe('/api/users')
    })

    it('SSEProvider with events-only config still renders children', () => {
      const html = renderToString(
        createElement(
          SSEProvider,
          {
            config: {
              url: '/api/events',
              events: { 'user.updated': { key: '/api/users' } },
            },
          },
          createElement('div', null, 'children ok'),
        ),
      )
      expect(html).toContain('children ok')
    })

    it('initial status is correct regardless of schema or events usage', () => {
      let status: ReturnType<typeof useSSEContext>['status'] | null = null

      function Capture() {
        const ctx = useSSEContext()
        status = ctx.status
        return createElement('span', null, 'ok')
      }

      renderToString(
        createElement(
          SSEProvider,
          {
            config: { url: '/api/events', schema: userSchema } as SSEConfig,
          },
          createElement(Capture),
        ),
      )

      expect(status).not.toBeNull()
      expect((status as NonNullable<typeof status>).connected).toBe(false)
      expect((status as NonNullable<typeof status>).connecting).toBe(true)
      expect((status as NonNullable<typeof status>).error).toBeNull()
    })

    it('useSSEContext still throws when used outside provider with schema config', () => {
      function Orphan() {
        useSSEContext()
        return createElement('span', null, 'bad')
      }

      expect(() => renderToString(createElement(Orphan))).toThrow()
    })

    it('subscribe is still available in context when using schema', () => {
      let subscribeType: string | null = null

      function Capture() {
        const ctx = useSSEContext()
        subscribeType = typeof ctx.subscribe
        return createElement('span', null, 'ok')
      }

      renderToString(
        createElement(
          SSEProvider,
          {
            config: { url: '/api/events', schema: userSchema } as SSEConfig,
          },
          createElement(Capture),
        ),
      )

      expect(subscribeType).toBe('function')
    })
  })

  // -------------------------------------------------------------------------
  // Derived events match EventMapping shape
  // -------------------------------------------------------------------------

  describe('derived events mapping matches EventMapping shape', () => {
    it('derived event should have a key property', () => {
      const ctx = captureContext({
        url: '/api/events',
        schema: userSchema,
      } as SSEConfig)

      const event = (ctx as NonNullable<typeof ctx>).config.events[
        'user.updated'
      ]
      expect(event).toBeDefined()
      expect('key' in (event as object)).toBe(true)
    })

    it('derived event should have an update property (defaulted to "set")', () => {
      const schemaWithDefault = defineSchema({
        ping: { key: '/api/ping' }, // no explicit update
      })

      const ctx = captureContext({
        url: '/api/events',
        schema: schemaWithDefault,
      } as SSEConfig)

      const event = (ctx as NonNullable<typeof ctx>).config.events.ping
      expect(event).toBeDefined()
      expect((event as Record<string, unknown>).update).toBe('set')
    })

    it('derived event without filter should have undefined filter', () => {
      const ctx = captureContext({
        url: '/api/events',
        schema: userSchema,
      } as SSEConfig)

      const event = (ctx as NonNullable<typeof ctx>).config.events[
        'user.updated'
      ]
      expect((event as Record<string, unknown>).filter).toBeUndefined()
    })

    it('derived event without transform should have undefined transform', () => {
      const ctx = captureContext({
        url: '/api/events',
        schema: userSchema,
      } as SSEConfig)

      const event = (ctx as NonNullable<typeof ctx>).config.events[
        'user.updated'
      ]
      expect((event as Record<string, unknown>).transform).toBeUndefined()
    })
  })
})
