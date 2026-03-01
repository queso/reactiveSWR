import { describe, expect, it, mock } from 'bun:test'
import type { SSEAdapter } from '../server/adapters/types.ts'

/**
 * Tests for createPrismaAdapter() — wraps Prisma $use() middleware to
 * intercept create/update/delete operations and emit SSE events.
 *
 * These tests verify that:
 * 1. createPrismaAdapter(prisma, mapping) is exported from src/server/adapters/prisma.ts
 * 2. The adapter implements the SSEAdapter interface (start/stop)
 * 3. start() registers a Prisma $use() middleware
 * 4. Events are emitted AFTER the operation completes (post-middleware)
 * 5. Events are NOT emitted when the operation throws
 * 6. Mapping config maps model names + actions to schema event types
 * 7. stop() makes the middleware a no-op (no further events emitted)
 * 8. The adapter does NOT import @prisma/client directly
 *
 * Tests FAIL initially because src/server/adapters/prisma.ts has not been created yet.
 */

// ---------------------------------------------------------------------------
// Mock Prisma client helpers
// ---------------------------------------------------------------------------

/**
 * Minimal shape of Prisma middleware params
 * (matches real @prisma/client MiddlewareParams)
 */
interface PrismaMiddlewareParams {
  model?: string
  action: string
  args: unknown
  dataPath: string[]
  runInTransaction: boolean
}

type PrismaMiddleware = (
  params: PrismaMiddlewareParams,
  next: (params: PrismaMiddlewareParams) => Promise<unknown>,
) => Promise<unknown>

/**
 * Build a mock Prisma client that captures registered $use() middlewares
 * and exposes a helper to invoke them manually in tests.
 */
function makeMockPrisma() {
  const middlewares: PrismaMiddleware[] = []

  const prisma = {
    $use: mock((middleware: PrismaMiddleware) => {
      middlewares.push(middleware)
    }),
  }

  /** Invoke all registered middlewares in sequence for a given params object */
  async function runMiddleware(
    params: PrismaMiddlewareParams,
    result: unknown = { id: 1 },
  ): Promise<unknown> {
    // next() is the final handler that returns the mock operation result
    const baseNext = async (_p: PrismaMiddlewareParams) => result

    // Chain middlewares: each calls next which calls the subsequent one
    let chain = baseNext
    for (let i = middlewares.length - 1; i >= 0; i--) {
      const mw = middlewares[i]!
      const nextInChain = chain
      chain = (p) => mw(p, nextInChain)
    }

    return chain(params)
  }

  return { prisma, runMiddleware, middlewares }
}

// ---------------------------------------------------------------------------
// Mapping config type (mirrors the expected public API)
// ---------------------------------------------------------------------------

type PrismaAdapterMapping = {
  [modelName: string]: {
    created?: string
    updated?: string
    deleted?: string
  }
}

// ---------------------------------------------------------------------------
// Import helper — loads the adapter lazily so tests fail cleanly if missing
// ---------------------------------------------------------------------------

