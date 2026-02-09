import { useEffect, useRef } from 'react'

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
}

/**
 * Return value from the useSSEStream hook.
 */
export interface UseSSEStreamResult<T> {
  data: T | undefined
  error: Error | undefined
}

interface StreamEntry<T> {
  source: EventSource
  data: T | undefined
  error: Error | undefined
  transform: ((data: unknown) => T) | undefined
  refCount: number
}

/**
 * Active streams keyed by URL. Provides connection reuse across renders
 * for the same URL while properly closing stale connections on URL change.
 */
const streams = new Map<string, StreamEntry<unknown>>()

function isStale(entry: StreamEntry<unknown>): boolean {
  if (entry.source.readyState === 2) {
    return true
  }
  // Detect environment resets (e.g. test framework clearing tracked instances)
  const ctor = globalThis.EventSource as { instances?: unknown[] }
  if (Array.isArray(ctor.instances) && !ctor.instances.includes(entry.source)) {
    return true
  }
  return false
}

function createStream<T>(
  url: string,
  transform: ((data: unknown) => T) | undefined,
): StreamEntry<T> {
  const source = new EventSource(url)

  const entry: StreamEntry<T> = {
    source,
    data: undefined,
    error: undefined,
    transform,
    refCount: 0,
  }

  source.onmessage = (event: MessageEvent) => {
    try {
      const parsed: unknown = JSON.parse(event.data as string)
      const currentTransform = entry.transform

      try {
        entry.data = currentTransform ? currentTransform(parsed) : (parsed as T)
      } catch (transformError) {
        entry.error = transformError instanceof Error
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

  streams.set(url, entry as StreamEntry<unknown>)
  return entry
}

function closeStream(url: string): void {
  const entry = streams.get(url)
  if (entry) {
    entry.source.close()
    streams.delete(url)
  }
}

/**
 * Subscribe to a dedicated SSE stream at the given URL.
 *
 * Creates its own EventSource connection independent of SSEProvider.
 * When the URL changes, the old connection is closed and a new one is opened.
 * The transform function uses a ref pattern so changing its reference
 * does not trigger a reconnection.
 */
export function useSSEStream<T = unknown>(
  url: string,
  options?: UseSSEStreamOptions<T>,
): UseSSEStreamResult<T> {
  // Track the URL this hook instance has incremented refCount for.
  // This ensures cleanup decrements the correct entry even if URL changes.
  const subscribedUrlRef = useRef<string | null>(null)
  const transform = options?.transform

  let entry = streams.get(url) as StreamEntry<T> | undefined

  // Evict stale entries (closed connections or test resets)
  if (entry && isStale(entry as StreamEntry<unknown>)) {
    streams.delete(url)
    entry = undefined
  }

  if (!entry) {
    entry = createStream<T>(url, transform)
  }

  // Synchronous reference counting: increment when subscribing to a new URL
  // This happens during render to avoid race conditions with effect cleanup
  if (subscribedUrlRef.current !== url) {
    // Decrement refCount for the old URL (if any) and close if no longer used
    const oldUrl = subscribedUrlRef.current
    if (oldUrl !== null) {
      const oldEntry = streams.get(oldUrl)
      if (oldEntry) {
        oldEntry.refCount--
        if (oldEntry.refCount <= 0) {
          closeStream(oldUrl)
        }
      }
    }

    // Increment refCount for the new URL
    entry.refCount++
    subscribedUrlRef.current = url
  }

  // Update transform on every render (ref pattern avoids reconnection)
  entry.transform = transform

  // Cleanup on unmount (client-side only)
  // useEffect doesn't run during SSR/renderToString, which is fine
  // because SSR doesn't need cleanup (no persistent connections)
  useEffect(() => {
    // Return cleanup function that decrements refCount for the subscribed URL
    return () => {
      const urlToCleanup = subscribedUrlRef.current
      if (urlToCleanup !== null) {
        const entryToCleanup = streams.get(urlToCleanup)
        if (entryToCleanup) {
          entryToCleanup.refCount--
          if (entryToCleanup.refCount <= 0) {
            closeStream(urlToCleanup)
          }
        }
        subscribedUrlRef.current = null
      }
    }
  }, [])

  return {
    data: entry.data,
    error: entry.error,
  }
}
