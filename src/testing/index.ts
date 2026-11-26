/**
 * Testing utilities for reactiveSWR.
 *
 * Provides mockSSE to intercept and simulate EventSource and fetch-based
 * SSE connections in test environments without real SSE servers.
 */
import { formatSSEData, formatSSEEvent } from '../sseParser'

interface SSEEventData {
  type: string
  payload: unknown
}

/**
 * How `sendEvent` frames an event on the wire.
 *
 * - `'named'` (default): `event: <type>\ndata: <payload>`, the frame
 *   `createChannel` writes. A real EventSource delivers it to
 *   `addEventListener(type)` listeners only, never to `onmessage`.
 * - `'unnamed'`: `data: {"type":...,"payload":...}` with no event field, for
 *   servers that send that form. Delivered to `onmessage` and `message`
 *   listeners only, and parsed by SSEProvider's default `parseEvent`.
 */
type MockEventFormat = 'named' | 'unnamed'

interface MockSSEOptions {
  eventFormat?: MockEventFormat
}

interface MockSSEControls {
  sendEvent: (event: SSEEventData) => Promise<void>
  sendRaw: (text: string) => Promise<void>
  sendSSE: (data: unknown) => Promise<void>
  setLatency: (ms: number) => void
  resetLatency: () => void
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

  /**
   * Internal: deliver an event the way a real EventSource delivers one frame.
   *
   * A `named` event goes to `addEventListener(type)` listeners with the
   * payload as its data. An `unnamed` event goes to `onmessage` and
   * `message` listeners with `{type, payload}` as its data. Each frame is
   * delivered once, in one of those forms, never both.
   */
  _dispatchMessage(
    data: SSEEventData,
    format: MockEventFormat = 'named',
  ): void {
    if (this.disposed) return

    const eventType = format === 'named' ? data.type : 'message'
    const event = new MessageEvent(eventType, {
      data:
        format === 'named'
          ? JSON.stringify(data.payload)
          : JSON.stringify({ type: data.type, payload: data.payload }),
      origin: '',
      lastEventId: '',
    })

    // `event: message` is the same as no event field: onmessage sees it too
    if (eventType === 'message' && this.onmessage) {
      this.onmessage(event)
    }

    this.dispatchEvent(event)
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

  sendEventToFetchStreams(
    url: string,
    event: SSEEventData,
    format: MockEventFormat = 'named',
  ): void {
    const entries = this.fetchStreams.get(url)
    if (!entries) return

    const encoder = new TextEncoder()
    const sseText =
      format === 'named'
        ? formatSSEEvent(event.type, event.payload)
        : formatSSEData({ type: event.type, payload: event.payload })
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
function mockSSE(url: string, options: MockSSEOptions = {}): MockSSEControls {
  mockRegistry.install()
  mockRegistry.registerUrl(url)

  const format = options.eventFormat ?? 'named'
  let latencyMs = 0

  function dispatchEvent(event: SSEEventData): void {
    if (mockRegistry.isRestored()) return
    const instance = mockRegistry.getInstance(url)
    instance?._dispatchMessage(event, format)
    mockRegistry.sendEventToFetchStreams(url, event, format)
  }

  function dispatchRaw(text: string): void {
    if (mockRegistry.isRestored()) return
    mockRegistry.sendRawToFetchStreams(url, text)
  }

  return {
    sendEvent(event: SSEEventData): Promise<void> {
      if (mockRegistry.isRestored()) return Promise.resolve()
      if (latencyMs <= 0) {
        dispatchEvent(event)
        return Promise.resolve()
      }
      return new Promise((resolve) =>
        setTimeout(() => {
          dispatchEvent(event)
          resolve()
        }, latencyMs),
      )
    },

    sendRaw(text: string): Promise<void> {
      if (mockRegistry.isRestored()) return Promise.resolve()
      if (latencyMs <= 0) {
        dispatchRaw(text)
        return Promise.resolve()
      }
      return new Promise((resolve) =>
        setTimeout(() => {
          dispatchRaw(text)
          resolve()
        }, latencyMs),
      )
    },

    sendSSE(data: unknown): Promise<void> {
      if (mockRegistry.isRestored()) return Promise.resolve()
      const text = formatSSEData(data)
      if (latencyMs <= 0) {
        dispatchRaw(text)
        return Promise.resolve()
      }
      return new Promise((resolve) =>
        setTimeout(() => {
          dispatchRaw(text)
          resolve()
        }, latencyMs),
      )
    },

    setLatency(ms: number): void {
      latencyMs = ms
    },

    resetLatency(): void {
      latencyMs = 0
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
export type { MockEventFormat, MockSSEControls, MockSSEOptions, SSEEventData }