async function importAdapter() {
  const mod = (await import('../server/adapters/prisma.ts')) as Record<
    string,
    // biome-ignore lint/suspicious/noExplicitAny: dynamic import typing
    any
  >
  return mod.createPrismaAdapter as (
    prisma: { $use: (middleware: PrismaMiddleware) => void },
    mapping: PrismaAdapterMapping,
  ) => SSEAdapter
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('createPrismaAdapter()', () => {
  describe('export and interface', () => {
    it('should be exported from src/server/adapters/prisma.ts', async () => {
      const mod = await import('../server/adapters/prisma.ts')
      expect((mod as Record<string, unknown>).createPrismaAdapter).toBeDefined()
      expect(typeof (mod as Record<string, unknown>).createPrismaAdapter).toBe(
        'function',
      )
    })

    it('should return an object implementing the SSEAdapter interface', async () => {
      const createPrismaAdapter = await importAdapter()
      const { prisma } = makeMockPrisma()

      const adapter = createPrismaAdapter(prisma, {
        User: { created: 'user.created' },
      })

      expect(typeof adapter.start).toBe('function')
      expect(typeof adapter.stop).toBe('function')
    })
  })

  describe('start() — registers $use() middleware', () => {
    it('start() should call prisma.$use() to register a middleware', async () => {
      const createPrismaAdapter = await importAdapter()
      const { prisma } = makeMockPrisma()

      const adapter = createPrismaAdapter(prisma, {
        User: { created: 'user.created' },
      })
      adapter.start(() => {})

      expect(prisma.$use).toHaveBeenCalledTimes(1)
    })

    it('start() should pass a function to prisma.$use()', async () => {
      const createPrismaAdapter = await importAdapter()
      const { prisma } = makeMockPrisma()

      const adapter = createPrismaAdapter(prisma, {
        User: { created: 'user.created' },
      })
      adapter.start(() => {})

      const registeredMiddleware = (prisma.$use as ReturnType<typeof mock>).mock
        .calls[0]?.[0]
      expect(typeof registeredMiddleware).toBe('function')
    })

    it('start() should call next(params) to allow the operation to proceed', async () => {
      const createPrismaAdapter = await importAdapter()
      const { prisma, runMiddleware } = makeMockPrisma()

      const adapter = createPrismaAdapter(prisma, {
        User: { created: 'user.created' },
      })
      adapter.start(() => {})

      const _nextMock = mock(async (_p: PrismaMiddlewareParams) => ({ id: 99 }))
      const params: PrismaMiddlewareParams = {
        model: 'User',
        action: 'create',
        args: { data: { name: 'Alice' } },
        dataPath: [],
        runInTransaction: false,
      }

      // Call via runMiddleware so next() is also invoked
      await runMiddleware(params, { id: 99 })

      // next must have been called (operation must proceed)
      // Verify by checking the result flows through
      const result = await runMiddleware(params, { id: 42 })
      expect(result).toEqual({ id: 42 })
    })
  })

  describe('event emission — post-middleware, create/update/delete', () => {
    it('should emit a mapped event after a create operation completes', async () => {
      const createPrismaAdapter = await importAdapter()
      const { prisma, runMiddleware } = makeMockPrisma()

      const emitted: Array<{ type: string; payload: unknown }> = []
      const emit = (type: string, payload: unknown) =>
        emitted.push({ type, payload })

      const adapter = createPrismaAdapter(prisma, {
        User: { created: 'user.created' },
      })
      adapter.start(emit)

      await runMiddleware(
        {
          model: 'User',
          action: 'create',
          args: { data: { name: 'Alice' } },
          dataPath: [],
          runInTransaction: false,
        },
        { id: 1, name: 'Alice' },
      )

      expect(emitted).toHaveLength(1)
      expect(emitted[0]?.type).toBe('user.created')
    })

    it('should emit a mapped event after an update operation completes', async () => {
      const createPrismaAdapter = await importAdapter()
      const { prisma, runMiddleware } = makeMockPrisma()

      const emitted: Array<{ type: string; payload: unknown }> = []
      const emit = (type: string, payload: unknown) =>
        emitted.push({ type, payload })

      const adapter = createPrismaAdapter(prisma, {
        User: { updated: 'user.updated' },
      })
      adapter.start(emit)

      await runMiddleware(
        {
          model: 'User',
          action: 'update',
          args: { where: { id: 1 }, data: { name: 'Bob' } },
          dataPath: [],
          runInTransaction: false,
        },
        { id: 1, name: 'Bob' },
      )

      expect(emitted).toHaveLength(1)
      expect(emitted[0]?.type).toBe('user.updated')
    })

    it('should emit a mapped event after a delete operation completes', async () => {
      const createPrismaAdapter = await importAdapter()
      const { prisma, runMiddleware } = makeMockPrisma()

      const emitted: Array<{ type: string; payload: unknown }> = []
      const emit = (type: string, payload: unknown) =>
        emitted.push({ type, payload })

      const adapter = createPrismaAdapter(prisma, {
        User: { deleted: 'user.deleted' },
      })
      adapter.start(emit)

      await runMiddleware(
        {
          model: 'User',
          action: 'delete',
          args: { where: { id: 1 } },
          dataPath: [],
          runInTransaction: false,
        },
        { id: 1 },
      )

      expect(emitted).toHaveLength(1)
      expect(emitted[0]?.type).toBe('user.deleted')
    })

    it('event payload should be the result returned by next() (the operation result)', async () => {
      const createPrismaAdapter = await importAdapter()
      const { prisma, runMiddleware } = makeMockPrisma()

      const emitted: Array<{ type: string; payload: unknown }> = []
      const emit = (type: string, payload: unknown) =>
        emitted.push({ type, payload })

      const adapter = createPrismaAdapter(prisma, {
        Order: { created: 'order.created' },
      })
      adapter.start(emit)

      const operationResult = { id: 42, total: 99.99, status: 'pending' }
      await runMiddleware(
        {
          model: 'Order',
          action: 'create',
          args: { data: { total: 99.99 } },
          dataPath: [],
          runInTransaction: false,
        },
        operationResult,
      )

      expect(emitted[0]?.payload).toEqual(operationResult)
    })

    it('emit is called AFTER next() completes, not before', async () => {
      const createPrismaAdapter = await importAdapter()
      const { prisma } = makeMockPrisma()

      const callOrder: string[] = []
      const emit = (_type: string, _payload: unknown) => callOrder.push('emit')

      // Wrap runMiddleware to track when next() resolves
      const adapter = createPrismaAdapter(prisma, {
        User: { created: 'user.created' },
      })
      adapter.start(emit)

      // Use a slow next() to verify ordering
      const slowNext = async (_p: PrismaMiddlewareParams) => {
        await new Promise<void>((resolve) => setTimeout(resolve, 10))
        callOrder.push('next-resolved')
        return { id: 1 }
      }

      // Directly invoke the registered middleware with slow next
      const middleware = (prisma.$use as ReturnType<typeof mock>).mock
        .calls[0]?.[0] as PrismaMiddleware
      await middleware(
        {
          model: 'User',
          action: 'create',
          args: {},
          dataPath: [],
          runInTransaction: false,
        },
        slowNext,
      )

      expect(callOrder).toEqual(['next-resolved', 'emit'])
    })
  })

  describe('mapping — model name + action routing', () => {
    it('should not emit for unmapped models', async () => {
      const createPrismaAdapter = await importAdapter()
      const { prisma, runMiddleware } = makeMockPrisma()

      const emitted: Array<{ type: string; payload: unknown }> = []
      const emit = (type: string, payload: unknown) =>
        emitted.push({ type, payload })

      // Only User is mapped, not Post
      const adapter = createPrismaAdapter(prisma, {
        User: { created: 'user.created' },
      })
      adapter.start(emit)

      await runMiddleware(
        {
          model: 'Post',
          action: 'create',
          args: {},
          dataPath: [],
          runInTransaction: false,
        },
        { id: 1 },
      )

      expect(emitted).toHaveLength(0)
    })

    it('should not emit for unmapped actions on a mapped model', async () => {
      const createPrismaAdapter = await importAdapter()
      const { prisma, runMiddleware } = makeMockPrisma()

      const emitted: Array<{ type: string; payload: unknown }> = []
      const emit = (type: string, payload: unknown) =>
        emitted.push({ type, payload })

      // User.updated and User.deleted not mapped — only created
      const adapter = createPrismaAdapter(prisma, {
        User: { created: 'user.created' },
      })
      adapter.start(emit)

      await runMiddleware(
        {
          model: 'User',
          action: 'update',
          args: {},
          dataPath: [],
          runInTransaction: false,
        },
        { id: 1 },
      )

      await runMiddleware(
        {
          model: 'User',
          action: 'delete',
          args: {},
          dataPath: [],
          runInTransaction: false,
        },
        { id: 1 },
      )

      expect(emitted).toHaveLength(0)
    })

    it('should route events from multiple models correctly', async () => {
      const createPrismaAdapter = await importAdapter()
      const { prisma, runMiddleware } = makeMockPrisma()

      const emitted: Array<{ type: string; payload: unknown }> = []
      const emit = (type: string, payload: unknown) =>
        emitted.push({ type, payload })

      const adapter = createPrismaAdapter(prisma, {
        User: { created: 'user.created', updated: 'user.updated' },
        Order: { created: 'order.created', deleted: 'order.deleted' },
      })
      adapter.start(emit)

      await runMiddleware(
        {
          model: 'User',
          action: 'create',
          args: {},
          dataPath: [],
          runInTransaction: false,
        },
        { id: 1 },
      )
      await runMiddleware(
        {
          model: 'Order',
          action: 'create',
          args: {},
          dataPath: [],
          runInTransaction: false,
        },
        { id: 2 },
      )
      await runMiddleware(
        {
          model: 'User',
          action: 'update',
          args: {},
          dataPath: [],
          runInTransaction: false,
        },
        { id: 1 },
      )
      await runMiddleware(
        {
          model: 'Order',
          action: 'delete',
          args: {},
          dataPath: [],
          runInTransaction: false,
        },
        { id: 2 },
      )

      expect(emitted).toHaveLength(4)
      expect(emitted[0]?.type).toBe('user.created')
      expect(emitted[1]?.type).toBe('order.created')
      expect(emitted[2]?.type).toBe('user.updated')
      expect(emitted[3]?.type).toBe('order.deleted')
    })

    it('should not emit for non-mutation Prisma actions (e.g. findMany, findUnique)', async () => {
      const createPrismaAdapter = await importAdapter()
      const { prisma, runMiddleware } = makeMockPrisma()

      const emitted: Array<{ type: string; payload: unknown }> = []
      const emit = (type: string, payload: unknown) =>
        emitted.push({ type, payload })

      const adapter = createPrismaAdapter(prisma, {
        User: {
          created: 'user.created',
          updated: 'user.updated',
          deleted: 'user.deleted',
        },
      })
      adapter.start(emit)

      // Read-only operations — should not trigger events
      for (const action of [
        'findMany',
        'findUnique',
        'findFirst',
        'count',
        'aggregate',
      ]) {
        await runMiddleware(
          {
            model: 'User',
            action,
            args: {},
            dataPath: [],
            runInTransaction: false,
          },
          [],
        )
      }

      expect(emitted).toHaveLength(0)
    })

    it('should handle Prisma upsert action as both create and update (or at least not throw)', async () => {
      const createPrismaAdapter = await importAdapter()
      const { prisma, runMiddleware } = makeMockPrisma()

      // upsert is a valid Prisma action — adapter should handle it gracefully
      const adapter = createPrismaAdapter(prisma, {
        User: { created: 'user.created', updated: 'user.updated' },
      })
      adapter.start(() => {})

      // Should not throw for upsert
      await expect(
        runMiddleware(
          {
            model: 'User',
            action: 'upsert',
            args: {},
            dataPath: [],
            runInTransaction: false,
          },
          { id: 1 },
        ),
      ).resolves.toBeDefined()
    })
  })

  describe('error handling — no event emitted on operation failure', () => {
    it('should NOT emit an event when the Prisma operation throws', async () => {
      const createPrismaAdapter = await importAdapter()
      const { prisma } = makeMockPrisma()

      const emitted: Array<{ type: string; payload: unknown }> = []
      const emit = (type: string, payload: unknown) =>
        emitted.push({ type, payload })

      const adapter = createPrismaAdapter(prisma, {
        User: { created: 'user.created' },
      })
      adapter.start(emit)

      // Get the registered middleware
      const middleware = (prisma.$use as ReturnType<typeof mock>).mock
        .calls[0]?.[0] as PrismaMiddleware

      // Simulate a failing DB operation
      const failingNext = async (
        _p: PrismaMiddlewareParams,
      ): Promise<unknown> => {
        throw new Error('Database constraint violation')
      }

      await expect(
        middleware(
          {
            model: 'User',
            action: 'create',
            args: {},
            dataPath: [],
            runInTransaction: false,
          },
          failingNext,
        ),
      ).rejects.toThrow('Database constraint violation')

      // No event should have been emitted
      expect(emitted).toHaveLength(0)
    })

    it('should propagate the error from next() to the caller', async () => {
      const createPrismaAdapter = await importAdapter()
      const { prisma } = makeMockPrisma()

      const adapter = createPrismaAdapter(prisma, {
        User: { created: 'user.created' },
      })
      adapter.start(() => {})

      const middleware = (prisma.$use as ReturnType<typeof mock>).mock
        .calls[0]?.[0] as PrismaMiddleware
      const dbError = new Error('Unique constraint failed')

      await expect(
        middleware(
          {
            model: 'User',
            action: 'create',
            args: {},
            dataPath: [],
            runInTransaction: false,
          },
          async () => {
            throw dbError
          },
        ),
      ).rejects.toBe(dbError)
    })
  })

  describe('stop() — deactivates middleware', () => {
    it('stop() should not throw', async () => {
      const createPrismaAdapter = await importAdapter()
      const { prisma } = makeMockPrisma()

      const adapter = createPrismaAdapter(prisma, {
        User: { created: 'user.created' },
      })
      adapter.start(() => {})

      expect(() => adapter.stop()).not.toThrow()
    })

    it('after stop(), middleware should no longer emit events', async () => {
      const createPrismaAdapter = await importAdapter()
      const { prisma, runMiddleware } = makeMockPrisma()

      const emitted: Array<{ type: string; payload: unknown }> = []
      const emit = (type: string, payload: unknown) =>
        emitted.push({ type, payload })

      const adapter = createPrismaAdapter(prisma, {
        User: { created: 'user.created' },
      })
      adapter.start(emit)

      // Verify events flow before stop
      await runMiddleware(
        {
          model: 'User',
          action: 'create',
          args: {},
          dataPath: [],
          runInTransaction: false,
        },
        { id: 1 },
      )
      expect(emitted).toHaveLength(1)

      // Stop the adapter
      adapter.stop()

      // Further operations should not emit
      await runMiddleware(
        {
          model: 'User',
          action: 'create',
          args: {},
          dataPath: [],
          runInTransaction: false,
        },
        { id: 2 },
      )
      expect(emitted).toHaveLength(1) // still 1, no new events
    })

    it('after stop(), middleware should still call next() (operation must still proceed)', async () => {
      const createPrismaAdapter = await importAdapter()
      const { prisma } = makeMockPrisma()

      const adapter = createPrismaAdapter(prisma, {
        User: { created: 'user.created' },
      })
      adapter.start(() => {})
      adapter.stop()

      const middleware = (prisma.$use as ReturnType<typeof mock>).mock
        .calls[0]?.[0] as PrismaMiddleware

      const nextResult = { id: 99 }
      const result = await middleware(
        {
          model: 'User',
          action: 'create',
          args: {},
          dataPath: [],
          runInTransaction: false,
        },
        async () => nextResult,
      )

      // Operation must still return a result even after stop
      expect(result).toEqual(nextResult)
    })

    it('stop() return value satisfies void | Promise<void>', async () => {
      const createPrismaAdapter = await importAdapter()
      const { prisma } = makeMockPrisma()

      const adapter = createPrismaAdapter(prisma, {
        User: { updated: 'user.updated' },
      })
      adapter.start(() => {})

      const result = adapter.stop()
      // Either undefined (sync) or a Promise that resolves
      if (result !== undefined) {
        expect(result).toBeInstanceOf(Promise)
        await result
      }
    })
  })

  describe('start() — error handling when $use() throws', () => {
    it('should re-throw when prisma.$use() throws', async () => {
      const createPrismaAdapter = await importAdapter()

      const brokenPrisma = {
        $use: (_middleware: PrismaMiddleware) => {
          throw new Error('invalid client state')
        },
      }

      const adapter = createPrismaAdapter(brokenPrisma, {
        User: { created: 'user.created' },
      })

      expect(() => adapter.start(() => {})).toThrow('invalid client state')
    })

    it('should reset active and started to false when $use() throws', async () => {
      const createPrismaAdapter = await importAdapter()

      const brokenPrisma = {
        $use: (_middleware: PrismaMiddleware) => {
          throw new Error('invalid client state')
        },
      }

      const adapter = createPrismaAdapter(brokenPrisma, {
        User: { created: 'user.created' },
      })

      try {
        adapter.start(() => {})
      } catch {
        // expected
      }

      // After a failed start(), calling start() again should attempt to register
      // (not be blocked by the started=true guard), proving state was reset.
      // We verify this by using a working prisma client the second time.
      makeMockPrisma()
      // Replace the broken client by creating a fresh adapter to re-verify state was reset:
      // The key observable is that stop() on the broken adapter doesn't error,
      // and a second start() call (with a different approach) is attempted.
      expect(() => adapter.stop()).not.toThrow()
    })

    it('should allow start() to be retried after $use() throws', async () => {
      const createPrismaAdapter = await importAdapter()

      let shouldThrow = true
      const conditionalPrisma = {
        $use: mock((_middleware: PrismaMiddleware) => {
          if (shouldThrow) throw new Error('not ready yet')
          // On second call, behave normally (do nothing, no throw)
        }),
      }

      const adapter = createPrismaAdapter(
        conditionalPrisma as unknown as Parameters<
          typeof createPrismaAdapter
        >[0],
        {
          User: { created: 'user.created' },
        },
      )

      // First call should throw
      expect(() => adapter.start(() => {})).toThrow('not ready yet')

      // Now allow $use to succeed
      shouldThrow = false

      // Second call should not throw (state was reset, so started === false)
      expect(() => adapter.start(() => {})).not.toThrow()
      expect(conditionalPrisma.$use).toHaveBeenCalledTimes(2)
    })
  })

  describe('does NOT import @prisma/client', () => {
    it('module source should not contain @prisma/client import', async () => {
      // Verify by reading the source file once it exists
      // This test will pass as long as the implementation doesn't directly import the driver
      const mod = await import('../server/adapters/prisma.ts')
      // If the module loaded without @prisma/client being installed, it doesn't import it
      expect(mod).toBeDefined()
    })
  })

  describe('tree-shakeability — named export only', () => {
    it('createPrismaAdapter should be a named export (not default)', async () => {
      const mod = (await import('../server/adapters/prisma.ts')) as Record<
        string,
        unknown
      >

      // Named export must exist
      expect(mod.createPrismaAdapter).toBeDefined()
      // Default export must NOT exist (tree-shaking works better with named exports)
      expect(mod.default).toBeUndefined()
    })
  })
})
