import { useEffect, useRef } from 'react'
import { createFetchTransport } from '../fetchTransport.ts'
import type { SSETransport } from '../types.ts'

/**
 * Options for the useSSEStream hook.
 */
export interface UseSSEStreamOptions<T> {
  /**
   * Transform incoming data before storing.
   * Uses a ref pattern internally so changing the transform
   * function reference does NOT cause a reconnection.
   */
  transform?: (data: unknown) => T
  /** HTTP method for the request. When body is provided without method, defaults to POST. */
  method?: string
  /** Request body. Triggers use of fetch-based transport instead of EventSource. */
  body?: BodyInit | Record<string, unknown>
  /** Additional request headers. Triggers use of fetch-based transport instead of EventSource. */
  headers?: Record<string, string>
  /** Custom transport factory. Takes precedence over method/body/headers. */
  transport?: (url: string) => SSETransport
}

/**
 * Return value from the useSSEStream hook.
 */
export interface UseSSEStreamResult<T> {
  data: T | undefined
  error: Error | undefined
}

interface StreamEntry<T> {
  source: SSETransport | EventSource
  data: T | undefined
  error: Error | undefined
  transform: ((data: unknown) => T) | undefined
  refCount: number
  /** Snapshot of mock instances array at creation time for staleness detection */
  _instancesRef: unknown[] | undefined
}

/**
 * Active streams keyed by composite key. Provides connection reuse across renders
 * for the same URL+options while properly closing stale connections on change.
 */
const streams = new Map<string, StreamEntry<unknown>>()

function isNonSerializable(body: unknown): boolean {
  if (body instanceof Blob) return true
  if (typeof ReadableStream !== 'undefined' && body instanceof ReadableStream)
    return true
  if (typeof ArrayBuffer !== 'undefined' && body instanceof ArrayBuffer)
    return true
  if (typeof FormData !== 'undefined' && body instanceof FormData) return true
  return false
}

let nonSerializableCounter = 0

// Assign stable IDs to transport factory functions so that the same factory
// reference produces the same connection key (enabling reuse across re-renders)
// while different factory references produce different keys (preventing
// unrelated components from sharing connections).
// biome-ignore lint/complexity/noBannedTypes: WeakMap requires object key type
const transportFactoryIds = new WeakMap<Function, number>()
let transportFactoryCounter = 0

// biome-ignore lint/complexity/noBannedTypes: accepts any function reference for stable ID assignment
function getTransportFactoryId(factory: Function): number {
  let id = transportFactoryIds.get(factory)
  if (id === undefined) {
    id = ++transportFactoryCounter
    transportFactoryIds.set(factory, id)
  }
  return id
}

function computeConnectionKey<T>(
  url: string,
  options?: UseSSEStreamOptions<T>,
  nonSerializableKeyRef?: { current: string | null },
): string {
  if (!options) return url

  // Custom transport factory -> keyed by factory identity so different
  // factories produce different keys while the same factory reuses its key
  if (options.transport) {
    return `${url}::transport:${getTransportFactoryId(options.transport)}`
  }

  const { method, body, headers } = options

  // No transport-related options -> key is just the URL
  if (method === undefined && body === undefined && headers === undefined)
    return url

  // Non-serializable bodies -> use stable per-instance key from ref
  if (body !== undefined && isNonSerializable(body)) {
    return (
      nonSerializableKeyRef?.current ?? `${url}::ns:${++nonSerializableCounter}`
    )
  }

  const parts = [url]
  if (method !== undefined) parts.push(`method:${method}`)
  if (body !== undefined) parts.push(`body:${JSON.stringify(body)}`)
  if (headers !== undefined) {
    const sortedHeaders = Object.fromEntries(
      Object.entries(headers).sort(([a], [b]) => a.localeCompare(b)),
    )
    parts.push(`headers:${JSON.stringify(sortedHeaders)}`)
  }
  return parts.join('::')
}

function getMockInstances(): unknown[] | undefined {
  const ctor = globalThis.EventSource as { instances?: unknown[] }
  return Array.isArray(ctor.instances) ? ctor.instances : undefined
}

function isStale(entry: StreamEntry<unknown>): boolean {
  if (entry.source.readyState === 2) {
    return true
  }
  // Detect environment resets (e.g. test framework clearing tracked instances)
  const currentInstances = getMockInstances()
  if (currentInstances !== undefined) {
    if (entry.source instanceof EventSource) {
      // EventSource entry: stale if not in the current instances list
      if (!currentInstances.includes(entry.source)) {
        return true
      }
    } else if (
      entry._instancesRef !== undefined &&
      entry._instancesRef !== currentInstances
    ) {
      // Non-EventSource entry: stale if the mock instances array was replaced
      // (indicates test framework reset between test cases)
      return true
    }
  }
  return false
}

