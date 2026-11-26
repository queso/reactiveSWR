import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { createElement, type ReactNode } from 'react'
import useSWR, { SWRConfig } from 'swr'
import { useSSEEvent } from '../hooks/useSSEEvent.ts'
import { SSEProvider } from '../SSEProvider.tsx'
import { defineSchema } from '../schema.ts'
import { mockSSE } from '../testing/index.ts'
import type { SSEConfig } from '../types.ts'
import { cleanupDom, flush, installDom, render } from './helpers/dom.ts'

/**
 * mockSSE driving a real SSEProvider and a real SWR cache (issue #11).
 *
 * The library's server (createChannel) writes every event as a named frame,
 * `event: <type>\ndata: <payload>`. A real EventSource delivers that frame to
 * addEventListener(type) listeners only, never to onmessage. SSEProvider
 * registers a named listener for each schema event and reads event.data as
 * the payload. These tests check that one sendEvent reaches the provider
 * exactly once and that the cache ends up holding the payload.
 */

const URL = '/api/events'
const KEY = '/api/thing'

const schema = defineSchema({
  'thing.updated': { key: KEY, update: 'set' },
})

interface Thing {
  name: string
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitFor(check: () => boolean, timeoutMs = 1000): Promise<void> {
  const start = Date.now()
  while (!check()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error('waitFor timed out')
    }
    await flush(() => wait(5))
  }
}

interface Harness {
  cache: Map<string, { data?: unknown }>
  handlerCalls: unknown[]
  otherCalls: unknown[]
  rendered: Array<string | undefined>
}

function mount(config: SSEConfig): Harness {
  const cache = new Map<string, { data?: unknown }>()
  const harness: Harness = {
    cache,
    handlerCalls: [],
    otherCalls: [],
    rendered: [],
  }

  function Thing() {
    const { data } = useSWR<Thing>(KEY, async () => ({ name: 'first' }))
    harness.rendered.push(data?.name)
    useSSEEvent('thing.updated', (payload) => {
      harness.handlerCalls.push(payload)
    })
    useSSEEvent('not.in.schema', (payload) => {
      harness.otherCalls.push(payload)
    })
    return createElement('span', null, data?.name ?? '')
  }

  const tree: ReactNode = createElement(
    SWRConfig,
    {
      value: {
        // biome-ignore lint/suspicious/noExplicitAny: SWR cache provider typing
        provider: () => cache as any,
        dedupingInterval: 0,
      },
    },
    createElement(SSEProvider, { config }, createElement(Thing)),
  )
  render(tree)
  return harness
}

describe('mockSSE with SSEProvider and a schema (#11)', () => {
  beforeEach(() => {
    installDom()
  })

  afterEach(() => {
    cleanupDom()
    mockSSE.restore()
  })

  describe('EventSource transport', () => {
    it('puts the payload in the cache and runs the handler once', async () => {
      const mock = mockSSE(URL)
      const h = mount({ url: URL, schema })
      await waitFor(() => h.rendered.includes('first'))

      await flush(() =>
        mock.sendEvent({
          type: 'thing.updated',
          payload: { name: 'second' },
        }),
      )

      expect(h.cache.get(KEY)?.data).toEqual({ name: 'second' })
      expect(h.handlerCalls).toEqual([{ name: 'second' }])
      expect(h.rendered.at(-1)).toBe('second')
    })

    it('does not deliver a named event to onmessage', async () => {
      const mock = mockSSE(URL)
      mount({ url: URL, schema })
      const connection = mock.getConnection()
      expect(connection).toBeDefined()

      const viaOnmessage: unknown[] = []
      const original = connection?.onmessage ?? null
      if (connection) {
        connection.onmessage = (event: MessageEvent) => {
          viaOnmessage.push(event.data)
          original?.(event)
        }
      }

      await flush(() =>
        mock.sendEvent({
          type: 'thing.updated',
          payload: { name: 'second' },
        }),
      )

      expect(viaOnmessage).toEqual([])
    })

    it('does not deliver a type the schema does not name, as a real server would not', async () => {
      const mock = mockSSE(URL)
      const h = mount({ url: URL, schema })

      await flush(() =>
        mock.sendEvent({ type: 'not.in.schema', payload: { n: 1 } }),
      )

      expect(h.otherCalls).toEqual([])
    })
  })

  describe('fetch transport (sendEventToFetchStreams)', () => {
    it('puts the payload in the cache and runs the handler once', async () => {
      const mock = mockSSE(URL)
      const h = mount({
        url: URL,
        schema,
        headers: { Authorization: 'Bearer t' },
      })
      await waitFor(() => h.rendered.includes('first'))
      // Let the mock fetch resolve and the transport attach to the stream
      await flush(() => wait(10))

      await flush(() =>
        mock.sendEvent({
          type: 'thing.updated',
          payload: { name: 'second' },
        }),
      )
      await waitFor(() => h.handlerCalls.length > 0)
      // Give a second delivery, if there were one, time to arrive
      await flush(() => wait(20))

      expect(h.cache.get(KEY)?.data).toEqual({ name: 'second' })
      expect(h.handlerCalls).toEqual([{ name: 'second' }])
    })
  })

  describe("eventFormat: 'unnamed'", () => {
    it('sends {type, payload} as one unnamed message over EventSource', async () => {
      const mock = mockSSE(URL, { eventFormat: 'unnamed' })
      const h = mount({ url: URL, schema })
      await waitFor(() => h.rendered.includes('first'))

      await flush(() =>
        mock.sendEvent({
          type: 'thing.updated',
          payload: { name: 'second' },
        }),
      )
      await flush(() =>
        mock.sendEvent({ type: 'not.in.schema', payload: { n: 1 } }),
      )

      expect(h.cache.get(KEY)?.data).toEqual({ name: 'second' })
      expect(h.handlerCalls).toEqual([{ name: 'second' }])
      expect(h.otherCalls).toEqual([{ n: 1 }])
    })

    it('sends {type, payload} as one unnamed message over the fetch transport', async () => {
      const mock = mockSSE(URL, { eventFormat: 'unnamed' })
      const h = mount({
        url: URL,
        schema,
        headers: { Authorization: 'Bearer t' },
      })
      await waitFor(() => h.rendered.includes('first'))
      await flush(() => wait(10))

      await flush(() =>
        mock.sendEvent({
          type: 'thing.updated',
          payload: { name: 'second' },
        }),
      )
      await flush(() =>
        mock.sendEvent({ type: 'not.in.schema', payload: { n: 1 } }),
      )
      await waitFor(() => h.otherCalls.length > 0)
      await flush(() => wait(20))

      expect(h.cache.get(KEY)?.data).toEqual({ name: 'second' })
      expect(h.handlerCalls).toEqual([{ name: 'second' }])
      expect(h.otherCalls).toEqual([{ n: 1 }])
    })
  })
})
