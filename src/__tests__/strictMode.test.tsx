import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { createElement, StrictMode, Suspense, useState } from 'react'
import { renderToString } from 'react-dom/server'
import { SWRConfig } from 'swr'
import { SSEProvider } from '../SSEProvider.tsx'
import { defineSchema } from '../schema.ts'
import type { SSEConfig, SSETransport } from '../types.ts'
import {
  actSync,
  cleanupDom,
  flush,
  installDom,
  render,
} from './helpers/dom.ts'

/**
 * SSEProvider connection lifecycle on a real client renderer (issue #13).
 *
 * React StrictMode runs effect cleanup and setup once more after mount
 * without rendering again. Setup and cleanup must be symmetric so that cycle
 * ends with exactly one open connection and the visibility listener attached.
 */

class MockEventSource {
  static instances: MockEventSource[] = []
  url: string
  readyState = 0
  onmessage: ((event: MessageEvent) => void) | null = null
  onerror: ((event: Event) => void) | null = null
  onopen: ((event: Event) => void) | null = null

  constructor(url: string) {
    this.url = url
    MockEventSource.instances.push(this)
  }

  addEventListener() {}
  removeEventListener() {}

  close() {
    this.readyState = 2
  }

  simulateOpen() {
    this.readyState = 1
    this.onopen?.(new Event('open'))
  }

  /** Drop the connection without telling the provider, as a sleeping tab might */
  dropSilently() {
    this.readyState = 2
  }

  static open(): MockEventSource[] {
    return MockEventSource.instances.filter((es) => es.readyState !== 2)
  }
}

const originalEventSource = globalThis.EventSource

function provider(config: SSEConfig, strict: boolean) {
  const tree = createElement(SSEProvider, { config }, createElement('div'))
  return strict ? createElement(StrictMode, null, tree) : tree
}

