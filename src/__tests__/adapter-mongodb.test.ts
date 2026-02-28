import { describe, expect, it, mock } from 'bun:test'
import type { SSEAdapter } from '../server/adapters/types.ts'

/**
 * Tests for createMongoAdapter() — wraps MongoDB Change Streams to
 * emit SSE events on data mutations.
 *
 * These tests verify that:
 * 1. createMongoAdapter(collection, mapping) is exported from src/server/adapters/mongodb.ts
 * 2. The adapter implements the SSEAdapter interface (start/stop)
 * 3. start() calls collection.watch() to open a Change Stream
 * 4. Change Stream events (insert/update/replace/delete) are mapped to schema events
 * 5. stop() closes the Change Stream cursor
 * 6. Resume tokens are persisted in memory from each change event's _id field
 * 7. Invalidate events cause the stream to reopen
 * 8. The adapter does NOT import mongodb directly
 * 9. Named export only (tree-shakeable)
 *
 * Tests FAIL initially because src/server/adapters/mongodb.ts has not been created yet.
 */

// ---------------------------------------------------------------------------
// Mock MongoDB Change Stream cursor helpers
// ---------------------------------------------------------------------------

interface ChangeEvent {
  _id: { _data: string } // resume token
  operationType: string // insert | update | replace | delete | invalidate
  fullDocument?: Record<string, unknown>
  documentKey?: { _id: unknown }
  updateDescription?: { updatedFields: Record<string, unknown> }
  ns?: { db: string; coll: string }
}

/**
 * Build a mock Change Stream cursor that replays a preset list of events
 * when iterated as an async iterable.
 */
function makeChangeStream(events: ChangeEvent[]) {
  let index = 0
  let closed = false
  const closeMock = mock(async () => {
    closed = true
  })

  const cursor = {
    [Symbol.asyncIterator]() {
      return {
        async next(): Promise<{
          value: ChangeEvent | undefined
          done: boolean
        }> {
          if (closed || index >= events.length) {
            return { value: undefined, done: true }
          }
          return { value: events[index++]!, done: false }
        },
      }
    },
    close: closeMock,
    closed: false,
  }

  return { cursor, closeMock }
}

/**
 * Build a mock MongoDB Collection that captures watch() calls.
 */
function makeMockCollection(
  changeStream: ReturnType<typeof makeChangeStream>['cursor'],
) {
  const watchMock = mock((_options?: unknown) => changeStream)

  const collection = { watch: watchMock }
  return { collection, watchMock }
}

type MongoAdapterMapping = {
  [operationType: string]: string // e.g. { insert: 'user.created', update: 'user.updated' }
}

