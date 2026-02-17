/**
 * Testing utilities for reactiveSWR.
 *
 * Provides mockSSE to intercept and simulate EventSource and fetch-based
 * SSE connections in test environments without real SSE servers.
 */

interface SSEEventData {
  type: string
  payload: unknown
}

interface MockSSEControls {
  sendEvent: (event: SSEEventData) => void
  sendRaw: (text: string) => void
  sendSSE: (data: unknown) => void
  close: () => void
  getConnection: () => MockEventSource | undefined
}

type EventListenerEntry = (event: Event) => void

class MockEventSource {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSED = 2

  readonly CONNECTING = 0
  readonly OPEN = 1
  readonly CLOSED = 2

  readonly url: string
  readonly withCredentials: boolean = false

  readyState: number = MockEventSource.CONNECTING

  onopen: ((event: Event) => void) | null = null
  onmessage: ((event: MessageEvent) => void) | null = null
  onerror: ((event: Event) => void) | null = null

  private listeners: Map<string, EventListenerEntry[]> = new Map()
  private disposed = false

  constructor(url: string | URL, _eventSourceInitDict?: EventSourceInit) {
    this.url = typeof url === 'string' ? url : url.toString()
    this.onopen = () => {
      this.readyState = MockEventSource.OPEN
    }
    mockRegistry.registerInstance(this.url, this)
  }

  addEventListener(type: string, listener: EventListenerEntry): void {
    const existing = this.listeners.get(type)
    if (existing) {
      existing.push(listener)
    } else {
      this.listeners.set(type, [listener])
    }
  }

  removeEventListener(type: string, listener: EventListenerEntry): void {
    const existing = this.listeners.get(type)
    if (!existing) return
    const index = existing.indexOf(listener)
    if (index !== -1) {
      existing.splice(index, 1)
    }
  }

  dispatchEvent(event: Event): boolean {
    if (this.disposed) return false

    const listeners = this.listeners.get(event.type)
    if (listeners) {
      for (const listener of listeners) {
        listener(event)
      }
    }
    return true
  }

  close(): void {
    this.readyState = MockEventSource.CLOSED
    this.disposed = true
  }

  /** Internal: dispatch a message event from mock controls */
  _dispatchMessage(data: SSEEventData): void {
    if (this.disposed) return

    const jsonData = JSON.stringify(data)
    const messageEvent = new MessageEvent('message', {
      data: jsonData,
      origin: '',
      lastEventId: '',
    })

    if (this.onmessage) {
      this.onmessage(messageEvent)
    }

    const namedEvent = new MessageEvent(data.type, {
      data: jsonData,
      origin: '',
      lastEventId: '',
    })
    this.dispatchEvent(namedEvent)
  }

  /** Internal: simulate connection error/close */
  _dispatchError(): void {
    this.readyState = MockEventSource.CLOSED
    const errorEvent = new Event('error')

    if (this.onerror) {
      this.onerror(errorEvent)
    }

    this.dispatchEvent(errorEvent)
    this.disposed = true
  }

  /** Internal: transition to open state */
  _open(): void {
    this.readyState = MockEventSource.OPEN
    const openEvent = new Event('open')

    if (this.onopen) {
      this.onopen(openEvent)
    }

    this.dispatchEvent(openEvent)
  }
}

/** Tracks a fetch-based SSE stream controller for a URL */
interface FetchStreamEntry {
  controller: ReadableStreamDefaultController<Uint8Array>
  closed: boolean
}

/**
 * Registry that tracks URL-to-instance mappings and manages
 * the global EventSource and fetch override lifecycle.
 */
class MockRegistry {
  private instances: Map<string, MockEventSource> = new Map()
  private fetchStreams: Map<string, FetchStreamEntry[]> = new Map()
  private registeredUrls: Set<string> = new Set()
  private originalEventSource: typeof EventSource | undefined = undefined
  private originalFetch: typeof globalThis.fetch | undefined = undefined
  // biome-ignore lint/suspicious/noExplicitAny: storing original Request constructor
  private originalRequest: any = undefined
  private installed = false
  private restored = false

  install(): void {
    if (this.installed) return

    this.originalEventSource = globalThis.EventSource
    // biome-ignore lint/suspicious/noExplicitAny: MockEventSource satisfies EventSource shape for testing
    globalThis.EventSource = MockEventSource as any

    this.originalFetch = globalThis.fetch
    this.originalRequest = globalThis.Request

    // Patch Request to support relative URLs for registered mock URLs
    const OriginalRequest = globalThis.Request
    const registeredUrls = this.registeredUrls
    // biome-ignore lint/suspicious/noExplicitAny: wrapping Request constructor for relative URL support
    globalThis.Request = function MockRequest(input: any, init?: any): Request {
      if (typeof input === 'string' && registeredUrls.has(input)) {
        // Store the relative URL so fetch can match it
        const req = new OriginalRequest(`http://localhost${input}`, init)
        Object.defineProperty(req, 'url', {
          value: input,
          writable: false,
          configurable: true,
        })
        return req
      }
      return new OriginalRequest(input, init)
      // biome-ignore lint/suspicious/noExplicitAny: MockRequest needs to be assigned as Request
    } as any

    const self = this
    globalThis.fetch = function mockFetch(
      input: RequestInfo | URL,
      init?: RequestInit,
    ): Promise<Response> {
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url

      if (self.registeredUrls.has(url)) {
        return self.createMockFetchResponse(url)
      }

      return self.originalFetch?.(input, init) as Promise<Response>
    } as typeof globalThis.fetch

    this.installed = true
    this.restored = false
  }

