#!/usr/bin/env node

/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The CLI's bin entry, and nothing else. Its whole job is to run a process-wide preamble BEFORE the CLI's module
 *   graph is evaluated, then hand off to `cli-main.ts`.
 *
 *   The split is load-bearing. ESM evaluates every static import before a module's own body runs, so a preamble
 *   written as body code in `cli-main.ts` would execute AFTER `pastel` → `ink` → `react` and its ~2,700-module graph
 *   had already been compiled and initialized — too late to change how any of it loads. Only `node:module` is imported
 *   statically here (a builtin, already resident); the real CLI arrives through `await import()`, which evaluates after
 *   this body.
 *
 *   So keep this file at one static import: anything added to the top of it is compiled before the cache exists.
 */

import { enableCompileCache } from "node:module"

// The CLI compiles ~16 MB of source per invocation, and the loader/compiler/GC are ~85% of a `--help` run. V8's
// on-disk code cache removes most of it: `--help` 1.34 s → 0.99 s, `parse` 2.95 s → 2.63 s. The cache is
// content-addressed and self-invalidating, so a stale entry is not a failure mode; an unwritable cache directory is,
// and a CLI that cannot cache its compilation is a slow CLI rather than a broken one.
try {
	enableCompileCache()
} catch {}

await import("./cli-main.ts")
