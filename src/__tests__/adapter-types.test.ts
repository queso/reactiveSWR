import { describe, expect, it } from 'bun:test'
import type { SchemaResult } from '../types.ts'

/**
 * Type-level tests for SSEAdapter interface and AdapterMapping generic type.
 *
 * These tests verify that:
 * 1. SSEAdapter interface has start() and stop() methods with correct signatures
 * 2. AdapterMapping generic type maps source event names to schema event type keys
 * 3. AdapterMapping rejects mappings to non-existent schema event keys
 * 4. SSEAdapter is exported from src/server/index.ts (reactive-swr/server)
 * 5. Types work correctly with TypeScript strict mode
 *
 * Tests FAIL initially because src/server/adapters/types.ts has not been implemented yet.
 */

describe('SSEAdapter interface', () => {
  it('should be importable as a type from src/server/index.ts', async () => {
    // Verify the module loads without error (type-only export still affects module shape)
    const serverExports = await import('../server/index.ts')
    // SSEAdapter is a type — no runtime value, but module must load
    expect(serverExports).toBeDefined()
  })

  it('should accept a valid synchronous implementation of SSEAdapter', () => {
    // Verify the interface shape at the type level
    // SSEAdapter requires start(emit) and stop() methods
    type SSEAdapter = import('../server/index.ts').SSEAdapter

    const syncAdapter: SSEAdapter = {
      start: (emit: (eventType: string, payload: unknown) => void): void => {
        emit('user.updated', { id: 1 })
      },
      stop: (): void => {
        // cleanup
      },
    }

    expect(typeof syncAdapter.start).toBe('function')
    expect(typeof syncAdapter.stop).toBe('function')
  })

  it('should accept an async implementation of SSEAdapter', () => {
    type SSEAdapter = import('../server/index.ts').SSEAdapter

    const asyncAdapter: SSEAdapter = {
      start: async (
        emit: (eventType: string, payload: unknown) => void,
      ): Promise<void> => {
        await Promise.resolve()
        emit('order.placed', { orderId: '123' })
      },
      stop: async (): Promise<void> => {
        await Promise.resolve()
      },
    }

    expect(typeof asyncAdapter.start).toBe('function')
    expect(typeof asyncAdapter.stop).toBe('function')
  })

  it('start() method should receive an emit callback with (eventType: string, payload: unknown) signature', () => {
    type SSEAdapter = import('../server/index.ts').SSEAdapter

    const capturedEmits: Array<{ eventType: string; payload: unknown }> = []

    const adapter: SSEAdapter = {
      start: (emit: (eventType: string, payload: unknown) => void): void => {
        // Invoke emit to verify the callback signature
        emit('test.event', { data: 'value' })
        emit('another.event', 42)
        emit('null.event', null)
      },
      stop: (): void => {},
    }

    // Call start with a test emit callback to verify the signature
    adapter.start((eventType, payload) => {
      capturedEmits.push({ eventType, payload })
    })

    expect(capturedEmits).toHaveLength(3)
    expect(capturedEmits[0]).toEqual({
      eventType: 'test.event',
      payload: { data: 'value' },
    })
    expect(capturedEmits[1]).toEqual({
      eventType: 'another.event',
      payload: 42,
    })
    expect(capturedEmits[2]).toEqual({ eventType: 'null.event', payload: null })
  })

  it('stop() method should return void or Promise<void>', () => {
    type SSEAdapter = import('../server/index.ts').SSEAdapter

    // Synchronous stop
    const syncAdapter: SSEAdapter = {
      start: (_emit) => {},
      stop: (): void => {},
    }

    const syncResult = syncAdapter.stop()
    // void return — result is undefined
    expect(syncResult).toBeUndefined()

    // Async stop
    const asyncAdapter: SSEAdapter = {
      start: (_emit) => {},
      stop: (): Promise<void> => Promise.resolve(),
    }

    const asyncResult = asyncAdapter.stop()
    expect(asyncResult).toBeInstanceOf(Promise)
  })

  it('should not require any properties beyond start and stop', () => {
    type SSEAdapter = import('../server/index.ts').SSEAdapter

    // Minimal valid implementation — must satisfy the interface with only start and stop
    const minimalAdapter: SSEAdapter = {
      start: (_emit) => {},
      stop: () => {},
    }

    expect(minimalAdapter).toBeDefined()
    expect(Object.keys(minimalAdapter)).toContain('start')
    expect(Object.keys(minimalAdapter)).toContain('stop')
  })
})