function attachHandlers<T>(
  source: SSETransport | EventSource,
  entry: StreamEntry<T>,
): void {
  source.onmessage = (event: MessageEvent) => {
    try {
      const parsed: unknown = JSON.parse(event.data as string)
      const currentTransform = entry.transform

      try {
        entry.data = currentTransform ? currentTransform(parsed) : (parsed as T)
      } catch (transformError) {
        entry.error =
          transformError instanceof Error
            ? transformError
            : new Error('Transform function error')
      }
    } catch {
      entry.error = new Error('Failed to parse SSE message as JSON')
    }
  }

  source.onerror = () => {
    entry.error = new Error('SSE connection error')
  }
}

function createStream<T>(
  url: string,
  key: string,
  transform: ((data: unknown) => T) | undefined,
  options?: UseSSEStreamOptions<T>,
): StreamEntry<T> {
  const entry: StreamEntry<T> = {
    source: null as unknown as SSETransport | EventSource,
    data: undefined,
    error: undefined,
    transform,
    refCount: 0,
    _instancesRef: getMockInstances(),
  }

  // Transport selection:
  // 1. Custom transport factory takes precedence
  // 2. method/body/headers -> createFetchTransport
  // 3. Default -> EventSource
  if (options?.transport) {
    try {
      const source = options.transport(url)
      entry.source = source
      attachHandlers(source, entry)
    } catch (err) {
      // Create a minimal no-op source for the entry
      entry.source = {
        readyState: 2,
        onmessage: null,
        onerror: null,
        onopen: null,
        close() {},
        addEventListener() {},
        removeEventListener() {},
      }
      entry.error = err instanceof Error ? err : new Error(String(err))
    }
  } else if (
    options?.method !== undefined ||
    options?.body !== undefined ||
    options?.headers !== undefined
  ) {
    const source = createFetchTransport(url, {
      method: options.method,
      body: options.body,
      headers: options.headers,
    })
    entry.source = source
    attachHandlers(source, entry)
  } else {
    const source = new EventSource(url)
    entry.source = source
    attachHandlers(source, entry)
  }

  streams.set(key, entry as StreamEntry<unknown>)
  return entry
}

function closeStream(key: string): void {
  const entry = streams.get(key)
  if (entry) {
    entry.source.close()
    streams.delete(key)
  }
}

/**
 * Subscribe to a dedicated SSE stream at the given URL.
 *
 * Creates its own EventSource connection independent of SSEProvider.
 * When the URL changes, the old connection is closed and a new one is opened.
 * The transform function uses a ref pattern so changing its reference
 * does not trigger a reconnection.
 *
 * Supports custom transports via the `transport`, `method`, `body`, and
 * `headers` options.
 */
export function useSSEStream<T = unknown>(
  url: string,
  options?: UseSSEStreamOptions<T>,
): UseSSEStreamResult<T> {
  // Track the key this hook instance has incremented refCount for.
  // This ensures cleanup decrements the correct entry even if URL changes.
  const subscribedKeyRef = useRef<string | null>(null)
  // Stable key for non-serializable bodies — generated once per mount so
  // Strict Mode double-renders and concurrent discarded renders don't leak.
  const nonSerializableKeyRef = useRef<string | null>(null)
  const transform = options?.transform

  const key = computeConnectionKey(url, options, nonSerializableKeyRef)
  // Store back so subsequent renders of this instance reuse the same key
  if (nonSerializableKeyRef.current === null && key.includes('::ns:')) {
    nonSerializableKeyRef.current = key
  }

  let entry = streams.get(key) as StreamEntry<T> | undefined

  // Evict stale entries (closed connections or test resets)
  if (entry && isStale(entry as StreamEntry<unknown>)) {
    streams.delete(key)
    entry = undefined
  }

  if (!entry) {
    entry = createStream<T>(url, key, transform, options)
  }

  // Update transform on every render (ref pattern avoids reconnection)
  entry.transform = transform

  // Reference counting in useEffect so mutations only happen on commit,
  // not during speculative renders that React concurrent mode may discard.
  useEffect(() => {
    // Increment refCount for the committed key
    const committedEntry = streams.get(key)
    if (committedEntry) {
      committedEntry.refCount++
    }
    subscribedKeyRef.current = key

    // Cleanup: decrement refCount on unmount or key change
    return () => {
      const keyToCleanup = subscribedKeyRef.current
      if (keyToCleanup !== null) {
        const entryToCleanup = streams.get(keyToCleanup)
        if (entryToCleanup) {
          entryToCleanup.refCount--
          if (entryToCleanup.refCount <= 0) {
            closeStream(keyToCleanup)
          }
        }
        subscribedKeyRef.current = null
      }
    }
  }, [key])

  return {
    data: entry.data,
    error: entry.error,
  }
}
