import { describe, expect, it } from 'bun:test'
import { execSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Build pipeline integration tests for reactiveSWR.
 *
 * These tests verify that the build pipeline is correctly configured to:
 * 1. Include a "prepare" script for link: consumers
 * 2. Export a "./server" subpath in package.json
 * 3. Have a tsconfig.emit.json for declaration file generation
 * 4. Produce complete JS + .d.ts output for all entry points
 * 5. Not bundle peer dependencies (react, react-dom, swr)
 *
 * Tests FAIL initially because the build pipeline has not been fixed yet.
 */

const ROOT = join(import.meta.dir, '..', '..')

function readPackageJson(): Record<string, unknown> {
  const raw = readFileSync(join(ROOT, 'package.json'), 'utf-8')
  return JSON.parse(raw) as Record<string, unknown>
}

function readTsConfigEmit(): Record<string, unknown> {
  const path = join(ROOT, 'tsconfig.emit.json')
  if (!existsSync(path)) return {}
  const raw = readFileSync(path, 'utf-8')
  return JSON.parse(raw) as Record<string, unknown>
}

describe('Build pipeline configuration', () => {
  describe('Req #2 - prepare script', () => {
    it('package.json should have a "prepare" script set to "bun run build"', () => {
      const pkg = readPackageJson()
      const scripts = pkg.scripts as Record<string, string> | undefined

      expect(scripts).toBeDefined()
      expect(scripts?.prepare).toBe('bun run build')
    })
  })

  describe('Req #4 - server subpath export', () => {
    it('package.json exports should include a "./server" subpath', () => {
      const pkg = readPackageJson()
      const exports = pkg.exports as Record<string, unknown> | undefined

      expect(exports).toBeDefined()
      expect(exports?.['./server']).toBeDefined()
    })

    it('package.json ./server export should have correct "import" path', () => {
      const pkg = readPackageJson()
      const exports = pkg.exports as
        | Record<string, Record<string, string>>
        | undefined
      const serverExport = exports?.['./server']

      expect(serverExport).toBeDefined()
      expect(serverExport?.import).toBe('./dist/server/index.js')
    })

    it('package.json ./server export should have correct "types" path', () => {
      const pkg = readPackageJson()
      const exports = pkg.exports as
        | Record<string, Record<string, string>>
        | undefined
      const serverExport = exports?.['./server']

      expect(serverExport).toBeDefined()
      expect(serverExport?.types).toBe('./dist/server/index.d.ts')
    })
  })

  describe('Req #3 - tsconfig.emit.json', () => {
    it('tsconfig.emit.json should exist at the project root', () => {
      expect(existsSync(join(ROOT, 'tsconfig.emit.json'))).toBe(true)
    })

    it('tsconfig.emit.json should extend tsconfig.json', () => {
      const config = readTsConfigEmit()

      expect(config.extends).toBe('./tsconfig.json')
    })

    it('tsconfig.emit.json compilerOptions should have declaration: true', () => {
      const config = readTsConfigEmit()
      const opts = config.compilerOptions as Record<string, unknown>

      expect(opts).toBeDefined()
      expect(opts.declaration).toBe(true)
    })

    it('tsconfig.emit.json compilerOptions should have emitDeclarationOnly: true', () => {
      const config = readTsConfigEmit()
      const opts = config.compilerOptions as Record<string, unknown>

      expect(opts).toBeDefined()
      expect(opts.emitDeclarationOnly).toBe(true)
    })

    it('tsconfig.emit.json compilerOptions should have noEmit: false', () => {
      const config = readTsConfigEmit()
      const opts = config.compilerOptions as Record<string, unknown>

      expect(opts).toBeDefined()
      expect(opts.noEmit).toBe(false)
    })
  })
})

describe('Build output verification', () => {
  // Run the build once for the entire suite - the output of execSync is captured
  // so test failures report the command output for diagnosis
  let buildOutput: string
  let buildError: string | null = null

  try {
    buildOutput = execSync('bun run build', {
      cwd: ROOT,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  } catch (err: unknown) {
    buildError = String(
      (err as { stderr?: string; stdout?: string }).stderr ??
        (err as Error).message,
    )
    buildOutput = String((err as { stdout?: string }).stdout ?? '')
  }

  describe('Req #5 - bun run build succeeds', () => {
    it('bun run build should exit without error', () => {
      expect(buildError).toBeNull()
    })
  })

  describe('Req #3 - JS output files', () => {
    it('should produce dist/index.js (main entry)', () => {
      expect(existsSync(join(ROOT, 'dist', 'index.js'))).toBe(true)
    })

    it('should produce dist/testing/index.js (testing entry)', () => {
      expect(existsSync(join(ROOT, 'dist', 'testing', 'index.js'))).toBe(true)
    })

    it('should produce dist/server/index.js (server entry)', () => {
      expect(existsSync(join(ROOT, 'dist', 'server', 'index.js'))).toBe(true)
    })
  })

  describe('Req #3 - .d.ts output files', () => {
    it('should produce dist/index.d.ts (main types)', () => {
      expect(existsSync(join(ROOT, 'dist', 'index.d.ts'))).toBe(true)
    })

    it('should produce dist/testing/index.d.ts (testing types)', () => {
      expect(existsSync(join(ROOT, 'dist', 'testing', 'index.d.ts'))).toBe(true)
    })

    it('should produce dist/server/index.d.ts (server types)', () => {
      expect(existsSync(join(ROOT, 'dist', 'server', 'index.d.ts'))).toBe(true)
    })
  })

  describe('Req #3 - peer dependencies are external (not bundled)', () => {
    it('dist/index.js should not bundle "react" inline', () => {
      if (!existsSync(join(ROOT, 'dist', 'index.js'))) {
        // File does not exist yet - build hasn't produced it
        expect(existsSync(join(ROOT, 'dist', 'index.js'))).toBe(true)
        return
      }
      const content = readFileSync(join(ROOT, 'dist', 'index.js'), 'utf-8')
      // A bundled react would contain "createElement" defined inline;
      // an external reference keeps only import statements
      expect(content).not.toMatch(/var react\s*=\s*\{/)
      expect(content).not.toMatch(/function createElement\(/)
    })

    it('dist/index.js should not bundle "swr" inline', () => {
      if (!existsSync(join(ROOT, 'dist', 'index.js'))) {
        expect(existsSync(join(ROOT, 'dist', 'index.js'))).toBe(true)
        return
      }
      const content = readFileSync(join(ROOT, 'dist', 'index.js'), 'utf-8')
      // A bundled swr would define its internals; external keeps only imports
      expect(content).not.toMatch(/var swr\s*=\s*\{/)
      expect(content).not.toMatch(/"use-swr"/)
    })

    it('dist/index.js should import react as an external module', () => {
      if (!existsSync(join(ROOT, 'dist', 'index.js'))) {
        expect(existsSync(join(ROOT, 'dist', 'index.js'))).toBe(true)
        return
      }
      const content = readFileSync(join(ROOT, 'dist', 'index.js'), 'utf-8')
      // Should contain an import from "react" (external)
      expect(content).toMatch(/from\s+["']react["']/)
    })

    it('dist/index.js should import swr as an external module', () => {
      if (!existsSync(join(ROOT, 'dist', 'index.js'))) {
        expect(existsSync(join(ROOT, 'dist', 'index.js'))).toBe(true)
        return
      }
      const content = readFileSync(join(ROOT, 'dist', 'index.js'), 'utf-8')
      // Should contain an import from "swr" (external)
      expect(content).toMatch(/from\s+["']swr["']/)
    })
  })

  // Expose build output for diagnosis without polluting test names
  describe('Build output (diagnostic)', () => {
    it('build stdout should be captured', () => {
      // This test always passes - it exists to surface buildOutput in the reporter
      expect(typeof buildOutput).toBe('string')
    })
  })
})
