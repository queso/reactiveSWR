import { afterEach, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { findDistProblems } from '../../scripts/check-dist.ts'

/**
 * scripts/check-dist.ts is the gate between `bun build` and a publish. These
 * tests build small fake packages on disk and check that each fault it exists
 * to catch is reported, and that a clean package reports nothing.
 */

const roots: string[] = []

function fakePackage(
  files: Record<string, string>,
  exports: Record<string, { import: string; types: string }> = {
    '.': { import: './dist/index.js', types: './dist/index.d.ts' },
  },
): string {
  const root = mkdtempSync(join(tmpdir(), 'check-dist-'))
  roots.push(root)
  const all = { 'package.json': JSON.stringify({ exports }), ...files }
  for (const [path, content] of Object.entries(all)) {
    const full = join(root, path)
    mkdirSync(dirname(full), { recursive: true })
    writeFileSync(full, content)
  }
  return root
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

const CLEAN = {
  'dist/index.js': 'import { jsx } from "react/jsx-runtime";\n',
  'dist/index.d.ts': 'export {};\n',
}

describe('findDistProblems', () => {
  it('reports nothing for a production build', () => {
    expect(findDistProblems(fakePackage(CLEAN))).toEqual([])
  })

  it('reports the development JSX runtime (issue #6)', () => {
    const root = fakePackage({
      ...CLEAN,
      'dist/index.js': 'import { jsxDEV } from "react/jsx-dev-runtime";\n',
    })

    const problems = findDistProblems(root)

    expect(problems).toHaveLength(1)
    expect(problems[0]).toContain('dist/index.js')
    expect(problems[0]).toContain('development JSX')
  })

  it('reports a jsxDEV call even when the import is spelled another way', () => {
    const root = fakePackage({
      ...CLEAN,
      'dist/index.js': 'const x = jsxDEV(Provider, {}, void 0, false);\n',
    })

    expect(findDistProblems(root)).toHaveLength(1)
  })

  it('reports an export whose file was not built', () => {
    const root = fakePackage(CLEAN, {
      '.': { import: './dist/index.js', types: './dist/index.d.ts' },
      './schema': { import: './dist/schema.js', types: './dist/schema.d.ts' },
    })

    const problems = findDistProblems(root)

    expect(problems).toEqual([
      'package.json exports "./schema" points at ./dist/schema.js, which was not built',
      'package.json exports "./schema" points at ./dist/schema.d.ts, which was not built',
    ])
  })

  it('reports react or swr imported by the schema entry (issue #7)', () => {
    const root = fakePackage({
      ...CLEAN,
      'dist/schema.js': 'import { useSWRConfig } from "swr";\n',
    })

    const problems = findDistProblems(root)

    expect(problems).toHaveLength(1)
    expect(problems[0]).toContain('dist/schema.js')
    expect(problems[0]).toContain('"swr"')
  })

  it('reports react or swr imported anywhere under dist/server', () => {
    const root = fakePackage({
      ...CLEAN,
      'dist/server/index.js': 'import { useRef } from "react";\n',
      'dist/server/adapters/pg.js': "import x from 'swr/infinite';\n",
    })

    const problems = findDistProblems(root)

    expect(problems).toHaveLength(2)
    expect(problems.join('\n')).toContain('dist/server/index.js')
    expect(problems.join('\n')).toContain('dist/server/adapters/pg.js')
  })

  it('allows react and swr in the client entry', () => {
    const root = fakePackage({
      ...CLEAN,
      'dist/index.js':
        'import { useRef } from "react";\nimport { useSWRConfig } from "swr";\nimport { jsx } from "react/jsx-runtime";\n',
    })

    expect(findDistProblems(root)).toEqual([])
  })

  it('does not mistake a package whose name starts with react or swr', () => {
    const root = fakePackage({
      ...CLEAN,
      'dist/server/index.js':
        'import a from "reactive-thing";\nimport b from "swrve";\n',
    })

    expect(findDistProblems(root)).toEqual([])
  })

  it('reports a missing dist directory', () => {
    const root = fakePackage({})

    expect(findDistProblems(root)[0]).toContain('dist')
  })
})
