import { createSSEParser } from './sseParser.ts'
import type { SSETransport } from './types.ts'

export interface FetchTransportOptions {
  method?: string
  body?: BodyInit | Record<string, unknown>
  headers?: Record<string, string>
}

interface FetchTransport extends SSETransport {
  readonly lastEventId: string
  onretry: ((ms: number) => void) | null
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    Object.getPrototypeOf(value) === Object.prototype
  )
}

export function createFetchTransport(
  url: string,
  options?: FetchTransportOptions,
): FetchTransport {
  const CONNECTING = 0
  const OPEN = 1
  const CLOSED = 2

  let readyState = CONNECTING
  let lastEventId = ''
  const listeners = new Map<string, Set<(event: MessageEvent) => void>>()
  const abortController = new AbortController()

  const transport: FetchTransport = {
    onmessage: null,
    onerror: null,
    onopen: null,
    onretry: null,

    get readyState() {
      return readyState
    },

    get lastEventId() {
      return lastEventId
    },

    close() {
      if (readyState === CLOSED) return
      readyState = CLOSED
      abortController.abort()
    },

    addEventListener(type: string, listener: (event: MessageEvent) => void) {
      let set = listeners.get(type)
      if (!set) {
        set = new Set()
        listeners.set(type, set)
      }
      set.add(listener)
    },

    removeEventListener(type: string, listener: (event: MessageEvent) => void) {
      const set = listeners.get(type)
      if (set) {
        set.delete(listener)
      }
    },
  }

  const parser = createSSEParser({
    onEvent(event) {
      if (readyState === CLOSED) return

      if (event.id !== undefined) {
        lastEventId = event.id
      }

      const messageEvent = new MessageEvent(event.event, {
        data: event.data,
        lastEventId: event.id,
      })

      if (event.event === 'message') {
        transport.onmessage?.(messageEvent)
      } else {
        const set = listeners.get(event.event)
        if (set) {
          for (const listener of set) {
            listener(messageEvent)
          }
        }
      }
    },
    onRetry(ms) {
      transport.onretry?.(ms)
    },
  })

  // Build fetch init
  const headers: Record<string, string> = { ...options?.headers }
  let body: BodyInit | undefined
  let method = options?.method

  if (options?.body !== undefined) {
    if (isPlainObject(options.body)) {
      body = JSON.stringify(options.body)
      if (!headers['Content-Type'] && !headers['content-type']) {
        headers['Content-Type'] = 'application/json'
      }
    } else {
      body = options.body as BodyInit
    }
    if (!method) {
      method = 'POST'
    }
  }

  const fetchInit: RequestInit = {
    method,
    headers,
    body,
    signal: abortController.signal,
  }

  // Start fetch asynchronously so callers can attach handlers
  Promise.resolve().then(async () => {
    if (readyState === CLOSED) return

    let response: Response
    try {
      response = await fetch(url, fetchInit)
    } catch {
      if (readyState !== CLOSED) {
        readyState = CLOSED
        transport.onerror?.(new Event('error'))
      }
      return
    }

    if (readyState === CLOSED) return

    if (!response.ok) {
      readyState = CLOSED
      transport.onerror?.(new Event('error'))
      return
    }

    readyState = OPEN
    transport.onopen?.(new Event('open'))

    if (!response.body) {
      readyState = CLOSED
      transport.onerror?.(new Event('error'))
      return
    }

    const reader = response.body.getReader()
    const decoder = new TextDecoder()

    const readNext = () => {
      if (readyState === CLOSED) return
      reader
        .read()
        .then(({ done, value }) => {
          if (done) {
            if (readyState !== CLOSED) {
              readyState = CLOSED
              transport.onerror?.(new Event('error'))
            }
            return
          }
          if (readyState === CLOSED) return
          const text = decoder.decode(value, { stream: true })
          parser.feed(text)
          // Schedule next read as a macrotask so external code can interleave
          setTimeout(readNext, 0)
        })
        .catch((err: unknown) => {
          if (err instanceof DOMException && err.name === 'AbortError') return
          if (readyState !== CLOSED) {
            readyState = CLOSED
            transport.onerror?.(new Event('error'))
          }
        })
    }

    readNext()
  })

  return transport
}
