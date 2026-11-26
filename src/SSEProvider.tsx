import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from 'react'
import { useSWRConfig } from 'swr'
import { createFetchTransport } from './fetchTransport.ts'
import { calculateBackoffDelay, DEFAULT_RECONNECT } from './reconnect.ts'
import type {
  EventMapping,
  ParsedEvent,
  ReconnectConfig,
  SSEConfig,
  SSEStatus,
  SSETransport,
} from './types.ts'
import { SSEProviderError } from './types.ts'

interface SSEContextValue {
  status: SSEStatus
  subscribe: (
    eventType: string,
    handler: (payload: unknown) => void,
  ) => () => void
  config: SSEConfig
}

const SSEContext = createContext<SSEContextValue | undefined>(undefined)

/**
 * Default parser for SSE events.
 * Expects JSON format: { type: string, payload: unknown }
 */
function defaultParseEvent(event: MessageEvent): ParsedEvent {
  const data = JSON.parse(event.data)
  return {
    type: data.type,
    payload: data.payload,
  }
}

/**
 * Parser for named SSE events where the type is known from the event name.
 * Parses event.data as JSON and uses it directly as payload.
 */
function parseNamedEvent(eventType: string, event: MessageEvent): ParsedEvent {
  const payload = JSON.parse(event.data)
  return {
    type: eventType,
    payload,
  }
}

/**
 * Get a human-readable name for the update strategy (for debug logging)
 */
function getStrategyName(strategy: EventMapping['update']): string {
  if (strategy === 'set' || strategy === undefined) {
    return 'set'
  }
  if (strategy === 'refetch') {
    return 'refetch'
  }
  return 'function'
}

/**
 * Apply an update strategy to the SWR cache for a given key.
 * Handles set, refetch, and custom function strategies.
 */
function applyUpdateStrategy(
  mutate: (
    key: string,
    data?: unknown | ((current: unknown) => unknown),
    options?: { revalidate?: boolean },
  ) => Promise<unknown>,
  key: string,
  mapping: EventMapping,
  payload: unknown,
  debug?: boolean,
): void {
  const strategy = mapping.update ?? 'set'

  if (debug) {
    console.debug(
      `[reactiveSWR] Cache mutation: { key: "${key}", strategy: "${getStrategyName(strategy)}" }`,
    )
  }

  if (strategy === 'set') {
    mutate(key, payload, { revalidate: false })
  } else if (strategy === 'refetch') {
    // No data argument: SWR revalidates and keeps the cached value. Passing
    // undefined as data would write undefined to the cache first.
    mutate(key)
  } else if (typeof strategy === 'function') {
    mutate(key, (current: unknown) => strategy(current, payload), {
      revalidate: false,
    })
  }
}

/**
 * Resolve keys from an EventMapping, which can be a static string,
 * an array of strings, or a function that returns one or more keys.
 */
function resolveKeys(
  keyConfig: EventMapping['key'],
  payload: unknown,
): string[] {
  if (typeof keyConfig === 'function') {
    const result = keyConfig(payload)
    return Array.isArray(result) ? result : [result]
  }
  return Array.isArray(keyConfig) ? keyConfig : [keyConfig]
}

/**
 * Derive an EventMapping record from a schema (the frozen output of defineSchema()).
 * Each schema entry carries key, update, filter, and transform -- all of which
 * map directly onto the EventMapping shape.
 */
function deriveEventsFromSchema(
  // biome-ignore lint/suspicious/noExplicitAny: schema type is erased at this level
  schema: Record<string, any>,
): Record<string, EventMapping> {
  // biome-ignore lint/suspicious/noExplicitAny: EventMapping generics erased in Record usage
  const events: Record<string, EventMapping<any, any>> = {}
  for (const [eventName, def] of Object.entries(schema)) {
    events[eventName] = {
      key: def.key,
      update: def.update,
      filter: def.filter,
      transform: def.transform,
    }
  }
  return events
}

/**
 * Resolved config that always has a concrete `events` mapping.
 * Uses an intersection with SSEConfigWithEvents to satisfy the type system
 * after schema-to-events derivation or default fallback.
 */
