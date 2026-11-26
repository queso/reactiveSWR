import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * The schema must be importable where React hooks cannot be: a Next.js App
 * Router route handler resolves `swr` to its react-server build, which has no
 * `useSWRConfig`, so anything that imports the package root fails `next build`
 * (issue #7). These tests pin the entry points a server can import.
 */

const ROOT = join(import.meta.dir, '..', '..')
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))

describe('reactive-swr/schema entry', () => {
  it('exports defineSchema from src/schema.ts', async () => {
    const exports = await import('../schema.ts')

    expect(typeof exports.defineSchema).toBe('function')
    expect(Object.keys(exports)).toEqual(['defineSchema'])
  })

  it('has a ./schema subpath in package.json exports', () => {
    expect(pkg.exports['./schema']).toEqual({
      import: './dist/schema.js',
      types: './dist/schema.d.ts',
    })
  })

  it('builds src/schema.ts as its own entry point', () => {
    expect(pkg.scripts.build).toMatch(/\bsrc\/schema\.ts\b/)
  })

  it('emits declarations for src/schema.ts', () => {
    const emit = JSON.parse(
      readFileSync(join(ROOT, 'tsconfig.emit.json'), 'utf8'),
    )

    expect(emit.include).toContain('src/schema.ts')
  })

  it('imports nothing at runtime: every import in src/schema.ts is type-only', () => {
    const source = readFileSync(join(ROOT, 'src', 'schema.ts'), 'utf8')
    const imports = source.match(/^import\b[^\n]*/gm) ?? []

    expect(imports.length).toBeGreaterThan(0)
    for (const line of imports) {
      expect(line).toMatch(/^import type\b/)
    }
  })
})

describe('reactive-swr/server entry', () => {
  it('re-exports defineSchema, so a server needs one import', async () => {
    const server = await import('../server/index.ts')
    const schema = await import('../schema.ts')

    expect(server.defineSchema).toBe(schema.defineSchema)
  })

  it('gives createChannel a schema built by its own defineSchema', async () => {
    const { createChannel, defineSchema } = await import('../server/index.ts')
    const schema = defineSchema({
      'order.placed': { key: '/api/orders', update: 'refetch' },
    })
    const channel = createChannel(schema)

    expect(channel.isClosed()).toBe(false)
    await channel.close()
    expect(channel.isClosed()).toBe(true)
  })
})

describe('build script', () => {
  it('pins NODE_ENV=production, so bun never emits the development JSX transform', () => {
    expect(pkg.scripts.build).toMatch(/^NODE_ENV=production bun build /)
  })

  it('checks the built files before the build counts as done', () => {
    expect(pkg.scripts.build).toMatch(/&& bun run check:dist$/)
    expect(pkg.scripts['check:dist']).toBe('bun scripts/check-dist.ts')
  })
})
