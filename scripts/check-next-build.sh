#!/usr/bin/env bash
# Builds the package, packs it the way `npm publish` would, installs that
# tarball into fixtures/next-app and runs `next build` there.
#
# The fixture has a route handler that imports the schema and createChannel,
# and a client page that renders SSEProvider. In 0.2.0 both failed `next build`
# (issues #6 and #7) while every unit test passed, because the faults were in
# the published files, not in the source.
#
# RSWR_TARBALL=/path/to/reactive-swr-x.y.z.tgz checks an existing tarball
# instead of building one.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
fixture="$root/fixtures/next-app"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

if [ -n "${RSWR_TARBALL:-}" ]; then
  tarball="$RSWR_TARBALL"
else
  cd "$root"
  bun run build
  bun pm pack --destination "$work" --ignore-scripts >/dev/null
  tarball="$(ls "$work"/*.tgz)"
fi
echo "check-next: using $(basename "$tarball")"

cd "$fixture"
bun install --frozen-lockfile
rm -rf node_modules/reactive-swr .next
mkdir -p node_modules/reactive-swr
tar -xzf "$tarball" -C node_modules/reactive-swr --strip-components=1

# next build sets NODE_ENV itself; a stray value from the caller only adds a warning.
env -u NODE_ENV bun run build
echo "check-next: next build passed against $(basename "$tarball")"
