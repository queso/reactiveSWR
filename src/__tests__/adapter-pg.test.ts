import { describe, expect, it, mock, spyOn } from 'bun:test'
import type { SSEAdapter } from '../server/adapters/types.ts'

/**
 * Tests for createPgAdapter() — wraps pg client LISTEN/NOTIFY to
 * emit SSE events on database notifications.
 *
 * These tests verify that:
 * 1. createPgAdapter(client, mapping) is exported from src/server/adapters/pg.ts
 * 2. The adapter implements the SSEAdapter interface (start/stop)
 * 3. start() calls client.query('LISTEN <channel>') for each mapped channel
 * 4. Adapter listens for 'notification' events on the pg client
 * 5. NOTIFY payload is parsed as JSON and passed to emit()
 * 6. stop() calls UNLISTEN for each channel and removes event listeners
 * 7. The adapter does NOT import pg directly
 * 8. Named export only (tree-shakeable)
 *
 * Tests FAIL initially because src/server/adapters/pg.ts has not been created yet.
 */

// ---------------------------------------------------------------------------
// Mock pg client helpers
// ---------------------------------------------------------------------------

interface PgNotification {
  channel: string
  payload?: string
  processId?: number
}

type NotificationListener = (notification: PgNotification) => void

/**
 * Minimal mock of a pg Client that captures LISTEN/UNLISTEN queries
 * and exposes a helper to fire 'notification' events.
 */
function makeMockPgClient() {
  const eventListeners: Map<string, NotificationListener[]> = new Map()
  const queries: string[] = []

  const client = {
    query: mock(async (sql: string) => {
      queries.push(sql)
      return { rows: [], rowCount: 0 }
    }),
    on: mock((event: string, listener: NotificationListener) => {
      const listeners = eventListeners.get(event) ?? []
      listeners.push(listener)
      eventListeners.set(event, listeners)
    }),
    off: mock((event: string, listener: NotificationListener) => {
      const listeners = eventListeners.get(event) ?? []
      eventListeners.set(
        event,
        listeners.filter((l) => l !== listener),
      )
    }),
    removeListener: mock((event: string, listener: NotificationListener) => {
      const listeners = eventListeners.get(event) ?? []
      eventListeners.set(
        event,
        listeners.filter((l) => l !== listener),
      )
    }),
  }

  /** Simulate a NOTIFY arriving on the pg client */
  function fireNotification(notification: PgNotification): void {
    const listeners = eventListeners.get('notification') ?? []
    for (const listener of listeners) {
      listener(notification)
    }
  }

  return { client, queries, fireNotification, eventListeners }
}

type PgAdapterMapping = {
  [channelName: string]: string // pg NOTIFY channel → schema event type
}

