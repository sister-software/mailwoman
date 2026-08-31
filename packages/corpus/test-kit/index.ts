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

import { temporaryDirectory, type TemporaryDirectory } from "@mailwoman/core/fs/temporary"
import { join, resolvePath } from "path-ts"
import { createNewlineWriter, JSONSpliterator } from "spliterator"
import { afterEach, beforeEach } from "vitest"

import type { CanonicalRow } from "#types"

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
	let owned: TemporaryDirectory | undefined

	beforeEach(async () => {
		owned = await temporaryDirectory(`mailwoman-${slug}-`)
		dir.path = resolvePath(owned.path)
	})

	// The directory is owned by the TEST, never by a module-scoped stack. Under `isolate: false` this module is shared
	// across every corpus adapter suite in a fork, so a stack disposed by the first file's `afterAll` left every later
	// file calling `use()` on a disposed stack — which is what "Cannot call AsyncDisposableStack.prototype.use on an
	// already-disposed DisposableStack" was, across a different set of adapter suites on each run.
	//
	// Teardown swallows its own errors: a test that already removed the directory, or a platform that holds a handle
	// open, must not turn a passing assertion into a failing suite.
	afterEach(async () => {
		try {
			await owned?.[Symbol.asyncDispose]()
		} catch {
			// See above.
		}

		owned = undefined
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

/**
 * Write a delimited fixture — a header line plus the given rows — and answer its path.
 *
 * Three adapter suites carried a hand-rolled copy of this, and the copies disagreed about the one thing a reader cannot
 * see: two joined the rows without a trailing newline and the third appended one. `createNewlineWriter` terminates
 * every line it writes, so the file round-trips through `CSVSpliterator` the same way whichever suite produced it, and
 * a caller passes content without a delimiter.
 */
export async function writeDelimitedFixture(
	filePath: string,
	header: string,
	rows: readonly string[]
): Promise<string> {
	await using out = createNewlineWriter(filePath)

	await out.write(header)

	for (const row of rows) {
		await out.write(row)
	}

	return filePath
}
