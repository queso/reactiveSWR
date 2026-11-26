import path from 'node:path'
import type { NextConfig } from 'next'

// The repository root has its own lockfile and node_modules. Pin the root to
// this directory so the build resolves react, swr and reactive-swr from the
// fixture's own node_modules, the way an app that installed the package would.
const config: NextConfig = {
  turbopack: { root: path.join(__dirname) },
}

export default config
