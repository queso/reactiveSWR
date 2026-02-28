import type { SSEAdapter } from './types.ts'

interface PrismaMiddlewareParams {
  model?: string
  action: string
  args: unknown
  dataPath: string[]
  runInTransaction: boolean
}

type PrismaMiddlewareFn = (
  params: PrismaMiddlewareParams,
  next: (params: PrismaMiddlewareParams) => Promise<unknown>,
) => Promise<unknown>

interface PrismaClient {
  $use(middleware: PrismaMiddlewareFn): void
}

type PrismaAdapterMapping = {
  [modelName: string]: {
    created?: string
    updated?: string
    deleted?: string
  }
}

const ACTION_TO_OP: Record<string, 'created' | 'updated' | 'deleted'> = {
  create: 'created',
  createMany: 'created',
  update: 'updated',
  updateMany: 'updated',
  delete: 'deleted',
  deleteMany: 'deleted',
}

/**
 * Create a Prisma middleware adapter that intercepts create/update/delete operations
 * and emits SSE events after each operation completes.
 *
 * Does NOT import @prisma/client — accepts the client instance as a parameter.
 */
export function createPrismaAdapter(
  prisma: PrismaClient,
  mapping: PrismaAdapterMapping,
): SSEAdapter {
  let active = false
  let started = false
  let emitFn: ((eventType: string, payload: unknown) => void) | undefined

  return {
    start(emit: (eventType: string, payload: unknown) => void): void {
      if (started) return

      emitFn = emit
      active = true
      started = true

      try {
        prisma.$use(async (params, next) => {
          const result = await next(params)

          if (active && emitFn && params.model) {
            const modelMapping = mapping[params.model]
            if (modelMapping) {
              const op = ACTION_TO_OP[params.action]
              if (op) {
                const eventType = modelMapping[op]
                if (eventType) {
                  try {
                    emitFn(eventType, result)
                  } catch {
                    // emit() errors must not propagate to the Prisma caller
                  }
                }
              }
            }
          }

          return result
        })
      } catch (err) {
        // If $use() throws, reset state so callers know the adapter failed to start
        active = false
        started = false
        emitFn = undefined
        throw err
      }
    },

    stop(): void {
      active = false
      emitFn = undefined
      // Note: `started` is intentionally NOT reset. Prisma's $use() permanently
      // registers middleware — there is no $removeUse(). Resetting `started` would
      // cause a second $use() call on restart, stacking duplicate middleware.
      // To restart emission, create a new adapter instance.
    },
  }
}
