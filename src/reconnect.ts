import type { ReconnectConfig } from './types.ts'

/**
 * Default reconnection configuration values
 */
export const DEFAULT_RECONNECT: Required<ReconnectConfig> = {
  enabled: true,
  initialDelay: 1000,
  maxDelay: 30000,
  backoffMultiplier: 2,
  maxAttempts: Number.POSITIVE_INFINITY,
}

/**
 * Calculate the delay for the next reconnection attempt using exponential backoff.
 * Formula: min(initialDelay * (backoffMultiplier ^ attemptNumber), maxDelay)
 */
export function calculateBackoffDelay(
  attemptNumber: number,
  config: Required<ReconnectConfig>,
): number {
  const delay = config.initialDelay * config.backoffMultiplier ** attemptNumber
  return Math.min(delay, config.maxDelay)
}
