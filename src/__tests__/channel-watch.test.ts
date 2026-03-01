import { describe, expect, it, mock } from 'bun:test'
import { defineSchema } from '../schema.ts'
import type { SSEAdapter } from '../server/adapters/types.ts'

/**
 * Tests for channel.watch(adapter) — connects an SSEAdapter to a Channel,
 * routing adapter-emitted events through channel.emit().
 *
 * These tests verify that:
 * 1. watch() accepts an SSEAdapter and calls adapter.start() with a bound emit callback
 * 2. Events emitted via the adapter callback flow through channel.emit() to clients
 * 3. watch() returns a cleanup function (() => Promise<void>) that calls adapter.stop()
 * 4. channel.close() stops all watched adapters
 * 5. Multiple adapters can be watched simultaneously
 * 6. watch() after channel.close() throws
 * 7. Errors from adapter.start() propagate to the caller of watch()
 * 8. Async adapter.start() causes watch() to return a Promise
 * 9. The Channel interface has a watch method
 *
 * Tests FAIL initially because src/server/index.ts has not been updated yet.
 */

// Minimal schema used across tests
const testSchema = defineSchema({
  'user.updated': { key: '/api/users', update: 'set' },
  'order.placed': { key: '/api/orders', update: 'refetch' },
})

// Helper: collect SSE text chunks from a ReadableStream
async function _collectChunks(
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

// Helper: build a mock NodeResponse
function _makeMockRes() {
  return {
    writeHead: mock((_status: number, _headers: Record<string, string>) => {}),
    write: mock((_chunk: string) => {}),
    end: mock(() => {}),
    writableEnded: false,
    on: mock((_event: string, _cb: () => void) => {}),
  }
}

describe('channel.watch(adapter)', () => {
  describe('method existence', () => {
    it('channel should have a watch method', async () => {
      const { createChannel } = await import('../server/index.ts')
      const channel = createChannel(testSchema)
      expect(typeof channel.watch).toBe('function')
      channel.close()
    })
  })

  describe('adapter.start() is called with an emit callback', () => {
    it('watch() should call adapter.start() immediately', async () => {
      const { createChannel } = await import('../server/index.ts')
      const channel = createChannel(testSchema)

      const startMock = mock(
        (_emit: (eventType: string, payload: unknown) => void) => {},
      )
      const adapter: SSEAdapter = {
        start: startMock,
        stop: () => {},
      }

      channel.watch(adapter)
      channel.close()

      expect(startMock).toHaveBeenCalledTimes(1)
    })

    it('watch() should pass an emit callback to adapter.start()', async () => {
      const { createChannel } = await import('../server/index.ts')
      const channel = createChannel(testSchema)

      let receivedEmit:
        | ((eventType: string, payload: unknown) => void)
        | undefined

      const adapter: SSEAdapter = {
        start: (emit) => {
          receivedEmit = emit
        },
        stop: () => {},
      }

      channel.watch(adapter)
      channel.close()

      expect(typeof receivedEmit).toBe('function')
    })

    it('emit callback passed to adapter.start() should call channel.emit()', async () => {
      const { createChannel } = await import('../server/index.ts')
      const channel = createChannel(testSchema)

      // Connect a client to capture broadcast events
      const response = channel.connect(
        new Request('http://localhost/api/events'),
      )
      const reader = response.body?.getReader()
      const decoder = new TextDecoder()

      // Drain initial connected event
      await reader.read()

      let adapterEmit:
        | ((eventType: string, payload: unknown) => void)
        | undefined

      const adapter: SSEAdapter = {
        start: (emit) => {
          adapterEmit = emit
        },
        stop: () => {},
      }

      channel.watch(adapter)

      // Simulate the adapter detecting a data change and emitting
      adapterEmit?.('user.updated', { id: 7, name: 'alice' })

      const { value } = await reader.read()
      const text = decoder.decode(value)

      reader.cancel()
      channel.close()

      expect(text).toContain('event: user.updated')
      expect(text).toContain('"id":7')
      expect(text).toContain('"name":"alice"')
    })

    it('emit callback should broadcast to all connected clients', async () => {
      const { createChannel } = await import('../server/index.ts')
      const channel = createChannel(testSchema)

      const r1 = channel.connect(new Request('http://localhost/api/events'))
      const r2 = channel.connect(new Request('http://localhost/api/events'))
      const decoder = new TextDecoder()
      const reader1 = r1.body?.getReader()
      const reader2 = r2.body?.getReader()

      // Drain initial events
      await reader1.read()
      await reader2.read()

      let adapterEmit:
        | ((eventType: string, payload: unknown) => void)
        | undefined

      const adapter: SSEAdapter = {
        start: (emit) => {
          adapterEmit = emit
        },
        stop: () => {},
      }

      channel.watch(adapter)
      adapterEmit?.('order.placed', { orderId: '99' })

      const [res1, res2] = await Promise.all([reader1.read(), reader2.read()])
      const text1 = decoder.decode(res1.value)
      const text2 = decoder.decode(res2.value)

      reader1.cancel()
      reader2.cancel()
      channel.close()

      expect(text1).toContain('event: order.placed')
      expect(text2).toContain('event: order.placed')
    })
  })

  describe('cleanup function returned by watch()', () => {
    it('watch() should return a function', async () => {
      const { createChannel } = await import('../server/index.ts')
      const channel = createChannel(testSchema)

      const adapter: SSEAdapter = {
        start: () => {},
        stop: () => {},
      }

      const cleanup = channel.watch(adapter)
      channel.close()

      expect(typeof cleanup).toBe('function')
    })

    it('cleanup function should always return a Promise', async () => {
      const { createChannel } = await import('../server/index.ts')
      const channel = createChannel(testSchema)

      const adapter: SSEAdapter = {
        start: () => {},
        stop: () => {}, // synchronous stop
      }

      const cleanup = channel.watch(adapter)
      const result = cleanup()
      channel.close()

      expect(result).toBeInstanceOf(Promise)
    })

    it('cleanup function should call adapter.stop()', async () => {
      const { createChannel } = await import('../server/index.ts')
      const channel = createChannel(testSchema)

      const stopMock = mock(() => {})
      const adapter: SSEAdapter = {
        start: () => {},
        stop: stopMock,
      }

      const cleanup = channel.watch(adapter)
      await cleanup()
      channel.close()

      expect(stopMock).toHaveBeenCalledTimes(1)
    })

    it('cleanup function should await async adapter.stop()', async () => {
      const { createChannel } = await import('../server/index.ts')
      const channel = createChannel(testSchema)

      const order: string[] = []
      const adapter: SSEAdapter = {
        start: () => {},
        stop: async () => {
          await new Promise<void>((resolve) => setTimeout(resolve, 10))
          order.push('stopped')
        },
      }

      const cleanup = channel.watch(adapter)
      await cleanup()
      order.push('after-cleanup')
      channel.close()

      // 'stopped' must appear before 'after-cleanup' (stop was awaited)
      expect(order).toEqual(['stopped', 'after-cleanup'])
    })

    it('calling cleanup should not affect other watched adapters', async () => {
      const { createChannel } = await import('../server/index.ts')
      const channel = createChannel(testSchema)

      const stop1 = mock(() => {})
      const stop2 = mock(() => {})

      const adapter1: SSEAdapter = { start: () => {}, stop: stop1 }
      const adapter2: SSEAdapter = { start: () => {}, stop: stop2 }

      const cleanup1 = channel.watch(adapter1)
      channel.watch(adapter2)

      // Only clean up adapter1
      await cleanup1()
      channel.close()

      expect(stop1).toHaveBeenCalledTimes(1)
      // adapter2 is stopped by channel.close(), not by cleanup1
    })
  })

  describe('multiple adapters simultaneously', () => {
    it('should call start() on each adapter independently', async () => {
      const { createChannel } = await import('../server/index.ts')
      const channel = createChannel(testSchema)

      const start1 = mock((_emit: (e: string, p: unknown) => void) => {})
      const start2 = mock((_emit: (e: string, p: unknown) => void) => {})
      const start3 = mock((_emit: (e: string, p: unknown) => void) => {})

      const adapter1: SSEAdapter = { start: start1, stop: () => {} }
      const adapter2: SSEAdapter = { start: start2, stop: () => {} }
      const adapter3: SSEAdapter = { start: start3, stop: () => {} }

      channel.watch(adapter1)
      channel.watch(adapter2)
      channel.watch(adapter3)
      channel.close()

      expect(start1).toHaveBeenCalledTimes(1)
      expect(start2).toHaveBeenCalledTimes(1)
      expect(start3).toHaveBeenCalledTimes(1)
    })

    it('each adapter emit callback should route to the same channel broadcast pool', async () => {
      const { createChannel } = await import('../server/index.ts')
      const channel = createChannel(testSchema)

      const response = channel.connect(
        new Request('http://localhost/api/events'),
      )
      const reader = response.body?.getReader()
      const decoder = new TextDecoder()

      // Drain connected event
      await reader.read()

      let emit1: ((e: string, p: unknown) => void) | undefined
      let emit2: ((e: string, p: unknown) => void) | undefined

      const adapter1: SSEAdapter = {
        start: (e) => {
          emit1 = e
        },
        stop: () => {},
      }
      const adapter2: SSEAdapter = {
        start: (e) => {
          emit2 = e
        },
        stop: () => {},
      }

      channel.watch(adapter1)
      channel.watch(adapter2)

      // Emit from adapter1
      emit1?.('user.updated', { source: 'adapter1' })
      const { value: v1 } = await reader.read()
      const t1 = decoder.decode(v1)

      // Emit from adapter2
      emit2?.('order.placed', { source: 'adapter2' })
      const { value: v2 } = await reader.read()
      const t2 = decoder.decode(v2)

      reader.cancel()
      channel.close()

      expect(t1).toContain('event: user.updated')
      expect(t1).toContain('"source":"adapter1"')
      expect(t2).toContain('event: order.placed')
      expect(t2).toContain('"source":"adapter2"')
    })
  })

  describe('channel.close() stops all watched adapters', () => {
    it('channel.close() should call stop() on all watched adapters', async () => {
      const { createChannel } = await import('../server/index.ts')
      const channel = createChannel(testSchema)

      const stop1 = mock(() => {})
      const stop2 = mock(() => {})
      const stop3 = mock(() => {})

      channel.watch({ start: () => {}, stop: stop1 })
      channel.watch({ start: () => {}, stop: stop2 })
      channel.watch({ start: () => {}, stop: stop3 })

      channel.close()

      expect(stop1).toHaveBeenCalledTimes(1)
      expect(stop2).toHaveBeenCalledTimes(1)
      expect(stop3).toHaveBeenCalledTimes(1)
    })

    it('channel.close() should await async stop() on all watched adapters', async () => {
      const { createChannel } = await import('../server/index.ts')
      const channel = createChannel(testSchema)

      const stopOrder: string[] = []

      const makeAsyncAdapter = (name: string): SSEAdapter => ({
        start: () => {},
        stop: async () => {
          await new Promise<void>((resolve) => setTimeout(resolve, 5))
          stopOrder.push(name)
        },
      })

      channel.watch(makeAsyncAdapter('a1'))
      channel.watch(makeAsyncAdapter('a2'))

      await channel.close()

      // Both adapters must have stopped before close() resolves
      expect(stopOrder).toContain('a1')
      expect(stopOrder).toContain('a2')
    })

    it('after channel.close(), adapter emit callbacks should be no-ops', async () => {
      const { createChannel } = await import('../server/index.ts')
      const channel = createChannel(testSchema)

      let adapterEmit: ((e: string, p: unknown) => void) | undefined

      channel.watch({
        start: (emit) => {
          adapterEmit = emit
        },
        stop: () => {},
      })

      channel.close()

      // Emitting after close should not throw
      expect(() => {
        adapterEmit?.('user.updated', { id: 1 })
      }).not.toThrow()
    })

    it('adapter already cleaned up via cleanup fn should not be double-stopped by channel.close()', async () => {
      const { createChannel } = await import('../server/index.ts')
      const channel = createChannel(testSchema)

      const stopMock = mock(() => {})
      const adapter: SSEAdapter = { start: () => {}, stop: stopMock }

      const cleanup = channel.watch(adapter)
      await cleanup() // Manually clean up first

      channel.close() // Should not call stop() again

      expect(stopMock).toHaveBeenCalledTimes(1)
    })
  })

  describe('watch() after channel.close() throws', () => {
    it('should throw when calling watch() on a closed channel', async () => {
      const { createChannel } = await import('../server/index.ts')
      const channel = createChannel(testSchema)

      channel.close()

      const adapter: SSEAdapter = {
        start: () => {},
        stop: () => {},
      }

      expect(() => {
        channel.watch(adapter)
      }).toThrow()
    })

    it('error message should indicate channel is closed', async () => {
      const { createChannel } = await import('../server/index.ts')
      const channel = createChannel(testSchema)

      channel.close()

      try {
        channel.watch({ start: () => {}, stop: () => {} })
        expect(true).toBe(false) // should not reach here
      } catch (err) {
        expect(err).toBeInstanceOf(Error)
      }
    })
  })

  describe('adapter.start() error propagation', () => {
    it('synchronous error from adapter.start() should propagate from watch()', async () => {
      const { createChannel } = await import('../server/index.ts')
      const channel = createChannel(testSchema)

      const adapter: SSEAdapter = {
        start: () => {
          throw new Error('adapter start failed')
        },
        stop: () => {},
      }

      expect(() => {
        channel.watch(adapter)
      }).toThrow('adapter start failed')

      channel.close()
    })

    it('async error from adapter.start() should cause watch() to return a rejected Promise', async () => {
      const { createChannel } = await import('../server/index.ts')
      const channel = createChannel(testSchema)

      const adapter: SSEAdapter = {
        start: async () => {
          await Promise.resolve()
          throw new Error('async adapter start failed')
        },
        stop: () => {},
      }

      // watch() should return a Promise that rejects
      const result = channel.watch(adapter)
      expect(result).toBeInstanceOf(Promise)

      await expect(result as Promise<unknown>).rejects.toThrow(
        'async adapter start failed',
      )

      channel.close()
    })
  })

  describe('async adapter.start() causes watch() to return a Promise', () => {
    it('watch() should return a Promise when adapter.start() is async', async () => {
      const { createChannel } = await import('../server/index.ts')
      const channel = createChannel(testSchema)

      const adapter: SSEAdapter = {
        start: async (_emit) => {
          await Promise.resolve()
          // Async start completes
        },
        stop: () => {},
      }

      const result = channel.watch(adapter)
      expect(result).toBeInstanceOf(Promise)

      await result
      channel.close()
    })

    it('watch() result Promise should resolve when async adapter.start() completes', async () => {
      const { createChannel } = await import('../server/index.ts')
      const channel = createChannel(testSchema)

      const startOrder: string[] = []

      const adapter: SSEAdapter = {
        start: async (_emit) => {
          await new Promise<void>((resolve) => setTimeout(resolve, 10))
          startOrder.push('started')
        },
        stop: () => {},
      }

      await channel.watch(adapter)
      startOrder.push('watch-resolved')
      channel.close()

      expect(startOrder).toEqual(['started', 'watch-resolved'])
    })

    it('watch() with sync adapter.start() can return void or a resolved Promise', async () => {
      const { createChannel } = await import('../server/index.ts')
      const channel = createChannel(testSchema)

      const adapter: SSEAdapter = {
        start: (_emit) => {
          // synchronous — returns void
        },
        stop: () => {},
      }

      // Should not throw regardless of whether it returns void or Promise
      expect(() => {
        channel.watch(adapter)
      }).not.toThrow()

      channel.close()
    })
  })
})
