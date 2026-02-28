import { describe, expect, it, mock } from 'bun:test'
import type { SSEAdapter } from '../server/adapters/types.ts'

/**
 * Tests for createEmitterAdapter() — wraps any object with on/off methods
 * to emit SSE events from named events.
 *
 * These tests verify that:
 * 1. createEmitterAdapter(emitter, mapping) is exported from src/server/adapters/emitter.ts
 * 2. The adapter implements the SSEAdapter interface (start/stop)
 * 3. start() calls emitter.on(eventName, handler) for each mapped event
 * 4. Handler calls emit() with the mapped schema event type and the emitted data as payload
 * 5. stop() calls emitter.off(eventName, handler) for each registered listener
 * 6. Works with any on/off-compatible object (not just Node.js EventEmitter)
 * 7. Works with both synchronous and asynchronous event handlers
 * 8. Named export only (tree-shakeable)
 *
 * Tests FAIL initially because src/server/adapters/emitter.ts has not been created yet.
 */

// ---------------------------------------------------------------------------
// Mock emitter helpers
// ---------------------------------------------------------------------------

type EventListener = (...args: unknown[]) => void | Promise<void>

/**
 * Minimal on/off compatible event emitter mock.
 * Does not extend EventEmitter — intentionally minimal interface.
 */
function makeMockEmitter() {
  const listeners: Map<string, EventListener[]> = new Map()

  const onMock = mock((event: string, listener: EventListener) => {
    const list = listeners.get(event) ?? []
    list.push(listener)
    listeners.set(event, list)
  })

  const offMock = mock((event: string, listener: EventListener) => {
    const list = listeners.get(event) ?? []
    listeners.set(
      event,
      list.filter((l) => l !== listener),
    )
  })

  const emitter = { on: onMock, off: offMock }

  /** Fire an event, calling all registered listeners */
  function fire(event: string, ...args: unknown[]): void {
    const list = listeners.get(event) ?? []
    for (const listener of list) {
      listener(...args)
    }
  }

  return { emitter, onMock, offMock, fire, listeners }
}

type EmitterAdapterMapping = {
  [emitterEvent: string]: string // emitter event name → schema event type
}