  restore(): void {
    if (!this.installed) return

    if (this.originalEventSource) {
      globalThis.EventSource = this.originalEventSource
    }

    if (this.originalFetch) {
      globalThis.fetch = this.originalFetch
    }

    if (this.originalRequest) {
      globalThis.Request = this.originalRequest
    }

    for (const instance of this.instances.values()) {
      instance.close()
    }

    for (const entries of this.fetchStreams.values()) {
      for (const entry of entries) {
        if (!entry.closed) {
          try {
            entry.controller.close()
          } catch {
            // already closed
          }
          entry.closed = true
        }
      }
    }

    this.instances.clear()
    this.fetchStreams.clear()
    this.registeredUrls.clear()
    this.installed = false
    this.restored = true
  }

  registerUrl(url: string): void {
    this.registeredUrls.add(url)
  }

  registerInstance(url: string, instance: MockEventSource): void {
    this.instances.set(url, instance)
  }

  getInstance(url: string): MockEventSource | undefined {
    return this.instances.get(url)
  }

  isRestored(): boolean {
    return this.restored
  }

  private createMockFetchResponse(url: string): Promise<Response> {
    let streamEntry: FetchStreamEntry

    const stream = new ReadableStream<Uint8Array>({
      start: (controller) => {
        streamEntry = { controller, closed: false }
        const entries = this.fetchStreams.get(url)
        if (entries) {
          entries.push(streamEntry)
        } else {
          this.fetchStreams.set(url, [streamEntry])
        }
      },
    })

    const response = new Response(stream, {
      status: 200,
      headers: {
        'content-type': 'text/event-stream',
      },
    })

    return Promise.resolve(response)
  }

  sendEventToFetchStreams(url: string, event: SSEEventData): void {
    const entries = this.fetchStreams.get(url)
    if (!entries) return

    const encoder = new TextEncoder()
    const sseText = `data: ${JSON.stringify(event)}\n\n`
    const chunk = encoder.encode(sseText)

    for (const entry of entries) {
      if (!entry.closed) {
        entry.controller.enqueue(chunk)
      }
    }
  }

  sendRawToFetchStreams(url: string, text: string): void {
    const entries = this.fetchStreams.get(url)
    if (!entries) return

    const encoder = new TextEncoder()
    const chunk = encoder.encode(text)

    for (const entry of entries) {
      if (!entry.closed) {
        entry.controller.enqueue(chunk)
      }
    }
  }

  closeFetchStreams(url: string): void {
    const entries = this.fetchStreams.get(url)
    if (!entries) return

    for (const entry of entries) {
      if (!entry.closed) {
        try {
          entry.controller.close()
        } catch {
          // already closed
        }
        entry.closed = true
      }
    }
  }
}

const mockRegistry = new MockRegistry()

/**
 * Create a mock SSE connection for the given URL.
 *
 * Intercepts both the global EventSource constructor and fetch so that
 * `new EventSource(url)` and `fetch(url)` return controllable mocks.
 *
 * @example
 * ```ts
 * const mock = mockSSE('/api/events')
 * const es = new EventSource('/api/events')
 * es.onmessage = (e) => console.log(e.data)
 * mock.sendEvent({ type: 'update', payload: { id: 1 } })
 * mock.close()
 * mockSSE.restore()
 * ```
 */
function mockSSE(url: string): MockSSEControls {
  mockRegistry.install()
  mockRegistry.registerUrl(url)

  return {
    sendEvent(event: SSEEventData): void {
      if (mockRegistry.isRestored()) return
      const instance = mockRegistry.getInstance(url)
      instance?._dispatchMessage(event)
      mockRegistry.sendEventToFetchStreams(url, event)
    },

    sendRaw(text: string): void {
      if (mockRegistry.isRestored()) return
      mockRegistry.sendRawToFetchStreams(url, text)
    },

    sendSSE(data: unknown): void {
      if (mockRegistry.isRestored()) return
      mockRegistry.sendRawToFetchStreams(
        url,
        `data: ${JSON.stringify(data)}\n\n`,
      )
    },

    close(): void {
      const instance = mockRegistry.getInstance(url)
      instance?._dispatchError()
      mockRegistry.closeFetchStreams(url)
    },

    getConnection(): MockEventSource | undefined {
      return mockRegistry.getInstance(url)
    },
  }
}

/**
 * Restore the original EventSource constructor and fetch, and clean up all mocks.
 * Call this in afterEach to prevent test pollution.
 */
mockSSE.restore = (): void => {
  mockRegistry.restore()
}

export { mockSSE }
export type { MockSSEControls, SSEEventData }
