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
// Re-export all types
export type {
  EventMapping,
  ParsedEvent,
  ReconnectConfig,
  SSEConfig,
  SSEProviderProps,
  SSEStatus,
  UpdateStrategy,
} from './types.ts'
