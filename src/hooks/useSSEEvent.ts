import { useEffect, useRef } from 'react'
import { useSSEContext } from '../SSEProvider.tsx'

/**
 * Hook to subscribe to raw SSE events of a specific type.
 *
 * Allows components to react to SSE events outside the declarative config.
 * Multiple components can subscribe to the same event type and each will
 * receive the event independently.
 *
 * Uses the "latest ref" pattern to ensure the handler always has access
 * to current props/state without causing resubscription.
 *
 * @param eventType - The SSE event type to subscribe to
 * @param handler - Callback invoked when a matching event is received
 *
 * @throws Error if used outside SSEProvider (via useSSEContext)
 *
 * @example
 * ```tsx
 * function OrderNotifications() {
 *   const [orders, setOrders] = useState<Order[]>([])
 *
 *   useSSEEvent<Order>('order.created', (order) => {
 *     setOrders(prev => [...prev, order])
 *   })
 *
 *   return <OrderList orders={orders} />
 * }
 * ```
 */
export function useSSEEvent<T = unknown>(
  eventType: string,
  handler: (payload: T) => void,
): void {
  const context = useSSEContext()
  const handlerRef = useRef(handler)
  const unsubscribeRef = useRef<(() => void) | null>(null)
  const prevEventTypeRef = useRef<string | null>(null)

  // Always keep handler ref current to avoid stale closures
  handlerRef.current = handler

  // Subscribe synchronously during render for SSR compatibility
  // Only resubscribe if eventType changes
  if (prevEventTypeRef.current !== eventType) {
    // Unsubscribe from previous event type if any
    if (unsubscribeRef.current) {
      unsubscribeRef.current()
    }

    // Subscribe to new event type
    unsubscribeRef.current = context.subscribe(eventType, (payload) => {
      handlerRef.current(payload as T)
    })
    prevEventTypeRef.current = eventType
  }

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (unsubscribeRef.current) {
        unsubscribeRef.current()
        unsubscribeRef.current = null
        // Reset prevEventTypeRef so resubscription occurs on remount (React Strict Mode)
        prevEventTypeRef.current = null
      }
    }
  }, [])
}
