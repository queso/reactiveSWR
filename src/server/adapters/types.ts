/**
 * Interface that all SSE adapters must implement.
 * Provides a standard contract for database/event source adapters
 * with start/stop lifecycle methods.
 */
export interface SSEAdapter {
  /**
   * Start the adapter and begin emitting events.
   * @param emit - Callback to emit events to connected SSE clients
   */
  start(
    emit: (eventType: string, payload: unknown) => void,
  ): void | Promise<void>

  /**
   * Stop the adapter and clean up resources.
   */
  stop(): void | Promise<void>
}

/**
 * Extracts only the keys of S whose value is not `never`.
 * This filters out utility/config keys (like `resources`) that SchemaResult maps to `never`.
 */
type EventKeysOf<S> = {
  [K in keyof S]: S[K] extends never ? never : K
}[keyof S]

/**
 * Maps source event names (adapter-specific strings) to schema event type keys.
 * Constrained so TypeScript verifies that mapped event types exist in the schema,
 * excluding any keys resolved to `never` (e.g. internal config keys like `resources`).
 *
 * @typeParam S - A SchemaResult type (returned by defineSchema())
 */
// biome-ignore lint/suspicious/noExplicitAny: SchemaResult generic requires any for broad compatibility
export type AdapterMapping<S extends Record<string, any>> = {
  [sourceEvent: string]: EventKeysOf<S>
}
