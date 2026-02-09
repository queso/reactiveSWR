import { useSSEContext } from '../SSEProvider.tsx'
import type { SSEStatus } from '../types.ts'

/**
 * Hook to access SSE connection status.
 *
 * Must be used within an SSEProvider.
 *
 * @returns SSEStatus object with connection state
 * @throws Error if used outside SSEProvider
 */
export function useSSEStatus(): SSEStatus {
  const context = useSSEContext()
  return context.status
}
