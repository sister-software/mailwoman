/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The corpus adapter-test harness — the sibling of `mailwoman/test-kit/`, and the shape every
 *   `corpus/src/adapters/*\/adapter.test.ts` had grown for itself.
 *
 *   Nine of them opened with the same twenty lines: the `mkdtemp`/`rm`/`tmpdir`/`join` +
 *   `JSONSpliterator` import header, a `let scratch`, a `beforeEach` that mkdtemps
 *   `mailwoman-<something>-`, an `afterEach` that force-removes it swallowing errors, and a
 *   `loadRows()` that reads the run's `canonical.jsonl` back through `JSONSpliterator`. Nothing about
 *   any of that is adapter-specific; only the tmpdir prefix and the adapter id ever differed.
 *
 *   This directory is excluded from the published tarball by `corpus/package.json`'s `files` (the
 *   `!test-kit/**\/*` entry, which predates this file), which is why importing `vitest` here is safe
 *   — `mailwoman/test-kit/index.ts` imports it on the same grounds.
 */

import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { JSONSpliterator } from "spliterator"
import { afterEach, beforeEach } from "vitest"

import type { CanonicalRow } from "../src/types.ts"

/**
 * A per-test scratch directory. `path` is only meaningful inside a test body — it is `""` until the `beforeEach` runs.
 */
export interface ScratchDir {
	readonly path: string
}

/**
 * Register a fresh scratch directory for each test in the current suite, removed afterwards.
 *
 * `slug` names the directory (`mailwoman-<slug>-XXXXXX` under the OS temp dir) and exists only to make a stray leftover
 * traceable to the suite that made it. Teardown swallows its own errors: a test that already removed the directory, or
 * a platform that holds a handle open, must not turn a passing assertion into a failing suite.
 */
export function useScratchDir(slug: string): ScratchDir {
	const dir = { path: "" }

	beforeEach(async () => {
		dir.path = await mkdtemp(join(tmpdir(), `mailwoman-${slug}-`))
	})

	afterEach(async () => {
		await rm(dir.path, { recursive: true, force: true }).catch(() => {})
	})

	return dir
}

/**
 * Read back the canonical rows a `runAdapter` call wrote — `<outputDir>/<adapterID>/canonical.jsonl`, streamed through
 * `JSONSpliterator` and collected.
 */
export function readCanonicalRows(outputDir: string, adapterID: string): Promise<CanonicalRow[]> {
	return Array.fromAsync(JSONSpliterator.fromAsync<CanonicalRow>(join(outputDir, adapterID, "canonical.jsonl")))
}
