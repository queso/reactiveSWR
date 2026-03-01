// Barrel file for SSE adapters
// Re-exports all adapter factories and shared types

export { createEmitterAdapter } from './emitter.ts'
export { createMongoAdapter } from './mongodb.ts'
export { createPgAdapter } from './pg.ts'
export { createPrismaAdapter } from './prisma.ts'
export type { AdapterMapping, SSEAdapter } from './types.ts'
