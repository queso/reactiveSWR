/**
 * Testing utilities for reactiveSWR.
 *
 * Provides mockSSE to intercept and simulate EventSource connections
 * in test environments without real SSE servers.
 */

interface SSEEventData {
  type: string
  payload: unknown
}

interface MockSSEControls {
  sendEvent: (event: SSEEventData) => void
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

/**
 * Registry that tracks URL-to-instance mappings and manages
 * the global EventSource override lifecycle.
 */
class MockRegistry {
  private instances: Map<string, MockEventSource> = new Map()
  private originalEventSource: typeof EventSource | undefined = undefined
  private installed = false
  private restored = false

  install(): void {
    if (this.installed) return

    this.originalEventSource = globalThis.EventSource
    // biome-ignore lint/suspicious/noExplicitAny: MockEventSource satisfies EventSource shape for testing
    globalThis.EventSource = MockEventSource as any
    this.installed = true
    this.restored = false
  }

  restore(): void {
    if (!this.installed) return

    if (this.originalEventSource) {
      globalThis.EventSource = this.originalEventSource
    }

    for (const instance of this.instances.values()) {
      instance.close()
    }

    this.instances.clear()
    this.installed = false
    this.restored = true
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
}

const mockRegistry = new MockRegistry()

/**
 * Create a mock SSE connection for the given URL.
 *
 * Intercepts the global EventSource constructor so that
 * `new EventSource(url)` returns a controllable mock instance.
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

  return {
    sendEvent(event: SSEEventData): void {
      if (mockRegistry.isRestored()) return
      const instance = mockRegistry.getInstance(url)
      instance?._dispatchMessage(event)
    },

    close(): void {
      const instance = mockRegistry.getInstance(url)
      instance?._dispatchError()
    },

    getConnection(): MockEventSource | undefined {
      return mockRegistry.getInstance(url)
    },
  }
}

/**
 * Restore the original EventSource constructor and clean up all mocks.
 * Call this in afterEach to prevent test pollution.
 */
mockSSE.restore = (): void => {
  mockRegistry.restore()
}

export { mockSSE }
export type { MockSSEControls, SSEEventData }
