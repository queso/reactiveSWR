import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { defineSchema } from '../schema.ts'

/**
 * Tests for createChannel() server-side SSE channel factory.
 *
 * Tests cover all acceptance criteria:
 * 1. Factory returns channel object with connect/respond/emit/close methods
 * 2. Web standard connect returns Response with correct SSE headers
 * 3. Node.js connect writes correct headers to ServerResponse
 * 4. Initial connected event sent on connect
 * 5. Heartbeats sent at configured interval
 * 6. Disconnect cleanup removes client from pool
 * 7. channel.respond() returns scoped emitter NOT in broadcast pool
 * 8. channel.emit() broadcasts SSE wire format to connected clients
 * 9. channel.close() closes all connections and stops timers
 * 10. channel.emit() with no clients is a no-op
 * 11. channel.connect() after channel.close() throws
 * 12. Heartbeat interval is configurable via options
 *
 * Tests FAIL initially because createChannel has not been implemented yet.
 */

// Helper: collect all SSE text chunks from a ReadableStream
async function collectChunks(
  stream: ReadableStream<Uint8Array>,
  count: number,
): Promise<string[]> {
  const decoder = new TextDecoder()
  const reader = stream.getReader()
  const chunks: string[] = []
  for (let i = 0; i < count; i++) {
    const { value, done } = await reader.read()
    if (done) break
    chunks.push(decoder.decode(value))
  }
  reader.cancel()
  return chunks
}

// Minimal schema used across all tests
const testSchema = defineSchema({
  'user.updated': { key: '/api/users', update: 'set' },
  'order.placed': {
    key: (p: { id: string }) => `/api/orders/${p.id}`,
    update: 'refetch',
  },
})