type ResolvedSSEConfig = SSEConfig & { events: Record<string, EventMapping> }

/**
 * Resolve the effective events mapping from an SSEConfig.
 * When `schema` is provided it takes precedence over `events`.
 * Returns a new config object guaranteed to have an `events` property.
 */
function resolveConfig(config: SSEConfig): ResolvedSSEConfig {
  // Access schema/events via index to avoid union narrowing to `never`
  // when both are provided at runtime (bypassed via type assertion).
  // biome-ignore lint/suspicious/noExplicitAny: accessing union properties that use `never` for mutual exclusivity
  const rawConfig = config as any
  const schema: Record<string, unknown> | undefined = rawConfig.schema
  const events: Record<string, EventMapping> | undefined = rawConfig.events

  if (schema !== undefined) {
    if (events !== undefined && config.debug) {
      console.warn(
        '[reactiveSWR] Both schema and events were provided. schema takes precedence.',
      )
    }
    return {
      ...config,
      events: deriveEventsFromSchema(schema),
    } as ResolvedSSEConfig
  }
  return {
    ...config,
    // biome-ignore lint/suspicious/noExplicitAny: EventMapping generics erased
    events: (events ?? {}) as Record<string, EventMapping<any, any>>,
  } as ResolvedSSEConfig
}