describe('SSEProvider connection lifecycle (#13)', () => {
  beforeEach(() => {
    installDom()
    MockEventSource.instances = []
    // @ts-expect-error - Mocking EventSource
    globalThis.EventSource = MockEventSource
  })

  afterEach(() => {
    cleanupDom()
    globalThis.EventSource = originalEventSource
  })

  describe('StrictMode', () => {
    it('ends with exactly one open connection after mount', () => {
      render(provider({ url: '/events', events: {} }, true))

      expect(MockEventSource.open().length).toBe(1)
    })

    it('keeps the visibility handler attached', async () => {
      render(
        provider(
          { url: '/events', events: {}, reconnect: { enabled: true } },
          true,
        ),
      )
      const live = MockEventSource.open()
      expect(live.length).toBe(1)
      live[0]?.dropSilently()

      await flush(() => {
        document.dispatchEvent(new Event('visibilitychange'))
      })

      expect(document.visibilityState).toBe('visible')
      expect(MockEventSource.open().length).toBe(1)
      expect(MockEventSource.open()[0]).not.toBe(live[0])
    })

    it('calls onConnect once and, on unmount, onDisconnect once', async () => {
      let connects = 0
      let disconnects = 0
      const { unmount } = render(
        provider(
          {
            url: '/events',
            events: {},
            onConnect: () => {
              connects++
            },
            onDisconnect: () => {
              disconnects++
            },
          },
          true,
        ),
      )
      await flush(() => MockEventSource.open()[0]?.simulateOpen())
      expect(connects).toBe(1)
      expect(disconnects).toBe(0)

      unmount()

      expect(MockEventSource.open().length).toBe(0)
      expect(disconnects).toBe(1)
    })
  })

  describe('without StrictMode', () => {
    it('opens one connection on mount', () => {
      render(provider({ url: '/events', events: {} }, false))

      expect(MockEventSource.instances.length).toBe(1)
      expect(MockEventSource.open().length).toBe(1)
    })

    it('closes the connection and calls onDisconnect once on unmount', async () => {
      let disconnects = 0
      const { unmount } = render(
        provider(
          {
            url: '/events',
            events: {},
            onDisconnect: () => {
              disconnects++
            },
          },
          false,
        ),
      )
      await flush(() => MockEventSource.instances[0]?.simulateOpen())

      unmount()

      expect(MockEventSource.open().length).toBe(0)
      expect(disconnects).toBe(1)
    })

    it('stops listening for visibilitychange after unmount', async () => {
      const { unmount } = render(
        provider(
          { url: '/events', events: {}, reconnect: { enabled: true } },
          false,
        ),
      )
      unmount()
      const created = MockEventSource.instances.length

      await flush(() => {
        document.dispatchEvent(new Event('visibilitychange'))
      })

      expect(MockEventSource.instances.length).toBe(created)
    })

    it('on a URL change closes the old connection and opens one for the new URL', () => {
      let setUrl: (url: string) => void = () => {}
      function Host() {
        const [url, update] = useState('/a')
        setUrl = update
        return createElement(
          SSEProvider,
          { config: { url, events: {} } },
          createElement('div'),
        )
      }
      render(createElement(Host))
      expect(MockEventSource.open().map((es) => es.url)).toEqual(['/a'])

      actSync(() => setUrl('/b'))

      expect(MockEventSource.instances.map((es) => es.url)).toEqual([
        '/a',
        '/b',
      ])
      expect(MockEventSource.open().map((es) => es.url)).toEqual(['/b'])
    })

    it('after a URL change, unmount closes the current connection', () => {
      let setUrl: (url: string) => void = () => {}
      function Host() {
        const [url, update] = useState('/a')
        setUrl = update
        return createElement(
          SSEProvider,
          { config: { url, events: {} } },
          createElement('div'),
        )
      }
      const { unmount } = render(createElement(Host))
      actSync(() => setUrl('/b'))

      unmount()

      expect(MockEventSource.open().length).toBe(0)
    })

    it('clears a pending reconnect timer on unmount', async () => {
      const { unmount } = render(
        provider(
          {
            url: '/events',
            events: {},
            reconnect: { enabled: true, initialDelay: 20, maxAttempts: 5 },
          },
          false,
        ),
      )
      const first = MockEventSource.instances[0]
      await flush(() => {
        first?.simulateOpen()
        if (first) {
          first.readyState = 2
          first.onerror?.(new Event('error'))
        }
      })

      unmount()
      await flush(() => new Promise((resolve) => setTimeout(resolve, 50)))

      expect(MockEventSource.instances.length).toBe(1)
    })

    it('opens a custom transport in an effect and closes it on unmount', () => {
      const transports: Array<SSETransport & { closed: boolean }> = []
      const { unmount } = render(
        provider(
          {
            url: '/events',
            events: {},
            transport: () => {
              const t = {
                readyState: 0,
                closed: false,
                onmessage: null,
                onerror: null,
                onopen: null,
                close() {
                  t.closed = true
                  t.readyState = 2
                },
                addEventListener() {},
                removeEventListener() {},
              }
              transports.push(t)
              return t
            },
          },
          false,
        ),
      )
      expect(transports.length).toBe(1)

      unmount()

      expect(transports[0]?.closed).toBe(true)
    })
  })

  describe('Suspense', () => {
    it('does not leak connections when a child suspends', async () => {
      const schema = defineSchema({
        'thing.updated': { key: '/api/thing', update: 'set' },
      })
      let pending: Promise<void> | null = new Promise<void>((resolve) => {
        setTimeout(() => {
          pending = null
          resolve()
        }, 20)
      })
      let childRendered = false
      function SlowChild() {
        if (pending) {
          throw pending
        }
        childRendered = true
        return createElement('span', null, 'ready')
      }

      render(
        createElement(
          SWRConfig,
          { value: { provider: () => new Map() } },
          createElement(
            Suspense,
            { fallback: createElement('span', null, 'loading') },
            createElement(
              SSEProvider,
              { config: { url: '/events', schema } },
              createElement(SlowChild),
            ),
          ),
        ),
      )
      await flush(() => new Promise((resolve) => setTimeout(resolve, 60)))

      expect(childRendered).toBe(true)
      expect(MockEventSource.instances.length).toBe(1)
      expect(MockEventSource.open().length).toBe(1)
    })
  })

  describe('server rendering (renderToString) opens nothing', () => {
    // EventSource is defined here (the mock), so these also show that render
    // alone never opens a connection, which a real server cannot prove
    // because it has no EventSource.
    it('with plain EventSource', async () => {
      renderToString(provider({ url: '/events', events: {} }, false))
      await new Promise((resolve) => setTimeout(resolve, 0))

      expect(MockEventSource.instances.length).toBe(0)
    })

    it('with a custom transport', async () => {
      let transportCalls = 0
      renderToString(
        provider(
          {
            url: '/events',
            events: {},
            transport: () => {
              transportCalls++
              throw new Error('must not be called during server rendering')
            },
          },
          false,
        ),
      )
      await new Promise((resolve) => setTimeout(resolve, 0))

      expect(transportCalls).toBe(0)
    })

    it('with the fetch transport', async () => {
      const originalFetch = globalThis.fetch
      const fetchCalls: string[] = []
      globalThis.fetch = ((input: RequestInfo | URL) => {
        fetchCalls.push(String(input))
        return new Promise<Response>(() => {})
      }) as typeof fetch
      try {
        renderToString(
          provider(
            {
              url: '/events',
              events: {},
              headers: { Authorization: 'Bearer t' },
            },
            false,
          ),
        )
        // createFetchTransport calls fetch on a microtask; let it run
        await new Promise((resolve) => setTimeout(resolve, 0))
      } finally {
        globalThis.fetch = originalFetch
      }

      expect(fetchCalls).toEqual([])
      expect(MockEventSource.instances.length).toBe(0)
    })
  })
})