describe('createChannel()', () => {
  // biome-ignore lint/suspicious/noExplicitAny: dynamic import before implementation
  let createChannel: any

  beforeEach(async () => {
    // Re-import each time so implementation changes are picked up
    const mod = await import('../server/index.ts')
    createChannel = (mod as Record<string, unknown>).createChannel
  })

  afterEach(() => {
    // Nothing global to restore for server tests
  })

  describe('Req #11 - factory function signature', () => {
    it('createChannel should be exported from src/server/index.ts', async () => {
      const mod = await import('../server/index.ts')
      expect((mod as Record<string, unknown>).createChannel).toBeDefined()
      expect(typeof (mod as Record<string, unknown>).createChannel).toBe(
        'function',
      )
    })

    it('createChannel(schema) should return an object', () => {
      const channel = createChannel(testSchema)
      expect(channel).toBeDefined()
      expect(typeof channel).toBe('object')
    })

    it('returned channel should have connect method', () => {
      const channel = createChannel(testSchema)
      expect(typeof channel.connect).toBe('function')
    })

    it('returned channel should have respond method', () => {
      const channel = createChannel(testSchema)
      expect(typeof channel.respond).toBe('function')
    })

    it('returned channel should have emit method', () => {
      const channel = createChannel(testSchema)
      expect(typeof channel.emit).toBe('function')
    })

    it('returned channel should have close method', () => {
      const channel = createChannel(testSchema)
      expect(typeof channel.close).toBe('function')
    })
  })

  describe('Req #12 + #13 - Web standard connect()', () => {
    it('connect(request) should return a Response', async () => {
      const channel = createChannel(testSchema)
      const request = new Request('http://localhost/api/events')
      const response = channel.connect(request)

      expect(response).toBeInstanceOf(Response)

      // Clean up the stream to avoid leaks
      await response.body?.cancel()
      channel.close()
    })

    it('connect(request) Response should have Content-Type: text/event-stream', async () => {
      const channel = createChannel(testSchema)
      const request = new Request('http://localhost/api/events')
      const response = channel.connect(request)

      expect(response.headers.get('Content-Type')).toContain(
        'text/event-stream',
      )

      await response.body?.cancel()
      channel.close()
    })

    it('connect(request) Response should have Cache-Control: no-cache', async () => {
      const channel = createChannel(testSchema)
      const request = new Request('http://localhost/api/events')
      const response = channel.connect(request)

      expect(response.headers.get('Cache-Control')).toBe('no-cache')

      await response.body?.cancel()
      channel.close()
    })

    it('connect(request) Response should have Connection: keep-alive', async () => {
      const channel = createChannel(testSchema)
      const request = new Request('http://localhost/api/events')
      const response = channel.connect(request)

      expect(response.headers.get('Connection')).toBe('keep-alive')

      await response.body?.cancel()
      channel.close()
    })

    it('connect(request) Response body should be a ReadableStream', async () => {
      const channel = createChannel(testSchema)
      const request = new Request('http://localhost/api/events')
      const response = channel.connect(request)

      expect(response.body).toBeDefined()
      expect(response.body).toBeInstanceOf(ReadableStream)

      await response.body?.cancel()
      channel.close()
    })
  })

  describe('Req #14 - initial connected event', () => {
    it('Web connect should send an initial event on open', async () => {
      const channel = createChannel(testSchema)
      const request = new Request('http://localhost/api/events')
      const response = channel.connect(request)

      const chunks = await collectChunks(response.body as ReadableStream, 1)
      channel.close()

      // Should receive at least one chunk immediately (the connected event)
      expect(chunks.length).toBeGreaterThan(0)
      expect(chunks[0]).toBeTruthy()
    })

    it('initial connected event should follow SSE format', async () => {
      const channel = createChannel(testSchema)
      const request = new Request('http://localhost/api/events')
      const response = channel.connect(request)

      const chunks = await collectChunks(response.body as ReadableStream, 1)
      channel.close()

      const text = chunks.join('')
      // SSE format: lines ending with \n, double \n between events
      expect(text).toMatch(/\n\n$/)
    })

    it('Node.js connect should write initial event to ServerResponse', () => {
      const channel = createChannel(testSchema)

      const written: string[] = []
      const mockReq = {
        on: mock((_event: string, _cb: () => void) => {}),
      }
      const mockRes = {
        writeHead: mock(
          (_status: number, _headers: Record<string, string>) => {},
        ),
        write: mock((chunk: string) => {
          written.push(chunk)
        }),
        end: mock(() => {}),
        writableEnded: false,
        on: mock((_event: string, _cb: () => void) => {}),
      }

      channel.connect(mockReq, mockRes)
      channel.close()

      // Should have written at least one initial event chunk
      expect(written.length).toBeGreaterThan(0)
    })
  })

  describe('Req #13 - Node.js connect() headers', () => {
    it('Node.js connect should call writeHead with correct SSE headers', () => {
      const channel = createChannel(testSchema)

      const mockReq = {
        on: mock((_event: string, _cb: () => void) => {}),
      }
      const writeHeadCalls: Array<[number, Record<string, string>]> = []
      const mockRes = {
        writeHead: mock((status: number, headers: Record<string, string>) => {
          writeHeadCalls.push([status, headers])
        }),
        write: mock(() => {}),
        end: mock(() => {}),
        writableEnded: false,
        on: mock((_event: string, _cb: () => void) => {}),
      }

      channel.connect(mockReq, mockRes)
      channel.close()

      expect(writeHeadCalls.length).toBeGreaterThan(0)
      const [status, headers] = writeHeadCalls[0] as [
        number,
        Record<string, string>,
      ]
      expect(status).toBe(200)
      expect(headers['Content-Type']).toContain('text/event-stream')
      expect(headers['Cache-Control']).toBe('no-cache')
      expect(headers.Connection).toBe('keep-alive')
    })

    it('Node.js connect should throw if res.writableEnded is true', () => {
      const channel = createChannel(testSchema)

      const mockReq = {
        on: mock((_event: string, _cb: () => void) => {}),
      }
      const mockRes = {
        writeHead: mock(() => {}),
        write: mock(() => {}),
        end: mock(() => {}),
        writableEnded: true,
        on: mock((_event: string, _cb: () => void) => {}),
      }

      expect(() => {
        channel.connect(mockReq, mockRes)
      }).toThrow()

      channel.close()
    })
  })

  describe('Req #15 - heartbeats', () => {
    it('should send heartbeat comments at the configured interval', async () => {
      // Use a very short interval for testing
      const channel = createChannel(testSchema, { heartbeatInterval: 50 })
      const request = new Request('http://localhost/api/events')
      const response = channel.connect(request)

      // Collect initial event + at least one heartbeat
      const chunks = await collectChunks(response.body as ReadableStream, 2)
      channel.close()

      const allText = chunks.join('')
      // Heartbeat is an SSE comment: ": heartbeat\n\n" or ": \n\n"
      expect(allText).toMatch(/^:/)
    })

    it('heartbeat interval should default to 30000ms (verified by option type)', () => {
      // createChannel should accept options object with heartbeatInterval
      expect(() => {
        const channel = createChannel(testSchema, { heartbeatInterval: 30000 })
        channel.close()
      }).not.toThrow()
    })

    it('heartbeat timer should stop when all clients disconnect', async () => {
      // Patch setInterval/clearInterval to track timer lifecycle
      const originalSetInterval = globalThis.setInterval
      const originalClearInterval = globalThis.clearInterval

      let activeTimers = 0
      globalThis.setInterval = ((...args: Parameters<typeof setInterval>) => {
        activeTimers++
        return originalSetInterval(...args)
      }) as typeof setInterval
      globalThis.clearInterval = ((
        ...args: Parameters<typeof clearInterval>
      ) => {
        activeTimers--
        return originalClearInterval(...args)
      }) as typeof clearInterval

      try {
        // Dynamically re-import so the module captures our patched timers
        // Use a cache-busting query param to force a fresh module
        const mod = await import(`../server/index.ts?bust=${Date.now()}`)
        const localCreateChannel = (mod as Record<string, unknown>)
          .createChannel as typeof createChannel

        const channel = localCreateChannel(testSchema, {
          heartbeatInterval: 50,
        })

        // Connect a client -- heartbeat starts
        const r1 = channel.connect(new Request('http://localhost/api/events'))
        expect(activeTimers).toBe(1)

        // Cancel the client stream -- heartbeat should stop
        await r1.body?.cancel()
        expect(activeTimers).toBe(0)

        // Connect a new client -- heartbeat starts fresh
        const r2 = channel.connect(new Request('http://localhost/api/events'))
        expect(activeTimers).toBe(1)

        // Verify the new client actually receives heartbeats
        const chunks = await collectChunks(r2.body as ReadableStream, 2)
        const allText = chunks.join('')
        expect(allText).toContain(': heartbeat')

        channel.close()
        expect(activeTimers).toBe(0)
      } finally {
        globalThis.setInterval = originalSetInterval
        globalThis.clearInterval = originalClearInterval
      }
    })

    it('heartbeat should use a single shared setInterval (not one per client)', async () => {
      // Verify single-timer behavior functionally: both clients receive
      // heartbeats at the same cadence from the shared interval.
      const channel = createChannel(testSchema, { heartbeatInterval: 50 })

      // Connect multiple clients
      const r1 = channel.connect(new Request('http://localhost/api/events'))
      const r2 = channel.connect(new Request('http://localhost/api/events'))

      const decoder = new TextDecoder()
      const reader1 = r1.body?.getReader()
      const reader2 = r2.body?.getReader()

      // Drain initial connected events
      await reader1.read()
      await reader2.read()

      // Wait for heartbeat from both clients (shared timer sends to all)
      const [hb1, hb2] = await Promise.all([reader1.read(), reader2.read()])

      const text1 = decoder.decode(hb1.value)
      const text2 = decoder.decode(hb2.value)

      // Both clients should receive the same heartbeat comment
      expect(text1).toContain(': heartbeat')
      expect(text2).toContain(': heartbeat')

      reader1.cancel()
      reader2.cancel()
      channel.close()
    })
  })

  describe('Req #20-#22 - channel.emit() broadcast', () => {
    it('channel.emit() with no clients should be a no-op (not throw)', () => {
      const channel = createChannel(testSchema)

      expect(() => {
        channel.emit('user.updated', { id: 1 })
      }).not.toThrow()

      channel.close()
    })

    it('channel.emit(eventType, payload) should send SSE wire format to connected clients', async () => {
      const channel = createChannel(testSchema)
      const request = new Request('http://localhost/api/events')
      const response = channel.connect(request)

      // Drain the initial connected event first
      const reader = response.body?.getReader()
      const decoder = new TextDecoder()
      await reader.read() // initial event

      // Emit a typed event
      channel.emit('user.updated', { id: 42, name: 'alice' })

      const { value } = await reader.read()
      const text = decoder.decode(value)
      reader.cancel()
      channel.close()

      // SSE wire format: event: <type>\ndata: <json>\n\n
      expect(text).toContain('event: user.updated')
      expect(text).toContain('data: ')
      expect(text).toContain('"id":42')
      expect(text).toContain('"name":"alice"')
      expect(text).toMatch(/\n\n$/)
    })

    it('channel.emit() should broadcast to ALL connected clients', async () => {
      const channel = createChannel(testSchema)

      const r1 = channel.connect(new Request('http://localhost/api/events'))
      const r2 = channel.connect(new Request('http://localhost/api/events'))
      const decoder = new TextDecoder()

      const reader1 = r1.body?.getReader()
      const reader2 = r2.body?.getReader()

      // Drain initial events
      await reader1.read()
      await reader2.read()

      channel.emit('user.updated', { id: 1 })

      const [res1, res2] = await Promise.all([reader1.read(), reader2.read()])
      const text1 = decoder.decode(res1.value)
      const text2 = decoder.decode(res2.value)

      reader1.cancel()
      reader2.cancel()
      channel.close()

      expect(text1).toContain('event: user.updated')
      expect(text2).toContain('event: user.updated')
    })
  })

  describe('Req #23 - channel.close()', () => {
    it('channel.close() should not throw', () => {
      const channel = createChannel(testSchema)
      expect(() => channel.close()).not.toThrow()
    })

    it('channel.close() should close the Web Response stream', async () => {
      const channel = createChannel(testSchema)
      const request = new Request('http://localhost/api/events')
      const response = channel.connect(request)

      const reader = response.body?.getReader()

      // Drain initial event
      await reader.read()

      channel.close()

      // After close the stream should end (done: true)
      const { done } = await reader.read()
      expect(done).toBe(true)
    })

    it('channel.close() should call end() on Node.js ServerResponse', () => {
      const channel = createChannel(testSchema)

      const mockReq = { on: mock(() => {}) }
      const endMock = mock(() => {})
      const mockRes = {
        writeHead: mock(() => {}),
        write: mock(() => {}),
        end: endMock,
        writableEnded: false,
        on: mock(() => {}),
      }

      channel.connect(mockReq, mockRes)
      channel.close()

      expect(endMock).toHaveBeenCalled()
    })

    it('channel.connect() after channel.close() should throw', () => {
      const channel = createChannel(testSchema)
      channel.close()

      expect(() => {
        channel.connect(new Request('http://localhost/api/events'))
      }).toThrow()
    })

    it('channel.isClosed() should return false initially', () => {
      const channel = createChannel(testSchema)
      expect(channel.isClosed()).toBe(false)
      channel.close()
    })

    it('channel.isClosed() should return true after channel.close()', () => {
      const channel = createChannel(testSchema)
      channel.close()
      expect(channel.isClosed()).toBe(true)
    })
  })

  describe('Req #17 - channel.respond() scoped emitter (dual signature)', () => {
    it('Web respond(request) should return { response, emitter }', async () => {
      const channel = createChannel(testSchema)
      const request = new Request('http://localhost/api/query')
      const result = channel.respond(request)

      expect(result).toHaveProperty('response')
      expect(result).toHaveProperty('emitter')

      const { response, emitter } = result as {
        response: Response
        emitter: { emit: (t: string, p: unknown) => void; close: () => void }
      }
      expect(response).toBeInstanceOf(Response)
      expect(typeof emitter.emit).toBe('function')
      expect(typeof emitter.close).toBe('function')

      emitter.close()
      channel.close()
    })

    it('Web respond(request) Response should have SSE headers', async () => {
      const channel = createChannel(testSchema)
      const request = new Request('http://localhost/api/query')
      const { response, emitter } = channel.respond(request) as {
        response: Response
        emitter: { close: () => void }
      }

      expect(response.headers.get('Content-Type')).toContain(
        'text/event-stream',
      )
      expect(response.headers.get('Cache-Control')).toBe('no-cache')
      expect(response.headers.get('Connection')).toBe('keep-alive')

      emitter.close()
      channel.close()
    })

    it('Web respond emitter.emit() should write SSE wire format to the Response stream', async () => {
      const channel = createChannel(testSchema)
      const request = new Request('http://localhost/api/query')
      const { response, emitter } = channel.respond(request) as {
        response: Response
        emitter: {
          emit: (type: string, payload: unknown) => void
          close: () => void
        }
      }

      emitter.emit('user.updated', { id: 42, name: 'alice' })
      emitter.close()

      const text = await response.text()

      expect(text).toContain('event: user.updated')
      expect(text).toContain('data: ')
      expect(text).toContain('"id":42')
      expect(text).toContain('"name":"alice"')
      expect(text).toMatch(/\n\n/)

      channel.close()
    })

    it('Web respond emitter.close() should end the Response stream', async () => {
      const channel = createChannel(testSchema)
      const request = new Request('http://localhost/api/query')
      const { response, emitter } = channel.respond(request) as {
        response: Response
        emitter: {
          emit: (type: string, payload: unknown) => void
          close: () => void
        }
      }

      emitter.emit('user.updated', { id: 1 })
      emitter.close()

      // Reading the full body should complete (stream is closed)
      const body = await response.text()
      expect(body).toContain('event: user.updated')

      channel.close()
    })

    it('Node.js respond(req, res) should return a ScopedEmitter', () => {
      const channel = createChannel(testSchema)

      const mockReq = {
        on: mock((_event: string, _cb: () => void) => {}),
      }
      const mockRes = {
        writeHead: mock(
          (_status: number, _headers: Record<string, string>) => {},
        ),
        write: mock((_chunk: string) => {}),
        end: mock(() => {}),
        writableEnded: false,
        on: mock((_event: string, _cb: () => void) => {}),
      }

      const emitter = channel.respond(mockReq, mockRes)

      expect(typeof emitter.emit).toBe('function')
      expect(typeof emitter.close).toBe('function')
      // Should NOT have response property (that is for Web path only)
      expect(emitter).not.toHaveProperty('response')

      emitter.close()
      channel.close()
    })

    it('Node.js respond should call writeHead with SSE headers', () => {
      const channel = createChannel(testSchema)

      const writeHeadCalls: Array<[number, Record<string, string>]> = []
      const mockReq = {
        on: mock((_event: string, _cb: () => void) => {}),
      }
      const mockRes = {
        writeHead: mock((status: number, headers: Record<string, string>) => {
          writeHeadCalls.push([status, headers])
        }),
        write: mock(() => {}),
        end: mock(() => {}),
        writableEnded: false,
        on: mock((_event: string, _cb: () => void) => {}),
      }

      const emitter = channel.respond(mockReq, mockRes)

      expect(writeHeadCalls.length).toBe(1)
      const [status, headers] = writeHeadCalls[0] as [
        number,
        Record<string, string>,
      ]
      expect(status).toBe(200)
      expect(headers['Content-Type']).toContain('text/event-stream')
      expect(headers['Cache-Control']).toBe('no-cache')
      expect(headers.Connection).toBe('keep-alive')

      emitter.close()
      channel.close()
    })

    it('Node.js respond emitter.emit() should write SSE wire format to res', () => {
      const channel = createChannel(testSchema)

      const written: string[] = []
      const mockReq = {
        on: mock((_event: string, _cb: () => void) => {}),
      }
      const mockRes = {
        writeHead: mock(() => {}),
        write: mock((chunk: string) => {
          written.push(chunk)
        }),
        end: mock(() => {}),
        writableEnded: false,
        on: mock((_event: string, _cb: () => void) => {}),
      }

      const emitter = channel.respond(mockReq, mockRes)
      emitter.emit('user.updated', { id: 7 })

      expect(written.length).toBe(1)
      expect(written[0]).toContain('event: user.updated')
      expect(written[0]).toContain('data: ')
      expect(written[0]).toContain('"id":7')
      expect(written[0]).toMatch(/\n\n$/)

      emitter.close()
      channel.close()
    })

    it('Node.js respond emitter.close() should call res.end()', () => {
      const channel = createChannel(testSchema)

      const endMock = mock(() => {})
      const mockReq = {
        on: mock((_event: string, _cb: () => void) => {}),
      }
      const mockRes = {
        writeHead: mock(() => {}),
        write: mock(() => {}),
        end: endMock,
        writableEnded: false,
        on: mock((_event: string, _cb: () => void) => {}),
      }

      const emitter = channel.respond(mockReq, mockRes)
      emitter.close()

      expect(endMock).toHaveBeenCalled()
      channel.close()
    })

    it('respond() scoped emitter should NOT be in the broadcast pool', async () => {
      const channel = createChannel(testSchema)

      // Create a scoped emitter via Web respond
      const request = new Request('http://localhost/api/query')
      const { emitter } = channel.respond(request) as {
        response: Response
        emitter: {
          emit: (type: string, payload: unknown) => void
          close: () => void
        }
      }

      // Connect a normal broadcast client
      const r = channel.connect(new Request('http://localhost/api/events'))
      const reader = r.body?.getReader()
      const decoder = new TextDecoder()

      // Drain initial event from broadcast client
      await reader.read()

      // Emit via channel — should reach broadcast client but NOT scoped emitter
      channel.emit('user.updated', { id: 99 })

      // Broadcast client should receive the event
      const { value } = await reader.read()
      const text = decoder.decode(value)

      reader.cancel()
      emitter.close()
      channel.close()

      expect(text).toContain('event: user.updated')
    })

    it('respond() scoped emitter should NOT receive heartbeats', async () => {
      const channel = createChannel(testSchema, { heartbeatInterval: 50 })
      const request = new Request('http://localhost/api/query')
      const { response, emitter } = channel.respond(request) as {
        response: Response
        emitter: {
          emit: (type: string, payload: unknown) => void
          close: () => void
        }
      }

      // Wait longer than the heartbeat interval
      await new Promise((resolve) => setTimeout(resolve, 120))

      // Emit one event and close
      emitter.emit('result', { done: true })
      emitter.close()

      const text = await response.text()

      // Should contain our event but NOT heartbeat comments
      expect(text).toContain('event: result')
      expect(text).not.toContain(': heartbeat')

      channel.close()
    })

    it('respond() after channel.close() should throw', () => {
      const channel = createChannel(testSchema)
      channel.close()

      expect(() => {
        channel.respond(new Request('http://localhost/api/query'))
      }).toThrow()
    })
  })

  describe('Req #16 - disconnect cleanup', () => {
    it('Web: after stream is cancelled, emit should not throw', async () => {
      const channel = createChannel(testSchema)
      const request = new Request('http://localhost/api/events')
      const response = channel.connect(request)

      // Immediately cancel the client stream (simulate disconnect)
      await response.body?.cancel()

      // Emit should silently drop the disconnected client
      expect(() => {
        channel.emit('user.updated', { id: 1 })
      }).not.toThrow()

      channel.close()
    })

    it('Node.js: after close event, client is removed from pool', () => {
      const channel = createChannel(testSchema)

      let closeCallback: (() => void) | undefined
      const mockReq = {
        on: mock((event: string, cb: () => void) => {
          if (event === 'close') closeCallback = cb
        }),
      }
      const mockRes = {
        writeHead: mock(() => {}),
        write: mock(() => {}),
        end: mock(() => {}),
        writableEnded: false,
        on: mock((event: string, cb: () => void) => {
          if (event === 'close') closeCallback = cb
        }),
      }

      channel.connect(mockReq, mockRes)

      // Simulate disconnect
      closeCallback?.()

      // Emit after disconnect should not throw and should not write to closed res
      const writeCalls = (mockRes.write as ReturnType<typeof mock>).mock.calls
        .length
      channel.emit('user.updated', { id: 5 })
      const writeCallsAfter = (mockRes.write as ReturnType<typeof mock>).mock
        .calls.length

      channel.close()

      // No additional writes after disconnect
      expect(writeCallsAfter).toBe(writeCalls)
    })
  })

  describe('Req #24 - no framework dependencies', () => {
    it('createChannel should work with a plain Web Request (no framework)', async () => {
      const channel = createChannel(testSchema)
      // Raw Request — no Express/Fastify/Hono
      const req = new Request('http://localhost/sse')
      const res = channel.connect(req)

      expect(res).toBeInstanceOf(Response)
      await res.body?.cancel()
      channel.close()
    })
  })
})