async function importAdapter() {
  // biome-ignore lint/suspicious/noExplicitAny: dynamic import before implementation exists
  const mod = (await import('../server/adapters/pg.ts')) as Record<string, any>
  return mod.createPgAdapter as (
    // biome-ignore lint/suspicious/noExplicitAny: mock pg client has minimal interface
    client: Record<string, any>,
    mapping: PgAdapterMapping,
  ) => SSEAdapter
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('createPgAdapter()', () => {
  describe('export and interface', () => {
    it('should be exported from src/server/adapters/pg.ts', async () => {
      const mod = await import('../server/adapters/pg.ts')
      expect((mod as Record<string, unknown>).createPgAdapter).toBeDefined()
      expect(typeof (mod as Record<string, unknown>).createPgAdapter).toBe(
        'function',
      )
    })

    it('should return an object implementing the SSEAdapter interface', async () => {
      const createPgAdapter = await importAdapter()
      const { client } = makeMockPgClient()

      const adapter = createPgAdapter(client, { users_changed: 'user.updated' })

      expect(typeof adapter.start).toBe('function')
      expect(typeof adapter.stop).toBe('function')
    })

    it('should be a named export (not default)', async () => {
      const mod = (await import('../server/adapters/pg.ts')) as Record<
        string,
        unknown
      >
      expect(mod.createPgAdapter).toBeDefined()
      expect(mod.default).toBeUndefined()
    })
  })

  describe('start() — LISTEN on each mapped channel', () => {
    it('start() should call client.query("LISTEN <channel>") for each mapped channel', async () => {
      const createPgAdapter = await importAdapter()
      const { client, queries } = makeMockPgClient()

      const adapter = createPgAdapter(client, {
        users_changed: 'user.updated',
        orders_created: 'order.created',
      })
      await adapter.start(() => {})

      const listenQueries = queries.filter((q) =>
        q.toUpperCase().startsWith('LISTEN'),
      )
      expect(listenQueries).toHaveLength(2)

      // Both channels must be LISTENed on — identifiers are always double-quoted
      const listenedChannels = listenQueries.map((q) =>
        q.replace(/^LISTEN\s+/i, '').trim(),
      )
      expect(listenedChannels).toContain('"users_changed"')
      expect(listenedChannels).toContain('"orders_created"')
    })

    it('start() with a single mapped channel should issue one LISTEN query', async () => {
      const createPgAdapter = await importAdapter()
      const { client, queries } = makeMockPgClient()

      const adapter = createPgAdapter(client, {
        events_channel: 'data.changed',
      })
      await adapter.start(() => {})

      const listenQueries = queries.filter((q) =>
        q.toUpperCase().startsWith('LISTEN'),
      )
      expect(listenQueries).toHaveLength(1)
      expect(listenQueries[0]).toMatch(/events_channel/i)
    })

    it('start() should register a notification event listener on the client', async () => {
      const createPgAdapter = await importAdapter()
      const { client } = makeMockPgClient()

      const adapter = createPgAdapter(client, { users_changed: 'user.updated' })
      await adapter.start(() => {})

      // client.on should have been called with 'notification'
      const onCalls = (client.on as ReturnType<typeof mock>).mock.calls
      const notificationCall = onCalls.find(
        (args) => args[0] === 'notification',
      )
      expect(notificationCall).toBeDefined()
    })

    it('start() with empty mapping should not issue any LISTEN queries', async () => {
      const createPgAdapter = await importAdapter()
      const { client, queries } = makeMockPgClient()

      const adapter = createPgAdapter(client, {})
      await adapter.start(() => {})

      const listenQueries = queries.filter((q) =>
        q.toUpperCase().startsWith('LISTEN'),
      )
      expect(listenQueries).toHaveLength(0)
    })
  })

  describe('notification handling — emit on NOTIFY', () => {
    it('should emit a schema event when a matching NOTIFY arrives', async () => {
      const createPgAdapter = await importAdapter()
      const { client, fireNotification } = makeMockPgClient()

      const emitted: Array<{ type: string; payload: unknown }> = []
      const adapter = createPgAdapter(client, { users_changed: 'user.updated' })
      await adapter.start((type, payload) => emitted.push({ type, payload }))

      fireNotification({
        channel: 'users_changed',
        payload: JSON.stringify({ id: 42, name: 'Alice' }),
      })

      expect(emitted).toHaveLength(1)
      expect(emitted[0]?.type).toBe('user.updated')
    })

    it('should parse the NOTIFY payload as JSON', async () => {
      const createPgAdapter = await importAdapter()
      const { client, fireNotification } = makeMockPgClient()

      const emitted: Array<{ type: string; payload: unknown }> = []
      const adapter = createPgAdapter(client, {
        orders_created: 'order.created',
      })
      await adapter.start((type, payload) => emitted.push({ type, payload }))

      const orderData = { id: 99, total: 150.0, customerId: 'cust-1' }
      fireNotification({
        channel: 'orders_created',
        payload: JSON.stringify(orderData),
      })

      expect(emitted[0]?.payload).toEqual(orderData)
    })

    it('should route notifications from multiple channels to different schema events', async () => {
      const createPgAdapter = await importAdapter()
      const { client, fireNotification } = makeMockPgClient()

      const emitted: Array<{ type: string; payload: unknown }> = []
      const adapter = createPgAdapter(client, {
        users_changed: 'user.updated',
        orders_created: 'order.created',
        products_deleted: 'product.deleted',
      })
      await adapter.start((type, payload) => emitted.push({ type, payload }))

      fireNotification({
        channel: 'users_changed',
        payload: JSON.stringify({ id: 1 }),
      })
      fireNotification({
        channel: 'orders_created',
        payload: JSON.stringify({ id: 2 }),
      })
      fireNotification({
        channel: 'products_deleted',
        payload: JSON.stringify({ id: 3 }),
      })

      expect(emitted).toHaveLength(3)
      expect(emitted[0]?.type).toBe('user.updated')
      expect(emitted[1]?.type).toBe('order.created')
      expect(emitted[2]?.type).toBe('product.deleted')
    })

    it('should not emit for notifications on unmapped channels', async () => {
      const createPgAdapter = await importAdapter()
      const { client, fireNotification } = makeMockPgClient()

      const emitted: Array<{ type: string; payload: unknown }> = []
      const adapter = createPgAdapter(client, { users_changed: 'user.updated' })
      await adapter.start((type, payload) => emitted.push({ type, payload }))

      // Notification on a channel not in the mapping
      fireNotification({
        channel: 'unrelated_channel',
        payload: JSON.stringify({ id: 5 }),
      })

      expect(emitted).toHaveLength(0)
    })

    it('should handle a NOTIFY payload that is an empty string gracefully (no throw)', async () => {
      const createPgAdapter = await importAdapter()
      const { client, fireNotification } = makeMockPgClient()

      const adapter = createPgAdapter(client, {
        events_channel: 'data.changed',
      })
      await adapter.start(() => {})

      // Empty payload is valid NOTIFY (no payload given)
      expect(() => {
        fireNotification({ channel: 'events_channel', payload: '' })
      }).not.toThrow()
    })

    it('should handle a NOTIFY with no payload field gracefully (no throw)', async () => {
      const createPgAdapter = await importAdapter()
      const { client, fireNotification } = makeMockPgClient()

      const adapter = createPgAdapter(client, {
        events_channel: 'data.changed',
      })
      await adapter.start(() => {})

      // pg may fire notifications without a payload property
      expect(() => {
        fireNotification({ channel: 'events_channel' })
      }).not.toThrow()
    })

    it('should handle malformed JSON payload gracefully (no throw)', async () => {
      const createPgAdapter = await importAdapter()
      const { client, fireNotification } = makeMockPgClient()

      const adapter = createPgAdapter(client, {
        events_channel: 'data.changed',
      })
      await adapter.start(() => {})

      // Malformed JSON — adapter should not throw
      expect(() => {
        fireNotification({
          channel: 'events_channel',
          payload: 'not-valid-json',
        })
      }).not.toThrow()
    })

    it('multiple NOTIFY on same channel should each emit once', async () => {
      const createPgAdapter = await importAdapter()
      const { client, fireNotification } = makeMockPgClient()

      const emitted: Array<{ type: string; payload: unknown }> = []
      const adapter = createPgAdapter(client, { users_changed: 'user.updated' })
      await adapter.start((type, payload) => emitted.push({ type, payload }))

      fireNotification({
        channel: 'users_changed',
        payload: JSON.stringify({ id: 1 }),
      })
      fireNotification({
        channel: 'users_changed',
        payload: JSON.stringify({ id: 2 }),
      })
      fireNotification({
        channel: 'users_changed',
        payload: JSON.stringify({ id: 3 }),
      })

      expect(emitted).toHaveLength(3)
      expect((emitted[0]?.payload as Record<string, unknown>).id).toBe(1)
      expect((emitted[1]?.payload as Record<string, unknown>).id).toBe(2)
      expect((emitted[2]?.payload as Record<string, unknown>).id).toBe(3)
    })
  })

  describe('stop() — UNLISTEN and remove listener', () => {
    it('stop() should call UNLISTEN for each mapped channel', async () => {
      const createPgAdapter = await importAdapter()
      const { client, queries } = makeMockPgClient()

      const adapter = createPgAdapter(client, {
        users_changed: 'user.updated',
        orders_created: 'order.created',
      })
      await adapter.start(() => {})
      await adapter.stop()

      const unlistenQueries = queries.filter((q) =>
        q.toUpperCase().startsWith('UNLISTEN'),
      )
      expect(unlistenQueries).toHaveLength(2)

      // Identifiers are always double-quoted
      const unlistenedChannels = unlistenQueries.map((q) =>
        q.replace(/^UNLISTEN\s+/i, '').trim(),
      )
      expect(unlistenedChannels).toContain('"users_changed"')
      expect(unlistenedChannels).toContain('"orders_created"')
    })

    it('stop() should remove the notification event listener from the client', async () => {
      const createPgAdapter = await importAdapter()
      const { client, fireNotification, eventListeners } = makeMockPgClient()

      const emitted: string[] = []
      const adapter = createPgAdapter(client, { users_changed: 'user.updated' })
      await adapter.start((type) => emitted.push(type))

      // Verify events work before stop
      fireNotification({
        channel: 'users_changed',
        payload: JSON.stringify({ id: 1 }),
      })
      expect(emitted).toHaveLength(1)

      await adapter.stop()

      // After stop, no listeners should be registered
      const notifListeners = eventListeners.get('notification') ?? []
      expect(notifListeners).toHaveLength(0)

      // And events no longer flow
      fireNotification({
        channel: 'users_changed',
        payload: JSON.stringify({ id: 2 }),
      })
      expect(emitted).toHaveLength(1) // unchanged
    })

    it('stop() should return void or Promise<void>', async () => {
      const createPgAdapter = await importAdapter()
      const { client } = makeMockPgClient()

      const adapter = createPgAdapter(client, { users_changed: 'user.updated' })
      await adapter.start(() => {})

      const result = adapter.stop()
      if (result !== undefined) {
        expect(result).toBeInstanceOf(Promise)
        await result
      }
    })

    it('stop() should not throw if called without start()', async () => {
      const createPgAdapter = await importAdapter()
      const { client } = makeMockPgClient()

      const adapter = createPgAdapter(client, { users_changed: 'user.updated' })

      await expect(Promise.resolve(adapter.stop())).resolves.toBeUndefined()
    })

    it('stop() should not throw if called twice', async () => {
      const createPgAdapter = await importAdapter()
      const { client } = makeMockPgClient()

      const adapter = createPgAdapter(client, { users_changed: 'user.updated' })
      await adapter.start(() => {})
      await adapter.stop()

      await expect(Promise.resolve(adapter.stop())).resolves.toBeUndefined()
    })

    it('stop() should log a console.warn when client has neither off() nor removeListener()', async () => {
      const createPgAdapter = await importAdapter()

      // Minimal client without off() or removeListener()
      const minimalClient = {
        query: mock(async (_sql: string) => ({ rows: [], rowCount: 0 })),
        on: mock((_event: string, _listener: unknown) => {}),
      }

      const warnSpy = spyOn(console, 'warn').mockImplementation(() => {})

      try {
        // biome-ignore lint/suspicious/noExplicitAny: minimal mock client
        const adapter = createPgAdapter(minimalClient as any, {
          users_changed: 'user.updated',
        })
        await adapter.start(() => {})
        await adapter.stop()

        expect(warnSpy).toHaveBeenCalledWith(
          'PostgreSQL client does not support off() or removeListener() — notification handler may leak',
        )
      } finally {
        warnSpy.mockRestore()
      }
    })
  })

  describe('does NOT import pg', () => {
    it('module should load without pg package installed', async () => {
      const mod = await import('../server/adapters/pg.ts')
      expect(mod).toBeDefined()
    })
  })

  describe('identifier quoting — reserved keywords', () => {
    it('should quote a channel named "select" (PostgreSQL reserved keyword) correctly in LISTEN', async () => {
      const createPgAdapter = await importAdapter()
      const { client, queries } = makeMockPgClient()

      // 'select' is a PostgreSQL reserved keyword — unquoted it causes a syntax error
      const adapter = createPgAdapter(client, { select: 'data.changed' })
      await adapter.start(() => {})

      const listenQueries = queries.filter((q) =>
        q.toUpperCase().startsWith('LISTEN'),
      )
      expect(listenQueries).toHaveLength(1)
      // Must be double-quoted so PostgreSQL treats it as an identifier, not a keyword
      expect(listenQueries[0]).toBe('LISTEN "select"')
    })

    it('should quote a channel named "table" (PostgreSQL reserved keyword) correctly in UNLISTEN', async () => {
      const createPgAdapter = await importAdapter()
      const { client, queries } = makeMockPgClient()

      const adapter = createPgAdapter(client, { table: 'data.changed' })
      await adapter.start(() => {})
      await adapter.stop()

      const unlistenQueries = queries.filter((q) =>
        q.toUpperCase().startsWith('UNLISTEN'),
      )
      expect(unlistenQueries).toHaveLength(1)
      expect(unlistenQueries[0]).toBe('UNLISTEN "table"')
    })

    it('should escape embedded double-quotes in channel names', async () => {
      const createPgAdapter = await importAdapter()
      const { client, queries } = makeMockPgClient()

      // Channel name with a double-quote character in it
      const adapter = createPgAdapter(client, { 'my"channel': 'data.changed' })
      await adapter.start(() => {})

      const listenQueries = queries.filter((q) =>
        q.toUpperCase().startsWith('LISTEN'),
      )
      expect(listenQueries).toHaveLength(1)
      // Double-quote inside the identifier must be escaped as ""
      expect(listenQueries[0]).toBe('LISTEN "my""channel"')
    })

    it('simple alphanumeric channel names should also be quoted', async () => {
      const createPgAdapter = await importAdapter()
      const { client, queries } = makeMockPgClient()

      const adapter = createPgAdapter(client, { users_changed: 'user.updated' })
      await adapter.start(() => {})

      const listenQueries = queries.filter((q) =>
        q.toUpperCase().startsWith('LISTEN'),
      )
      expect(listenQueries).toHaveLength(1)
      // All identifiers are now always quoted
      expect(listenQueries[0]).toBe('LISTEN "users_changed"')
    })
  })
})