describe('AdapterMapping generic type', () => {
  it('should be importable as a type from src/server/index.ts', async () => {
    // Type-only import — verify module loads
    const serverExports = await import('../server/index.ts')
    expect(serverExports).toBeDefined()
  })

  it('should accept a valid mapping from source event names to schema event keys', () => {
    type AdapterMapping<
      S extends SchemaResult<Record<string, { key: string }>>,
    > = import('../server/index.ts').AdapterMapping<S>

    // Define a mock schema result type (as returned by defineSchema())
    type MockSchema = SchemaResult<{
      'user.updated': { key: string }
      'order.placed': { key: string }
      'item.deleted': { key: string }
    }>

    // AdapterMapping maps adapter-level source event names to schema event type keys
    // Source keys are strings (adapter-specific), values must be keyof the schema
    const mapping: AdapterMapping<MockSchema> = {
      update: 'user.updated',
      insert: 'order.placed',
      delete: 'item.deleted',
    }

    expect(mapping.update).toBe('user.updated')
    expect(mapping.insert).toBe('order.placed')
    expect(mapping.delete).toBe('item.deleted')
  })

  it('should allow partial mappings (not all schema events need to be mapped)', () => {
    type AdapterMapping<
      S extends SchemaResult<Record<string, { key: string }>>,
    > = import('../server/index.ts').AdapterMapping<S>

    type MockSchema = SchemaResult<{
      'user.updated': { key: string }
      'order.placed': { key: string }
      'item.deleted': { key: string }
    }>

    // Only mapping a subset of schema events is valid
    const partialMapping: AdapterMapping<MockSchema> = {
      changed: 'user.updated',
    }

    expect(partialMapping.changed).toBe('user.updated')
  })

  it('should allow mapping multiple source events to the same schema event key', () => {
    type AdapterMapping<
      S extends SchemaResult<Record<string, { key: string }>>,
    > = import('../server/index.ts').AdapterMapping<S>

    type MockSchema = SchemaResult<{
      'user.updated': { key: string }
    }>

    // Multiple source events can map to the same schema event
    const mapping: AdapterMapping<MockSchema> = {
      update: 'user.updated',
      replace: 'user.updated',
      patch: 'user.updated',
    }

    expect(mapping.update).toBe('user.updated')
    expect(mapping.replace).toBe('user.updated')
    expect(mapping.patch).toBe('user.updated')
  })

  it('should reject mappings to non-existent schema event keys at compile time', () => {
    // This test verifies via @ts-expect-error that AdapterMapping enforces valid schema keys.
    // The type system should reject any value that is not a key of the schema.

    type AdapterMapping<
      S extends SchemaResult<Record<string, { key: string }>>,
    > = import('../server/index.ts').AdapterMapping<S>

    type MockSchema = SchemaResult<{
      'user.updated': { key: string }
      'order.placed': { key: string }
    }>

    // @ts-expect-error - 'nonexistent.event' is not a key in MockSchema
    const _invalidMapping: AdapterMapping<MockSchema> = {
      someEvent: 'nonexistent.event',
    }

    // Suppress unused variable warning — the test is at the type level
    expect(_invalidMapping).toBeDefined()
  })

  it('should work with an empty mapping (no source events mapped)', () => {
    type AdapterMapping<
      S extends SchemaResult<Record<string, { key: string }>>,
    > = import('../server/index.ts').AdapterMapping<S>

    type MockSchema = SchemaResult<{
      'user.updated': { key: string }
    }>

    // An empty mapping is valid — no source events are mapped yet
    const emptyMapping: AdapterMapping<MockSchema> = {}

    expect(emptyMapping).toBeDefined()
    expect(Object.keys(emptyMapping)).toHaveLength(0)
  })

  it('should work with any string as a source event key', () => {
    type AdapterMapping<
      S extends SchemaResult<Record<string, { key: string }>>,
    > = import('../server/index.ts').AdapterMapping<S>

    type MockSchema = SchemaResult<{
      'data.changed': { key: string }
    }>

    // Source event names (keys) can be any string — adapter-specific
    const mapping: AdapterMapping<MockSchema> = {
      insert: 'data.changed',
      update: 'data.changed',
      'my-custom-event': 'data.changed',
      UPPERCASE_EVENT: 'data.changed',
    }

    expect(Object.keys(mapping)).toHaveLength(4)
  })
})

describe('SSEAdapter exported from reactive-swr/server', () => {
  it('should export SSEAdapter as a type from src/server/index.ts', async () => {
    // The server module must be loadable — SSEAdapter is a type export
    const serverModule = await import('../server/index.ts')

    // createChannel is the existing runtime export from server — verify server module still works
    expect(typeof serverModule.createChannel).toBe('function')
  })

  it('should export AdapterMapping as a type from src/server/index.ts', async () => {
    // Type-only export — verify module loads and existing runtime exports are intact
    const serverModule = await import('../server/index.ts')
    expect(serverModule).toBeDefined()
  })
})

describe('TypeScript strict mode compatibility', () => {
  it('SSEAdapter start() emit callback enforces string eventType', () => {
    type SSEAdapter = import('../server/index.ts').SSEAdapter

    // Verify via type assignment that the emit parameter is typed as
    // (eventType: string, payload: unknown) => void
    // This is a compile-time check — the type must not accept non-string eventType
    type EmitFn = Parameters<SSEAdapter['start']>[0]
    type EventTypeParam = Parameters<EmitFn>[0]
    type PayloadParam = Parameters<EmitFn>[1]

    // If these type assertions compile, the signature is correct
    const _eventTypeCheck: EventTypeParam = 'test.event'
    const _payloadCheck: PayloadParam = { anything: true }

    // @ts-expect-error - eventType must be string, not number
    const _invalidEventType: EventTypeParam = 42

    expect(_eventTypeCheck).toBe('test.event')
    expect(_payloadCheck).toBeDefined()
    expect(_invalidEventType).toBeDefined()
  })

  it('SSEAdapter start() emit callback accepts unknown payload', () => {
    type SSEAdapter = import('../server/index.ts').SSEAdapter

    const payloads: unknown[] = []

    const adapter: SSEAdapter = {
      start: (emit) => {
        // payload is unknown — any value is valid
        emit('event.one', { id: 1 })
        emit('event.two', 'a string payload')
        emit('event.three', null)
        emit('event.four', undefined)
        emit('event.five', [1, 2, 3])
      },
      stop: () => {},
    }

    adapter.start((_type, payload) => {
      payloads.push(payload)
    })

    expect(payloads).toHaveLength(5)
    expect(payloads[0]).toEqual({ id: 1 })
    expect(payloads[1]).toBe('a string payload')
    expect(payloads[2]).toBeNull()
    expect(payloads[3]).toBeUndefined()
    expect(payloads[4]).toEqual([1, 2, 3])
  })
})
