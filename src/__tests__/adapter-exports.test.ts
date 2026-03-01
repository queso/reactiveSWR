import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { SSEAdapter } from '../server/adapters/index.ts'

// Compile-time assertion: if the barrel stops re-exporting SSEAdapter, tsc fails here
type _AssertSSEAdapterType = SSEAdapter

/**
 * Adapter barrel export and package.json subpath configuration tests.
 *
 * Verifies that:
 * 1. src/server/adapters/index.ts barrel exports all adapter factories + types
 * 2. src/server/index.ts re-exports adapter factories from the barrel
 * 3. Each adapter is independently importable from its own module path
 * 4. The root client entry point does NOT leak adapter code
 * 5. package.json has subpath exports for individual adapters
 *
 * Tests will FAIL until the barrel file and package.json subpaths are wired up.
 */

const ROOT = join(import.meta.dir, '..', '..')

const ADAPTER_FACTORY_NAMES = [
  'createPrismaAdapter',
  'createMongoAdapter',
  'createPgAdapter',
  'createEmitterAdapter',
] as const

describe('Adapter barrel exports (src/server/adapters/index.ts)', () => {
  it('should export all four createXxxAdapter factory functions', async () => {
    const barrel = await import('../server/adapters/index.ts')
    const exportKeys = Object.keys(barrel)

    for (const name of ADAPTER_FACTORY_NAMES) {
      expect(exportKeys).toContain(name)
      expect(typeof barrel[name as keyof typeof barrel]).toBe('function')
    }
  })

  it('should re-export SSEAdapter type (verified via type-level import)', async () => {
    // SSEAdapter is a type-only export -- it won't appear in Object.keys at
    // runtime, but importing it must not throw. If the barrel is missing the
    // re-export, TypeScript would error and Bun would fail to resolve.
    const barrel = await import('../server/adapters/index.ts')
    // The barrel module should resolve without error; runtime object exists
    expect(barrel).toBeDefined()
  })
})

describe('Server entry re-exports (src/server/index.ts)', () => {
  it('should re-export all adapter factory functions from the barrel', async () => {
    const serverExports = await import('../server/index.ts')
    const exportKeys = Object.keys(serverExports)

    for (const name of ADAPTER_FACTORY_NAMES) {
      expect(exportKeys).toContain(name)
      expect(typeof serverExports[name as keyof typeof serverExports]).toBe(
        'function',
      )
    }
  })

  it('should still export createChannel from the server entry', async () => {
    const serverExports = await import('../server/index.ts')

    expect(serverExports.createChannel).toBeDefined()
    expect(typeof serverExports.createChannel).toBe('function')
  })
})

describe('Individual adapter module imports', () => {
  it('should import createPrismaAdapter from its own module', async () => {
    const mod = await import('../server/adapters/prisma.ts')
    expect(typeof mod.createPrismaAdapter).toBe('function')
  })

  it('should import createMongoAdapter from its own module', async () => {
    const mod = await import('../server/adapters/mongodb.ts')
    expect(typeof mod.createMongoAdapter).toBe('function')
  })

  it('should import createPgAdapter from its own module', async () => {
    const mod = await import('../server/adapters/pg.ts')
    expect(typeof mod.createPgAdapter).toBe('function')
  })

  it('should import createEmitterAdapter from its own module', async () => {
    const mod = await import('../server/adapters/emitter.ts')
    expect(typeof mod.createEmitterAdapter).toBe('function')
  })
})

describe('Client entry point exclusion', () => {
  it('should NOT export adapter factory functions from the root entry point', async () => {
    const clientExports = await import('../index.ts')
    const exportKeys = Object.keys(clientExports)

    for (const name of ADAPTER_FACTORY_NAMES) {
      expect(exportKeys).not.toContain(name)
    }
  })
})

describe('package.json subpath exports', () => {
  function readPackageExports(): Record<string, unknown> {
    const raw = readFileSync(join(ROOT, 'package.json'), 'utf-8')
    const pkg = JSON.parse(raw) as { exports?: Record<string, unknown> }
    return pkg.exports ?? {}
  }

  it('should have subpath exports for each adapter', () => {
    const exports = readPackageExports()
    const expectedSubpaths = [
      './server/adapters/prisma',
      './server/adapters/mongodb',
      './server/adapters/pg',
      './server/adapters/emitter',
    ]

    for (const subpath of expectedSubpaths) {
      expect(exports[subpath]).toBeDefined()
    }
  })

  it('each adapter subpath should have import and types entries', () => {
    const exports = readPackageExports()
    const adapterNames = ['prisma', 'mongodb', 'pg', 'emitter']

    for (const name of adapterNames) {
      const subpath = exports[`./server/adapters/${name}`] as
        | Record<string, string>
        | undefined

      expect(subpath).toBeDefined()
      expect(subpath?.import).toMatch(
        new RegExp(`dist/server/adapters/${name}`),
      )
      expect(subpath?.types).toMatch(new RegExp(`dist/server/adapters/${name}`))
    }
  })

  it('should preserve existing ./server subpath export', () => {
    const exports = readPackageExports()
    const serverExport = exports['./server'] as
      | Record<string, string>
      | undefined

    expect(serverExport).toBeDefined()
    expect(serverExport?.import).toBe('./dist/server/index.js')
    expect(serverExport?.types).toBe('./dist/server/index.d.ts')
  })
})