async function importAdapter() {
  const mod = (await import('../server/adapters/emitter.ts')) as Record<
    string,
    // biome-ignore lint/suspicious/noExplicitAny: dynamic import typing
    any
  >
  return mod.createEmitterAdapter as (
    emitter: {
      on: (event: string, listener: EventListener) => void
      off: (event: string, listener: EventListener) => void
    },
    mapping: EmitterAdapterMapping,
  ) => SSEAdapter
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('createEmitterAdapter()', () => {
  describe('export and interface', () => {
    it('should be exported from src/server/adapters/emitter.ts', async () => {
      const mod = await import('../server/adapters/emitter.ts')
      expect(
        (mod as Record<string, unknown>).createEmitterAdapter,
      ).toBeDefined()
      expect(typeof (mod as Record<string, unknown>).createEmitterAdapter).toBe(
        'function',
      )
    })

    it('should return an object implementing the SSEAdapter interface', async () => {
      const createEmitterAdapter = await importAdapter()
      const { emitter } = makeMockEmitter()

      const adapter = createEmitterAdapter(emitter, {
        'user-saved': 'user.updated',
      })

      expect(typeof adapter.start).toBe('function')
      expect(typeof adapter.stop).toBe('function')
    })

    it('should be a named export (not default)', async () => {
      const mod = (await import('../server/adapters/emitter.ts')) as Record<
        string,
        unknown
      >
      expect(mod.createEmitterAdapter).toBeDefined()
      expect(mod.default).toBeUndefined()
    })
  })

  describe('start() — registers on() listeners for each mapped event', () => {
    it('start() should call emitter.on() for each mapped event name', async () => {
      const createEmitterAdapter = await importAdapter()
      const { emitter, onMock } = makeMockEmitter()

      const adapter = createEmitterAdapter(emitter, {
        'user-saved': 'user.updated',
        'order-placed': 'order.created',
      })
      adapter.start(() => {})

      expect(onMock).toHaveBeenCalledTimes(2)

      const registeredEvents = (
        onMock as ReturnType<typeof mock>
      ).mock.calls.map((c) => c[0])
      expect(registeredEvents).toContain('user-saved')
      expect(registeredEvents).toContain('order-placed')
    })

    it('start() should pass a function as the listener to emitter.on()', async () => {
      const createEmitterAdapter = await importAdapter()
      const { emitter, onMock } = makeMockEmitter()

      const adapter = createEmitterAdapter(emitter, {
        'data-changed': 'data.updated',
      })
      adapter.start(() => {})

      const listener = (onMock as ReturnType<typeof mock>).mock.calls[0]?.[1]
      expect(typeof listener).toBe('function')
    })

    it('start() with empty mapping should not call emitter.on()', async () => {
      const createEmitterAdapter = await importAdapter()
      const { emitter, onMock } = makeMockEmitter()

      const adapter = createEmitterAdapter(emitter, {})
      adapter.start(() => {})

      expect(onMock).not.toHaveBeenCalled()
    })
  })

  describe('event emission — handler invokes emit with correct type and payload', () => {
    it('should emit the mapped schema event type when an emitter event fires', async () => {
      const createEmitterAdapter = await importAdapter()
      const { emitter, fire } = makeMockEmitter()

      const emitted: Array<{ type: string; payload: unknown }> = []
      const adapter = createEmitterAdapter(emitter, {
        'user-saved': 'user.updated',
      })
      adapter.start((type, payload) => emitted.push({ type, payload }))

      fire('user-saved', { id: 1, name: 'Alice' })

      expect(emitted).toHaveLength(1)
      expect(emitted[0]?.type).toBe('user.updated')
    })

    it('should pass the emitted data as the payload to emit()', async () => {
      const createEmitterAdapter = await importAdapter()
      const { emitter, fire } = makeMockEmitter()

      const emitted: Array<{ type: string; payload: unknown }> = []
      const adapter = createEmitterAdapter(emitter, {
        'order-placed': 'order.created',
      })
      adapter.start((type, payload) => emitted.push({ type, payload }))

      const orderData = { orderId: '99', total: 49.99, items: ['widget'] }
      fire('order-placed', orderData)

      expect(emitted[0]?.payload).toEqual(orderData)
    })

    it('should route multiple emitter events to their respective schema events', async () => {
      const createEmitterAdapter = await importAdapter()
      const { emitter, fire } = makeMockEmitter()

      const emitted: Array<{ type: string; payload: unknown }> = []
      const adapter = createEmitterAdapter(emitter, {
        'user-created': 'user.created',
        'user-updated': 'user.updated',
        'user-deleted': 'user.deleted',
      })
      adapter.start((type, payload) => emitted.push({ type, payload }))

      fire('user-created', { id: 1 })
      fire('user-updated', { id: 1, name: 'Bob' })
      fire('user-deleted', { id: 1 })

      expect(emitted).toHaveLength(3)
      expect(emitted[0]?.type).toBe('user.created')
      expect(emitted[1]?.type).toBe('user.updated')
      expect(emitted[2]?.type).toBe('user.deleted')
    })

    it('should not emit for emitter events not in the mapping', async () => {
      const createEmitterAdapter = await importAdapter()
      const { emitter, fire } = makeMockEmitter()

      const emitted: Array<{ type: string; payload: unknown }> = []
      const adapter = createEmitterAdapter(emitter, {
        'user-saved': 'user.updated',
      })
      adapter.start((type, payload) => emitted.push({ type, payload }))

      // Fire an unmapped event — no listener was registered for it
      fire('unrelated-event', { data: 'ignored' })

      expect(emitted).toHaveLength(0)
    })

    it('should emit once per fired event (no double-registration)', async () => {
      const createEmitterAdapter = await importAdapter()
      const { emitter, fire } = makeMockEmitter()

      const emitted: Array<{ type: string; payload: unknown }> = []
      const adapter = createEmitterAdapter(emitter, {
        'item-added': 'item.created',
      })
      adapter.start((type, payload) => emitted.push({ type, payload }))

      fire('item-added', { id: 10 })
      fire('item-added', { id: 11 })

      expect(emitted).toHaveLength(2)
      expect((emitted[0]?.payload as Record<string, unknown>).id).toBe(10)
      expect((emitted[1]?.payload as Record<string, unknown>).id).toBe(11)
    })

    it('should allow multiple emitter events to map to the same schema event type', async () => {
      const createEmitterAdapter = await importAdapter()
      const { emitter, fire } = makeMockEmitter()

      const emitted: Array<{ type: string; payload: unknown }> = []
      const adapter = createEmitterAdapter(emitter, {
        'product-created': 'product.changed',
        'product-updated': 'product.changed',
      })
      adapter.start((type, payload) => emitted.push({ type, payload }))

      fire('product-created', { id: 1 })
      fire('product-updated', { id: 1, price: 9.99 })

      expect(emitted).toHaveLength(2)
      expect(emitted[0]?.type).toBe('product.changed')
      expect(emitted[1]?.type).toBe('product.changed')
    })

    it('should pass the first argument from the event as the payload', async () => {
      const createEmitterAdapter = await importAdapter()
      const { emitter, fire } = makeMockEmitter()

      const emitted: Array<{ payload: unknown }> = []
      const adapter = createEmitterAdapter(emitter, { msg: 'message.received' })
      adapter.start((_type, payload) => emitted.push({ payload }))

      // String payload
      fire('msg', 'hello world')
      expect(emitted[0]?.payload).toBe('hello world')

      // Null payload
      fire('msg', null)
      expect(emitted[1]?.payload).toBeNull()

      // Number payload
      fire('msg', 42)
      expect(emitted[2]?.payload).toBe(42)
    })
  })

  describe('stop() — removes off() listeners for each mapped event', () => {
    it('stop() should call emitter.off() for each mapped event name', async () => {
      const createEmitterAdapter = await importAdapter()
      const { emitter, offMock } = makeMockEmitter()

      const adapter = createEmitterAdapter(emitter, {
        'user-saved': 'user.updated',
        'order-placed': 'order.created',
      })
      adapter.start(() => {})
      adapter.stop()

      expect(offMock).toHaveBeenCalledTimes(2)

      const unregisteredEvents = (
        offMock as ReturnType<typeof mock>
      ).mock.calls.map((c) => c[0])
      expect(unregisteredEvents).toContain('user-saved')
      expect(unregisteredEvents).toContain('order-placed')
    })

    it('stop() should pass the same listener reference to off() that was passed to on()', async () => {
      const createEmitterAdapter = await importAdapter()
      const { emitter, onMock, offMock } = makeMockEmitter()

      const adapter = createEmitterAdapter(emitter, {
        'data-changed': 'data.updated',
      })
      adapter.start(() => {})
      adapter.stop()

      const registeredListener = (onMock as ReturnType<typeof mock>).mock
        .calls[0]?.[1]
      const unregisteredListener = (offMock as ReturnType<typeof mock>).mock
        .calls[0]?.[1]

      // Must be the exact same function reference
      expect(unregisteredListener).toBe(registeredListener)
    })

    it('after stop(), events from the emitter should no longer trigger emit()', async () => {
      const createEmitterAdapter = await importAdapter()
      const { emitter, fire } = makeMockEmitter()

      const emitted: Array<{ type: string; payload: unknown }> = []
      const adapter = createEmitterAdapter(emitter, {
        'user-saved': 'user.updated',
      })
      adapter.start((type, payload) => emitted.push({ type, payload }))

      fire('user-saved', { id: 1 })
      expect(emitted).toHaveLength(1)

      adapter.stop()

      fire('user-saved', { id: 2 })
      expect(emitted).toHaveLength(1) // no new events
    })

    it('stop() should return void or Promise<void>', async () => {
      const createEmitterAdapter = await importAdapter()
      const { emitter } = makeMockEmitter()

      const adapter = createEmitterAdapter(emitter, { x: 'x.event' })
      adapter.start(() => {})

      const result = adapter.stop()
      if (result !== undefined) {
        expect(result).toBeInstanceOf(Promise)
        await result
      }
    })

    it('stop() should not throw if called without start()', async () => {
      const createEmitterAdapter = await importAdapter()
      const { emitter } = makeMockEmitter()

      const adapter = createEmitterAdapter(emitter, { x: 'x.event' })

      expect(() => adapter.stop()).not.toThrow()
    })

    it('stop() should not throw if called twice', async () => {
      const createEmitterAdapter = await importAdapter()
      const { emitter } = makeMockEmitter()

      const adapter = createEmitterAdapter(emitter, { x: 'x.event' })
      adapter.start(() => {})
      adapter.stop()

      expect(() => adapter.stop()).not.toThrow()
    })

    it('stop() with empty mapping should not call emitter.off()', async () => {
      const createEmitterAdapter = await importAdapter()
      const { emitter, offMock } = makeMockEmitter()

      const adapter = createEmitterAdapter(emitter, {})
      adapter.start(() => {})
      adapter.stop()

      expect(offMock).not.toHaveBeenCalled()
    })
  })

  describe('works with any on/off compatible object (not just Node.js EventEmitter)', () => {
    it('should work with a plain object that implements on/off', async () => {
      const createEmitterAdapter = await importAdapter()

      // Completely custom emitter — no EventEmitter inheritance
      const handlers: Map<string, EventListener[]> = new Map()
      const customEmitter = {
        on(event: string, listener: EventListener) {
          const list = handlers.get(event) ?? []
          list.push(listener)
          handlers.set(event, list)
        },
        off(event: string, listener: EventListener) {
          const list = handlers.get(event) ?? []
          handlers.set(
            event,
            list.filter((l) => l !== listener),
          )
        },
      }

      const emitted: Array<{ type: string }> = []
      const adapter = createEmitterAdapter(customEmitter, {
        change: 'data.changed',
      })
      adapter.start((type) => emitted.push({ type }))

      // Fire by calling all registered handlers manually
      const list = handlers.get('change') ?? []
      for (const handler of list) handler({ value: 42 })

      expect(emitted).toHaveLength(1)
      expect(emitted[0]?.type).toBe('data.changed')

      adapter.stop()

      // After stop(), handler should be removed
      const listAfter = handlers.get('change') ?? []
      expect(listAfter).toHaveLength(0)
    })

    it('should work with a Redis-style pub/sub client mock', async () => {
      const createEmitterAdapter = await importAdapter()

      // Redis-style: on/off with event + channel + listener
      // Simplified mock that only supports flat event names
      const subscriptions: Map<string, EventListener[]> = new Map()
      const redisMock = {
        on(event: string, listener: EventListener) {
          const list = subscriptions.get(event) ?? []
          list.push(listener)
          subscriptions.set(event, list)
        },
        off(event: string, listener: EventListener) {
          const list = subscriptions.get(event) ?? []
          subscriptions.set(
            event,
            list.filter((l) => l !== listener),
          )
        },
      }

      const emitted: string[] = []
      const adapter = createEmitterAdapter(redisMock, {
        'cache:invalidated': 'cache.invalidated',
      })
      adapter.start((type) => emitted.push(type))

      // Simulate a Redis message
      const handlers = subscriptions.get('cache:invalidated') ?? []
      for (const h of handlers) h({ key: 'user:1' })

      expect(emitted).toHaveLength(1)
      expect(emitted[0]).toBe('cache.invalidated')

      adapter.stop()
    })
  })

  describe('async event handlers', () => {
    it('should not throw when an async listener fires', async () => {
      const createEmitterAdapter = await importAdapter()
      const { emitter, fire } = makeMockEmitter()

      // Emit callback that returns a Promise
      const emitFn = mock(async (_type: string, _payload: unknown) => {
        await Promise.resolve()
      })

      const adapter = createEmitterAdapter(emitter, {
        'slow-event': 'task.completed',
      })
      adapter.start(
        emitFn as unknown as (type: string, payload: unknown) => void,
      )

      expect(() => fire('slow-event', { taskId: 'abc' })).not.toThrow()

      // Allow the async emit to settle
      await new Promise((r) => setTimeout(r, 10))
      expect(emitFn).toHaveBeenCalledTimes(1)
    })

    it('should pass the payload correctly even for async emit handlers', async () => {
      const createEmitterAdapter = await importAdapter()
      const { emitter, fire } = makeMockEmitter()

      const captured: unknown[] = []
      const asyncEmit = async (_type: string, payload: unknown) => {
        await Promise.resolve()
        captured.push(payload)
      }

      const adapter = createEmitterAdapter(emitter, {
        'job-done': 'job.completed',
      })
      adapter.start(
        asyncEmit as unknown as (type: string, payload: unknown) => void,
      )

      fire('job-done', { jobId: '123', result: 'success' })

      await new Promise((r) => setTimeout(r, 10))

      expect(captured).toHaveLength(1)
      expect(captured[0]).toEqual({ jobId: '123', result: 'success' })
    })
  })

  describe('does NOT require Node.js EventEmitter', () => {
    it('module should load without requiring a Node.js-specific EventEmitter import', async () => {
      const mod = await import('../server/adapters/emitter.ts')
      expect(mod).toBeDefined()
    })
  })
})