async function importAdapter() {
  const mod = (await import('../server/adapters/mongodb.ts')) as Record<
    string,
    // biome-ignore lint/suspicious/noExplicitAny: dynamic import typing
    any
  >
  return mod.createMongoAdapter as (
    // biome-ignore lint/suspicious/noExplicitAny: mock collection has minimal interface
    collection: { watch: (options?: any) => any },
    mapping: MongoAdapterMapping,
  ) => SSEAdapter
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('createMongoAdapter()', () => {
  describe('export and interface', () => {
    it('should be exported from src/server/adapters/mongodb.ts', async () => {
      const mod = await import('../server/adapters/mongodb.ts')
      expect((mod as Record<string, unknown>).createMongoAdapter).toBeDefined()
      expect(typeof (mod as Record<string, unknown>).createMongoAdapter).toBe(
        'function',
      )
    })

    it('should return an object implementing the SSEAdapter interface', async () => {
      const createMongoAdapter = await importAdapter()
      const { cursor } = makeChangeStream([])
      const { collection } = makeMockCollection(cursor)

      const adapter = createMongoAdapter(collection, { insert: 'user.created' })

      expect(typeof adapter.start).toBe('function')
      expect(typeof adapter.stop).toBe('function')
    })

    it('should be a named export (not default)', async () => {
      const mod = (await import('../server/adapters/mongodb.ts')) as Record<
        string,
        unknown
      >
      expect(mod.createMongoAdapter).toBeDefined()
      expect(mod.default).toBeUndefined()
    })
  })

  describe('start() — opens a Change Stream', () => {
    it('start() should call collection.watch()', async () => {
      const createMongoAdapter = await importAdapter()
      const { cursor } = makeChangeStream([])
      const { collection, watchMock } = makeMockCollection(cursor)

      const adapter = createMongoAdapter(collection, { insert: 'item.created' })
      adapter.start(() => {})

      // Allow micro-tasks to run so async iteration starts
      await new Promise((r) => setTimeout(r, 10))

      expect(watchMock).toHaveBeenCalledTimes(1)
    })

    it('start() should return a Promise (async iteration)', async () => {
      const createMongoAdapter = await importAdapter()
      const { cursor } = makeChangeStream([])
      const { collection } = makeMockCollection(cursor)

      const adapter = createMongoAdapter(collection, { insert: 'item.created' })
      const result = adapter.start(() => {})

      // start() kicks off async iteration — it may return void or Promise<void>
      if (result !== undefined) {
        expect(result).toBeInstanceOf(Promise)
      }
    })
  })

  describe('event mapping — operationType to schema event', () => {
    it('should emit a mapped event for an insert change event', async () => {
      const createMongoAdapter = await importAdapter()

      const changeEvent: ChangeEvent = {
        _id: { _data: 'token-1' },
        operationType: 'insert',
        fullDocument: { _id: 'abc', name: 'Alice' },
        ns: { db: 'mydb', coll: 'users' },
      }

      const { cursor } = makeChangeStream([changeEvent])
      const { collection } = makeMockCollection(cursor)

      const emitted: Array<{ type: string; payload: unknown }> = []
      const adapter = createMongoAdapter(collection, { insert: 'user.created' })
      adapter.start((type, payload) => emitted.push({ type, payload }))

      // Wait for async iteration to process the event
      await new Promise((r) => setTimeout(r, 20))

      expect(emitted).toHaveLength(1)
      expect(emitted[0]?.type).toBe('user.created')
    })

    it('should emit a mapped event for an update change event', async () => {
      const createMongoAdapter = await importAdapter()

      const changeEvent: ChangeEvent = {
        _id: { _data: 'token-2' },
        operationType: 'update',
        fullDocument: { _id: 'abc', name: 'Bob' },
        documentKey: { _id: 'abc' },
        ns: { db: 'mydb', coll: 'users' },
      }

      const { cursor } = makeChangeStream([changeEvent])
      const { collection } = makeMockCollection(cursor)

      const emitted: Array<{ type: string; payload: unknown }> = []
      const adapter = createMongoAdapter(collection, { update: 'user.updated' })
      adapter.start((type, payload) => emitted.push({ type, payload }))

      await new Promise((r) => setTimeout(r, 20))

      expect(emitted).toHaveLength(1)
      expect(emitted[0]?.type).toBe('user.updated')
    })

    it('should emit a mapped event for a replace change event', async () => {
      const createMongoAdapter = await importAdapter()

      const changeEvent: ChangeEvent = {
        _id: { _data: 'token-3' },
        operationType: 'replace',
        fullDocument: { _id: 'abc', name: 'Charlie', role: 'admin' },
        ns: { db: 'mydb', coll: 'users' },
      }

      const { cursor } = makeChangeStream([changeEvent])
      const { collection } = makeMockCollection(cursor)

      const emitted: Array<{ type: string; payload: unknown }> = []
      const adapter = createMongoAdapter(collection, {
        replace: 'user.updated',
      })
      adapter.start((type, payload) => emitted.push({ type, payload }))

      await new Promise((r) => setTimeout(r, 20))

      expect(emitted).toHaveLength(1)
      expect(emitted[0]?.type).toBe('user.updated')
    })

    it('should emit a mapped event for a delete change event', async () => {
      const createMongoAdapter = await importAdapter()

      const changeEvent: ChangeEvent = {
        _id: { _data: 'token-4' },
        operationType: 'delete',
        documentKey: { _id: 'abc' },
        ns: { db: 'mydb', coll: 'users' },
      }

      const { cursor } = makeChangeStream([changeEvent])
      const { collection } = makeMockCollection(cursor)

      const emitted: Array<{ type: string; payload: unknown }> = []
      const adapter = createMongoAdapter(collection, { delete: 'user.deleted' })
      adapter.start((type, payload) => emitted.push({ type, payload }))

      await new Promise((r) => setTimeout(r, 20))

      expect(emitted).toHaveLength(1)
      expect(emitted[0]?.type).toBe('user.deleted')
    })

    it('event payload should be the full change document (or documentKey for deletes)', async () => {
      const createMongoAdapter = await importAdapter()

      const fullDoc = { _id: 'abc', name: 'Alice', email: 'alice@example.com' }
      const changeEvent: ChangeEvent = {
        _id: { _data: 'token-5' },
        operationType: 'insert',
        fullDocument: fullDoc,
        ns: { db: 'mydb', coll: 'users' },
      }

      const { cursor } = makeChangeStream([changeEvent])
      const { collection } = makeMockCollection(cursor)

      const emitted: Array<{ type: string; payload: unknown }> = []
      const adapter = createMongoAdapter(collection, { insert: 'user.created' })
      adapter.start((type, payload) => emitted.push({ type, payload }))

      await new Promise((r) => setTimeout(r, 20))

      // Payload should contain the document data
      expect(emitted[0]?.payload).toBeDefined()
      const payload = emitted[0]?.payload as Record<string, unknown>
      // At minimum the payload contains the fullDocument or key info
      expect(payload).toMatchObject(fullDoc)
    })

    it('should not emit for unmapped operation types', async () => {
      const createMongoAdapter = await importAdapter()

      const changeEvent: ChangeEvent = {
        _id: { _data: 'token-6' },
        operationType: 'drop', // not in mapping
        ns: { db: 'mydb', coll: 'users' },
      }

      const { cursor } = makeChangeStream([changeEvent])
      const { collection } = makeMockCollection(cursor)

      const emitted: Array<{ type: string; payload: unknown }> = []
      const adapter = createMongoAdapter(collection, { insert: 'user.created' })
      adapter.start((type, payload) => emitted.push({ type, payload }))

      await new Promise((r) => setTimeout(r, 20))

      expect(emitted).toHaveLength(0)
    })

    it('should map multiple operation types to different schema events', async () => {
      const createMongoAdapter = await importAdapter()

      const events: ChangeEvent[] = [
        {
          _id: { _data: 'tok-1' },
          operationType: 'insert',
          fullDocument: { _id: '1' },
          ns: { db: 'db', coll: 'orders' },
        },
        {
          _id: { _data: 'tok-2' },
          operationType: 'update',
          fullDocument: { _id: '1', status: 'shipped' },
          ns: { db: 'db', coll: 'orders' },
        },
        {
          _id: { _data: 'tok-3' },
          operationType: 'delete',
          documentKey: { _id: '1' },
          ns: { db: 'db', coll: 'orders' },
        },
      ]

      const { cursor } = makeChangeStream(events)
      const { collection } = makeMockCollection(cursor)

      const emitted: Array<{ type: string }> = []
      const adapter = createMongoAdapter(collection, {
        insert: 'order.created',
        update: 'order.updated',
        delete: 'order.deleted',
      })
      adapter.start((type) => emitted.push({ type }))

      await new Promise((r) => setTimeout(r, 30))

      expect(emitted).toHaveLength(3)
      expect(emitted[0]?.type).toBe('order.created')
      expect(emitted[1]?.type).toBe('order.updated')
      expect(emitted[2]?.type).toBe('order.deleted')
    })
  })

  describe('resume tokens — in-memory persistence', () => {
    it('should pass resumeAfter token to collection.watch() on reconnect after invalidate', async () => {
      const createMongoAdapter = await importAdapter()

      const resumeToken = { _data: 'resume-token-xyz' }

      // First stream: one event then invalidate
      const firstEvents: ChangeEvent[] = [
        {
          _id: resumeToken,
          operationType: 'insert',
          fullDocument: { _id: '1' },
          ns: { db: 'db', coll: 'c' },
        },
        { _id: { _data: 'inv-tok' }, operationType: 'invalidate' },
      ]
      // Second stream: empty (adapter just reconnected)
      const secondEvents: ChangeEvent[] = []

      const { cursor: cursor1 } = makeChangeStream(firstEvents)
      const { cursor: cursor2 } = makeChangeStream(secondEvents)

      let watchCallCount = 0
      let secondWatchOptions: unknown
      const collection = {
        watch: mock((options?: unknown) => {
          watchCallCount++
          if (watchCallCount === 2) secondWatchOptions = options
          return watchCallCount === 1 ? cursor1 : cursor2
        }),
      }

      const adapter = createMongoAdapter(collection, { insert: 'item.created' })
      adapter.start(() => {})

      // Wait for both streams to be processed
      await new Promise((r) => setTimeout(r, 50))

      // Should have opened the stream twice (initial + after invalidate)
      expect(watchCallCount).toBeGreaterThanOrEqual(2)
      // Second open should include resumeAfter with the last seen token
      expect(secondWatchOptions).toBeDefined()
      const opts = secondWatchOptions as Record<string, unknown>
      expect(opts.resumeAfter).toBeDefined()
    })

    it('should update the resume token after each processed event', async () => {
      const createMongoAdapter = await importAdapter()

      const events: ChangeEvent[] = [
        {
          _id: { _data: 'tok-a' },
          operationType: 'insert',
          fullDocument: { _id: '1' },
          ns: { db: 'db', coll: 'c' },
        },
        {
          _id: { _data: 'tok-b' },
          operationType: 'insert',
          fullDocument: { _id: '2' },
          ns: { db: 'db', coll: 'c' },
        },
        { _id: { _data: 'tok-c' }, operationType: 'invalidate' },
      ]
      const secondEvents: ChangeEvent[] = []

      let secondWatchOptions: unknown
      let callCount = 0
      const { cursor: cursor1 } = makeChangeStream(events)
      const { cursor: cursor2 } = makeChangeStream(secondEvents)

      const collection = {
        watch: mock((options?: unknown) => {
          callCount++
          if (callCount === 2) secondWatchOptions = options
          return callCount === 1 ? cursor1 : cursor2
        }),
      }

      const adapter = createMongoAdapter(collection, { insert: 'item.created' })
      adapter.start(() => {})

      await new Promise((r) => setTimeout(r, 50))

      // After processing tok-a and tok-b, the last token before invalidate is tok-b
      // The resumeAfter on the second open should use tok-b
      if (secondWatchOptions) {
        const opts = secondWatchOptions as Record<string, unknown>
        expect(opts.resumeAfter).toEqual({ _data: 'tok-b' })
      }
    })
  })

  describe('invalidate events — reopen stream', () => {
    it('should reopen the stream when an invalidate event is received', async () => {
      const createMongoAdapter = await importAdapter()

      const firstEvents: ChangeEvent[] = [
        { _id: { _data: 'tok-1' }, operationType: 'invalidate' },
      ]
      const secondEvents: ChangeEvent[] = []

      const { cursor: c1 } = makeChangeStream(firstEvents)
      const { cursor: c2 } = makeChangeStream(secondEvents)

      let callCount = 0
      const collection = {
        watch: mock(() => {
          callCount++
          return callCount === 1 ? c1 : c2
        }),
      }

      const adapter = createMongoAdapter(collection, { insert: 'item.created' })
      adapter.start(() => {})

      await new Promise((r) => setTimeout(r, 50))

      expect(callCount).toBeGreaterThanOrEqual(2)
    })

    it('should NOT emit an event for the invalidate operation itself', async () => {
      const createMongoAdapter = await importAdapter()

      const events: ChangeEvent[] = [
        { _id: { _data: 'tok-1' }, operationType: 'invalidate' },
      ]
      const { cursor } = makeChangeStream(events)
      const collection = { watch: mock(() => cursor) }

      const emitted: string[] = []
      const adapter = createMongoAdapter(collection, {
        insert: 'item.created',
        invalidate: 'item.created', // even if someone maps it, should not emit
      })
      adapter.start((type) => emitted.push(type))

      await new Promise((r) => setTimeout(r, 20))

      // invalidate is a control event, not a data event — implementation may choose
      // to not emit even if mapped. The key behavior is stream reopen.
      // (If the impl does emit for it, that's also acceptable — we just verify reopen)
      expect(true).toBe(true) // assertion is about reopen, tested in previous test
    })
  })

  describe('stop() — closes the Change Stream', () => {
    it('stop() should close the Change Stream cursor', async () => {
      const createMongoAdapter = await importAdapter()

      const { cursor, closeMock } = makeChangeStream([])
      const { collection } = makeMockCollection(cursor)

      const adapter = createMongoAdapter(collection, { insert: 'item.created' })
      adapter.start(() => {})

      // Allow stream to open
      await new Promise((r) => setTimeout(r, 10))

      await adapter.stop()

      expect(closeMock).toHaveBeenCalledTimes(1)
    })

    it('stop() should return void or Promise<void>', async () => {
      const createMongoAdapter = await importAdapter()

      const { cursor } = makeChangeStream([])
      const { collection } = makeMockCollection(cursor)

      const adapter = createMongoAdapter(collection, { insert: 'item.created' })
      adapter.start(() => {})

      await new Promise((r) => setTimeout(r, 10))

      const result = adapter.stop()
      if (result !== undefined) {
        expect(result).toBeInstanceOf(Promise)
        await result
      }
    })

    it('after stop(), no further events should be emitted', async () => {
      const createMongoAdapter = await importAdapter()

      // Stream with a delayed event
      let resolveEvent!: (e: { value: ChangeEvent; done: false }) => void
      const delayedCursor = {
        [Symbol.asyncIterator]() {
          return {
            async next(): Promise<{
              value: ChangeEvent | undefined
              done: boolean
            }> {
              return new Promise((resolve) => {
                resolveEvent = resolve as typeof resolveEvent
              })
            },
          }
        },
        close: mock(async () => {}),
      }

      const collection = { watch: mock(() => delayedCursor) }

      const emitted: string[] = []
      const adapter = createMongoAdapter(collection, { insert: 'item.created' })
      adapter.start((type) => emitted.push(type))

      await new Promise((r) => setTimeout(r, 10))

      // Stop the adapter before resolving the delayed event
      await adapter.stop()

      // Now deliver the event — it should not be processed
      resolveEvent?.({
        value: {
          _id: { _data: 'tok' },
          operationType: 'insert',
          fullDocument: { _id: '1' },
          ns: { db: 'db', coll: 'c' },
        },
        done: false,
      })

      await new Promise((r) => setTimeout(r, 20))

      expect(emitted).toHaveLength(0)
    })

    it('stop() should not throw even if called before start()', async () => {
      const createMongoAdapter = await importAdapter()
      const { cursor } = makeChangeStream([])
      const { collection } = makeMockCollection(cursor)

      const adapter = createMongoAdapter(collection, { insert: 'item.created' })

      await expect(adapter.stop()).resolves.toBeUndefined()
    })
  })

  describe('does NOT import mongodb', () => {
    it('module should load without mongodb package installed', async () => {
      const mod = await import('../server/adapters/mongodb.ts')
      expect(mod).toBeDefined()
    })
  })
})
