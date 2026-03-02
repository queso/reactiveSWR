// reactiveSWR - Meteor-style reactivity for React using SWR and SSE

// Re-export hooks
export { useSSEEvent } from './hooks/useSSEEvent.ts'
export { useSSEStatus } from './hooks/useSSEStatus.ts'
export type {
  UseSSEStreamOptions,
  UseSSEStreamResult,
} from './hooks/useSSEStream.ts'
export { useSSEStream } from './hooks/useSSEStream.ts'
// Re-export components
export { SSEProvider, useSSEContext } from './SSEProvider.tsx'
// Re-export schema builder
export { defineSchema } from './schema.ts'
// Re-export SSE parser for custom transport builders
export { createSSEParser } from './sseParser.ts'
// Re-export all types
export type {
  EventMapping,
  ParsedEvent,
  ReconnectConfig,
  SchemaDefinition,
  SchemaEventDefinition,
  SchemaResult,
  SSEConfig,
  SSEErrorCode,
  SSEProviderProps,
  SSERequestOptions,
  SSEStatus,
  SSETransport,
  UpdateStrategy,
} from './types.ts'
// Re-export structured error class (value export, not type-only)
export { SSEProviderError } from './types.ts'
