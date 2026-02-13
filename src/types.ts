import type { ReactNode } from 'react'

/**
 * Parsed SSE event with type and payload
 */
export interface ParsedEvent {
  type: string
  payload: unknown
}

/**
 * Reconnection configuration for SSE connection
 */
export interface ReconnectConfig {
  enabled?: boolean
  initialDelay?: number
  maxDelay?: number
  backoffMultiplier?: number
  maxAttempts?: number
}

/**
 * SSE connection status
 */
export interface SSEStatus {
  connected: boolean
  connecting: boolean
  error: Error | null
  reconnectAttempt: number
}

/**
 * Update strategy for handling SSE events
 * - 'set': Replace current data with payload
 * - 'refetch': Trigger SWR refetch
 * - Function: Custom merge logic
 */
export type UpdateStrategy<TPayload, TData> =
  | 'set'
  | 'refetch'
  | ((current: TData | undefined, payload: TPayload) => TData)

/**
 * Mapping configuration for a specific event type
 */
// biome-ignore lint/suspicious/noExplicitAny: generic defaults require any for type erasure in Record usage
export interface EventMapping<TPayload = any, TData = any> {
  key: string | string[] | ((payload: TPayload) => string | string[])
  update?: UpdateStrategy<TPayload, TData>
  filter?: (payload: TPayload) => boolean
  transform?: (payload: TPayload) => TPayload
}

/**
 * Transport interface for SSE connections.
 * Provides an abstraction over the native EventSource API to support
 * custom transports (e.g., fetch-based SSE for POST requests).
 */
export interface SSETransport {
  onmessage: ((event: MessageEvent) => void) | null
  onerror: ((event: Event) => void) | null
  onopen: ((event: Event) => void) | null
  close: () => void
  readyState: number
  /**
   * Add a listener for a named SSE data event.
   * This is ONLY for named SSE data events (e.g., "user.updated"),
   * not for generic DOM events like "open" or "error".
   */
  addEventListener: (
    type: string,
    listener: (event: MessageEvent) => void,
  ) => void
  /**
   * Remove a listener for a named SSE data event.
   * This is ONLY for named SSE data events (e.g., "user.updated"),
   * not for generic DOM events like "open" or "error".
   */
  removeEventListener: (
    type: string,
    listener: (event: MessageEvent) => void,
  ) => void
}

/**
 * Request options for SSE connections that require custom HTTP methods,
 * request bodies, or additional headers.
 */
export interface SSERequestOptions {
  method?: string
  body?: BodyInit | Record<string, unknown>
  headers?: Record<string, string>
}

/**
 * Configuration for SSE connection and event handling
 */
export interface SSEConfig {
  url: string
  // biome-ignore lint/suspicious/noExplicitAny: EventMapping generics are erased in config-level Record
  events: Record<string, EventMapping<any, any>>
  parseEvent?: (event: MessageEvent) => ParsedEvent
  onConnect?: () => void
  onError?: (error: Event) => void
  onDisconnect?: () => void
  reconnect?: ReconnectConfig
  debug?: boolean
  onEventError?: (event: ParsedEvent, error: unknown) => void
  method?: string
  body?: BodyInit | Record<string, unknown>
  headers?: Record<string, string>
  transport?: (url: string) => SSETransport
}

/**
 * Props for SSEProvider component
 */
export interface SSEProviderProps {
  config: SSEConfig
  children?: ReactNode
}
