/**
 * Checks the built package before it can be published. Run by `bun run build`.
 *
 * It exists because two faults reached npm in 0.2.0 without any test failing:
 *
 * - The client bundle was built with the development JSX transform. Production
 *   React exports `jsxDEV` as undefined, so the provider crashed in every
 *   production build (issue #6).
 * - Nothing a server could import carried `defineSchema` without also pulling
 *   in `swr`'s hooks, which a Next.js route handler cannot load (issue #7).
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

type ExportTarget = string | { [condition: string]: ExportTarget }

/** Imports of `react`, `react-dom` or `swr`, including their subpaths. */
const CLIENT_ONLY_IMPORT =
  /(?:\bfrom|\bimport|\brequire)\s*\(?\s*(["'](?:react|react-dom|swr)(?:\/[^"']*)?["'])/g

function jsFiles(dir: string): string[] {
  const found: string[] = []
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) found.push(...jsFiles(full))
    else if (name.endsWith('.js')) found.push(full)
  }
  return found.sort()
}

function targets(target: ExportTarget): string[] {
  if (typeof target === 'string') return [target]
  return Object.values(target).flatMap(targets)
}

/** A file is server-safe when a route handler or a plain Node server imports it. */
function mustBeServerSafe(path: string): boolean {
  return path === 'dist/schema.js' || path.startsWith('dist/server/')
}

/**
 * Returns one sentence per fault found in `<root>/dist`, or an empty list.
 * `root` is the package directory (the one holding package.json).
 */
export function findDistProblems(root: string): string[] {
  const dist = join(root, 'dist')
  if (!existsSync(dist)) {
    return [`${dist} does not exist; run the build first`]
  }

  const problems: string[] = []

  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
    exports?: Record<string, ExportTarget>
  }
  for (const [subpath, target] of Object.entries(pkg.exports ?? {})) {
    for (const file of targets(target)) {
      if (!existsSync(join(root, file))) {
        problems.push(
          `package.json exports "${subpath}" points at ${file}, which was not built`,
        )
      }
    }
  }

  for (const full of jsFiles(dist)) {
    const path = relative(root, full).split('\\').join('/')
    const source = readFileSync(full, 'utf8')

    if (/jsx-dev-runtime|\bjsxDEV\b/.test(source)) {
      problems.push(
        `${path} uses the development JSX runtime (jsxDEV), which is undefined in production React; build with NODE_ENV=production`,
      )
    }

    if (mustBeServerSafe(path)) {
      const imported = new Set<string>()
      for (const match of source.matchAll(CLIENT_ONLY_IMPORT)) {
        if (match[1]) imported.add(match[1])
      }
      for (const specifier of imported) {
        problems.push(
          `${path} imports ${specifier}; server entry points must not load react or swr`,
        )
      }
    }
  }

  return problems
}

if (import.meta.main) {
  const root = join(import.meta.dir, '..')
  const problems = findDistProblems(root)
  if (problems.length > 0) {
    console.error('check-dist: the built package is not safe to publish:')
    for (const problem of problems) console.error(`  - ${problem}`)
    process.exit(1)
  }
  console.log('check-dist: dist is a production build and its exports resolve')
}