export function SSEProvider({
  config,
  children,
}: {
  config: SSEConfig
  children?: ReactNode
}) {
  const { mutate } = useSWRConfig()

  const subscribersRef = useRef(
    new Map<string, Set<(payload: unknown) => void>>(),
  )

  // Resolve the effective config (schema -> events derivation, events fallback)
  const resolvedConfig = resolveConfig(config)

  // Store resolved config in ref to access latest values in handlers
  const configRef = useRef(resolvedConfig)
  configRef.current = resolvedConfig

  // Use a stable status object that is mutated in place for SSR compatibility
  // This allows tests using renderToString to observe status changes
  const statusRef = useRef<SSEStatus>({
    connected: false,
    connecting: true,
    error: null,
    reconnectAttempt: 0,
  })
  const status = statusRef.current

  // Force re-render when status changes (for client-side React updates)
  const [, forceUpdate] = useState(0)

  /**
   * Update status by mutating the stable status object and triggering re-render
   */
  const updateStatus = useCallback(
    (
      updater: Partial<SSEStatus> | ((prev: SSEStatus) => Partial<SSEStatus>),
    ) => {
      const updates =
        typeof updater === 'function' ? updater(statusRef.current) : updater
      Object.assign(statusRef.current, updates)
      forceUpdate((n) => n + 1)
    },
    [],
  )

  // EventSource/transport and listeners refs for cleanup
  const eventSourceRef = useRef<SSETransport | EventSource | null>(null)
  const listenersRef = useRef<
    Array<{ type: string; handler: (event: MessageEvent) => void }>
  >([])

  // Track the URL used for the current EventSource connection
  const currentUrlRef = useRef<string | null>(null)

  // Reconnection state tracking
  const reconnectTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const attemptCountRef = useRef<number>(0)

  // Re-entrancy guard: prevents overlapping createConnection() calls when URL
  // changes rapidly across multiple renders. Also serves as a monotonic
  // connection ID so that callbacks from stale connections are ignored.
  const connectionGenerationRef = useRef<number>(0)
  const creatingConnectionRef = useRef<boolean>(false)

  // True between an onConnect call and the onDisconnect that answers it, so
  // the consumer is told about a disconnect exactly once for each connect
  const disconnectOwedRef = useRef<boolean>(false)

  // True once this provider has tried to connect. A provider that could not
  // connect at mount (no EventSource, no transport) connects on the render
  // that supplies a transport; one that has connected before does not, so a
  // connection closed for good stays closed. See the effect after the mount effect.
  const connectionAttemptedRef = useRef<boolean>(false)

  const subscribe = useCallback(
    (eventType: string, handler: (payload: unknown) => void) => {
      const subscribers = subscribersRef.current
      if (!subscribers.has(eventType)) {
        subscribers.set(eventType, new Set())
      }

      const handlers = subscribers.get(eventType)
      if (handlers) {
        handlers.add(handler)
      }

      return () => {
        const handlers = subscribers.get(eventType)
        if (handlers) {
          handlers.delete(handler)
          if (handlers.size === 0) {
            subscribers.delete(eventType)
          }
        }
      }
    },
    [],
  )

  /**
   * Notify all subscribers for a given event type
   */
  const notifySubscribers = useCallback(
    (eventType: string, payload: unknown) => {
      const handlers = subscribersRef.current.get(eventType)
      if (handlers) {
        for (const handler of handlers) {
          handler(payload)
        }
      }
    },
    [],
  )

  /**
   * Process a parsed event by notifying subscribers and applying update strategies
   */
  const processEvent = useCallback(
    (parsed: ParsedEvent) => {
      const debug = configRef.current.debug

      // Log received event in debug mode
      if (debug) {
        console.debug(
          `[reactiveSWR] Event received: { type: "${parsed.type}", payload: ${JSON.stringify(parsed.payload)} }`,
        )
      }

      // Notify all manual subscribers first
      notifySubscribers(parsed.type, parsed.payload)

      // Look up the event mapping in config
      const mapping = configRef.current.events[parsed.type]
      if (!mapping) {
        // Log unhandled event in debug mode
        if (debug) {
          console.debug(`[reactiveSWR] Unhandled event type: "${parsed.type}"`)
        }
        return
      }

      try {
        // Apply filter (on raw payload) - skip if returns false
        if (mapping.filter && !mapping.filter(parsed.payload)) {
          return
        }

        // Apply transform (if defined) to get the processed payload
        const processedPayload = mapping.transform
          ? mapping.transform(parsed.payload)
          : parsed.payload

        // Resolve the key(s) using the processed payload
        const keys = resolveKeys(mapping.key, processedPayload)

        // Apply update strategy for each key
        for (const key of keys) {
          applyUpdateStrategy(mutate, key, mapping, processedPayload, debug)
        }
      } catch (error) {
        // Call onEventError callback if provided
        configRef.current.onEventError?.(parsed, error)
      }
    },
    [notifySubscribers, mutate],
  )

  /**
   * Get the resolved reconnection config with defaults applied
   */
  const getReconnectConfig = useCallback((): Required<ReconnectConfig> => {
    const userConfig = configRef.current.reconnect ?? {}
    return {
      enabled: userConfig.enabled ?? DEFAULT_RECONNECT.enabled,
      initialDelay: userConfig.initialDelay ?? DEFAULT_RECONNECT.initialDelay,
      maxDelay: userConfig.maxDelay ?? DEFAULT_RECONNECT.maxDelay,
      backoffMultiplier:
        userConfig.backoffMultiplier ?? DEFAULT_RECONNECT.backoffMultiplier,
      maxAttempts: userConfig.maxAttempts ?? DEFAULT_RECONNECT.maxAttempts,
    }
  }, [])

  // readyState constant for CLOSED (works for both EventSource and SSETransport)
  const CLOSED = 2

  /**
   * Determine whether the config requires a non-EventSource transport
   */
  const needsFetchTransport = useCallback((cfg: SSEConfig): boolean => {
    return !!(cfg.method || cfg.body || cfg.headers)
  }, [])

  /**
   * Whether a connection can be opened with this config: a custom or fetch
   * transport is configured, or EventSource exists
   */
  const canConnect = (cfg: SSEConfig): boolean =>
    !!(cfg.transport || needsFetchTransport(cfg)) ||
    typeof EventSource !== 'undefined'

  /**
   * Create a transport based on the current config.
   * Priority: config.transport factory > fetch transport (method/body/headers) > EventSource
   */
  const createTransport = useCallback(
    (url: string): SSETransport | EventSource => {
      const cfg = configRef.current
      if (cfg.transport) {
        return cfg.transport(url)
      }
      if (needsFetchTransport(cfg)) {
        return createFetchTransport(url, {
          method: cfg.method,
          body: cfg.body,
          headers: cfg.headers,
        })
      }
      return new EventSource(url)
    },
    [needsFetchTransport],
  )

  /**
   * Create and configure a new connection (EventSource or transport).
   *
   * Re-entrancy guard: if a createConnection() call is already in progress
   * (possible during rapid URL changes across synchronous renders), the new call
   * is skipped. The caller is responsible for clearing `creatingConnectionRef`
   * only through this function's own execution paths.
   *
   * Each call also increments a monotonic generation counter so that callbacks
   * installed by a superseded connection can detect they are stale and bail out
   * early, preventing out-of-order onConnect / onDisconnect sequences.
   */
  const createConnection = useCallback(() => {
    // Re-entrancy guard: bail out if a connection is already being created
    if (creatingConnectionRef.current) {
      return
    }
    creatingConnectionRef.current = true
    connectionAttemptedRef.current = true

    // Increment generation so closures from any previous connection know they
    // are stale. Capture the current generation for this connection's callbacks.
    connectionGenerationRef.current += 1
    const myGeneration = connectionGenerationRef.current

    // Helper: returns true when this connection is still the active one
    const isActiveConnection = () =>
      myGeneration === connectionGenerationRef.current

    // Clean up any existing connection
    if (eventSourceRef.current) {
      const oldConnection = eventSourceRef.current
      for (const { type, handler } of listenersRef.current) {
        oldConnection.removeEventListener(type, handler)
      }
      listenersRef.current = []
      oldConnection.close()
    }

    const url = configRef.current.url

    // Create the transport, catching errors from custom factories
    let connection: SSETransport | EventSource
    try {
      connection = createTransport(url)
    } catch (error) {
      // Release the guard before returning on error
      creatingConnectionRef.current = false

      const providerError = new SSEProviderError(
        error instanceof Error ? error.message : String(error),
        'TRANSPORT',
        { cause: error },
      )

      configRef.current.onEventError?.(
        { type: 'transport_error', payload: null },
        providerError,
      )
      // Install a no-op closed transport to prevent re-entry on next render
      eventSourceRef.current = {
        readyState: CLOSED,
        onmessage: null,
        onerror: null,
        onopen: null,
        close() {},
        addEventListener() {},
        removeEventListener() {},
      }
      currentUrlRef.current = url
      updateStatus({
        connected: false,
        connecting: false,
        error: providerError,
      })
      return
    }

    eventSourceRef.current = connection
    currentUrlRef.current = url

    // Release the guard now that the connection object is stored
    creatingConnectionRef.current = false

    // Handle connection open
    connection.onopen = () => {
      // Ignore callbacks from superseded connections (rapid URL changes)
      if (!isActiveConnection()) {
        return
      }

      // Clear any pending reconnect timeout
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current)
        reconnectTimeoutRef.current = null
      }

      // Reset attempt count on successful connection
      attemptCountRef.current = 0

      updateStatus({
        connected: true,
        connecting: false,
        error: null,
        reconnectAttempt: 0,
      })
      // A native EventSource fires onopen again after it recovers from
      // CONNECTING; the flag is already set then and stays set
      disconnectOwedRef.current = true
      configRef.current.onConnect?.()
    }

    // Handle connection error
    connection.onerror = (event: Event) => {
      // Ignore callbacks from superseded connections (rapid URL changes)
      if (!isActiveConnection()) {
        return
      }

      updateStatus({
        error: new SSEProviderError('SSE connection error', 'NETWORK'),
      })
      configRef.current.onError?.(event)

      // Check if connection was closed
      if (connection.readyState === CLOSED) {
        updateStatus({
          connected: false,
        })
        disconnectOwedRef.current = false
        configRef.current.onDisconnect?.()

        // Schedule reconnection
        const reconnectConfig = getReconnectConfig()

        // Check if reconnection is enabled
        if (reconnectConfig.enabled === false) {
          return
        }

        // Check if we've exceeded max attempts
        const currentAttempt = attemptCountRef.current
        if (currentAttempt + 1 >= reconnectConfig.maxAttempts) {
          return
        }

        // Calculate backoff delay
        const delay = calculateBackoffDelay(currentAttempt, reconnectConfig)

        // Schedule the reconnection
        reconnectTimeoutRef.current = setTimeout(() => {
          attemptCountRef.current += 1
          updateStatus({
            connecting: true,
            reconnectAttempt: attemptCountRef.current,
          })
          createConnection()
        }, delay)
      }
    }

    // Handle generic messages (unnamed events)
    connection.onmessage = (event: MessageEvent) => {
      // Ignore messages from superseded connections (rapid URL changes)
      if (!isActiveConnection()) {
        return
      }

      try {
        const parseEvent = configRef.current.parseEvent ?? defaultParseEvent
        const parsed = parseEvent(event)
        processEvent(parsed)
      } catch (error) {
        if (configRef.current.debug) {
          console.debug('[reactiveSWR] Failed to parse event:', error)
        }
        configRef.current.onEventError?.(
          { type: 'parse_error', payload: event.data },
          new SSEProviderError(
            error instanceof Error ? error.message : String(error),
            'PARSE',
            { cause: error },
          ),
        )
      }
    }

    // Register listeners for each named event type in config.events.
    //
    // Memoization of these handler closures (e.g. via useRef<Map<string, handler>>)
    // was evaluated and intentionally skipped for the following reasons:
    //
    // 1. These closures are NOT recreated on every render. createConnection() is a
    //    useCallback and is only called at connection time: initial mount, URL change,
    //    or reconnection after a disconnect. Between connections the same handler
    //    instances remain registered on the EventSource — no render-driven recreation.
    //
    // 2. Reusing handlers across reconnections would be unsafe. createConnection's
    //    dependencies include processEvent, which may change identity if mutate or
    //    other upstream hooks change. A memoized handler Map would silently close over
    //    a stale processEvent, producing incorrect behaviour on reconnect.
    //
    // 3. The allocation overhead is proportional to the number of event types
    //    (typically a small constant) and occurs only at connection/reconnection time,
    //    not continuously. The GC pressure is negligible in practice.
    //
    // Correctness is preserved by reading all mutable config through configRef.current
    // inside each handler; only the per-event `eventType` string is closed over by
    // value, which is the intended behaviour for parseNamedEvent dispatch.
    const eventTypes = Object.keys(configRef.current.events)
    for (const eventType of eventTypes) {
      const handler = (event: MessageEvent) => {
        // Ignore messages from superseded connections (rapid URL changes)
        if (!isActiveConnection()) {
          return
        }

        try {
          let parsed: ParsedEvent
          if (configRef.current.parseEvent) {
            // Use custom parser if provided
            parsed = configRef.current.parseEvent(event)
          } else {
            // Default: parse data as JSON for payload, use eventType as type
            parsed = parseNamedEvent(eventType, event)
          }
          processEvent(parsed)
        } catch (error) {
          if (configRef.current.debug) {
            console.debug('[reactiveSWR] Failed to parse event:', error)
          }
          configRef.current.onEventError?.(
            { type: 'parse_error', payload: event.data },
            new SSEProviderError(
              error instanceof Error ? error.message : String(error),
              'PARSE',
              { cause: error },
            ),
          )
        }
      }

      connection.addEventListener(eventType, handler)
      listenersRef.current.push({ type: eventType, handler })
    }
  }, [createTransport, getReconnectConfig, processEvent, updateStatus])

  // Open the connection after mount and close it on unmount. Setup and
  // cleanup are symmetric, so React StrictMode's extra cleanup/setup cycle
  // ends with one open connection. Nothing opens during server rendering,
  // because effects do not run there.
  //
  // The empty dependency list is deliberate: the connection lives as long as
  // the provider. URL changes are handled by the effect below, and handlers
  // read the latest config through configRef.
  // biome-ignore lint/correctness/useExhaustiveDependencies: open once per mount; see above
  useEffect(() => {
    if (canConnect(configRef.current)) {
      createConnection()
    }

    // Registered even when nothing opened, because a transport supplied on a
    // later render connects through the effect below and must close here
    return () => {
      // Make callbacks from the connection being closed stale, so a late
      // onerror cannot schedule a reconnect after unmount
      connectionGenerationRef.current += 1

      // Clear any pending reconnect timeout
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current)
        reconnectTimeoutRef.current = null
      }

      // Read the current connection, not the one from mount: a reconnect or
      // URL change may have replaced it since
      const connection = eventSourceRef.current
      if (connection) {
        // Remove all named event listeners
        for (const { type, handler } of listenersRef.current) {
          connection.removeEventListener(type, handler)
        }
        listenersRef.current = []

        // Close the connection
        connection.close()
        eventSourceRef.current = null
        currentUrlRef.current = null
      }

      // onDisconnect answers onConnect: call it if onConnect was called and
      // onerror has not already reported the disconnect. This covers an open
      // connection that errored back into CONNECTING (onerror reports only
      // CLOSED), and skips one that never opened, such as the one StrictMode's
      // extra cleanup closes right after mount.
      if (disconnectOwedRef.current) {
        disconnectOwedRef.current = false
        configRef.current.onDisconnect?.()
      }
    }
  }, [])

  // Connect on a later render if the provider could not connect at mount
  // (no EventSource and no transport) and a render has since supplied a
  // custom or fetch transport.
  //
  // What separates this from a connection closed on purpose: a provider that
  // has connected before (connectionAttemptedRef) never connects here. When
  // reconnect attempts run out or reconnect.enabled is false, the closed
  // connection stays in eventSourceRef and connectionAttemptedRef is true, so
  // a rerender leaves it closed. After unmount cleanup the mount effect, not
  // this one, reopens (StrictMode).
  const canConnectNow = canConnect(resolvedConfig)
  useEffect(() => {
    if (
      canConnectNow &&
      eventSourceRef.current === null &&
      !connectionAttemptedRef.current
    ) {
      createConnection()
    }
  }, [canConnectNow, createConnection])

  // On a URL change, replace the connection with one for the new URL
  useEffect(() => {
    if (
      currentUrlRef.current !== null &&
      currentUrlRef.current !== resolvedConfig.url
    ) {
      createConnection()
    }
  }, [resolvedConfig.url, createConnection])

  // Reconnect when the tab becomes visible and the connection was lost.
  // Attached in an effect so StrictMode's cleanup/setup cycle re-attaches it.
  useEffect(() => {
    if (typeof document === 'undefined') {
      return
    }

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        const connection = eventSourceRef.current
        const reconnectConfig = getReconnectConfig()

        // Check if reconnection is enabled
        if (!reconnectConfig.enabled) {
          return
        }

        // Check if we've exceeded max attempts (use +1 since we will increment before creating connection)
        if (attemptCountRef.current + 1 >= reconnectConfig.maxAttempts) {
          return
        }

        // Check if connection is lost (closed or no connection)
        const isConnectionLost = !connection || connection.readyState === CLOSED

        if (isConnectionLost) {
          // Cancel any pending reconnect timer to avoid duplicate connections
          if (reconnectTimeoutRef.current) {
            clearTimeout(reconnectTimeoutRef.current)
            reconnectTimeoutRef.current = null
          }

          // Trigger immediate reconnection
          attemptCountRef.current += 1
          updateStatus({
            connecting: true,
            reconnectAttempt: attemptCountRef.current,
          })
          createConnection()
        }
      }
    }

    // Remove the listener from the document it was added to
    const doc = document
    doc.addEventListener('visibilitychange', handleVisibilityChange)
    return () => {
      doc.removeEventListener('visibilitychange', handleVisibilityChange)
    }
  }, [createConnection, getReconnectConfig, updateStatus])

  const contextValue: SSEContextValue = {
    status,
    subscribe,
    config: resolvedConfig,
  }

  return (
    <SSEContext.Provider value={contextValue}>{children}</SSEContext.Provider>
  )
}

export function useSSEContext(): SSEContextValue {
  const context = useContext(SSEContext)

  if (context === undefined) {
    throw new Error('useSSEContext must be used within an SSEProvider')
  }

  return context
}
