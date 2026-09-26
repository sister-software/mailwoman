/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The corpus adapter-test harness — the sibling of `mailwoman/test-kit/`.
 *
 *   This directory is excluded from the published tarball by `corpus/package.json`'s `files` (the
 *   `!test-kit/**\/*` entry, which predates this file), which is why importing `vitest` here is safe
 *   — `mailwoman/test-kit/index.ts` imports it on the same grounds.
 */

import { temporaryDirectory, type TemporaryDirectory } from "@mailwoman/core/fs/temporary"
import { PathBuilder, type PathBuilderLike } from "path-ts"
import { createNewlineWriter, JSONSpliterator } from "spliterator"
import { afterEach, beforeEach } from "vitest"

import type { CanonicalRow } from "#types"

/**
 * A per-test scratch directory; `path` exists only inside a test body, and reading it
 * before the `beforeEach` or after the `afterEach` throws.
 */
export interface ScratchDir {
	readonly path: PathBuilder
}

/**
 * Register a fresh scratch directory for each test in the current suite, removed afterwards.
 *
 * `slug` names the directory (`mailwoman-<slug>-xxxxxx` under the OS temp dir)
 * so a stray leftover is traceable to its suite.
 * Teardown swallows its own errors, because a test that already removed the directory
 * or a platform holding a handle open must not turn a passing assertion into a failing suite.
 */
export function useScratchDir(slug: string): ScratchDir {
	let owned: TemporaryDirectory | undefined

	beforeEach(async () => {
		owned = await temporaryDirectory(`mailwoman-${slug}-`)
	})

	// The directory is owned by the test, never by a module-scoped stack: under `isolate: false`
	// this module is shared across every corpus adapter suite in a fork.
	afterEach(async () => {
		try {
			await owned?.[Symbol.asyncDispose]()
		} catch {}

		owned = undefined
	})

	return {
		get path(): PathBuilder {
			if (!owned) throw new Error(`useScratchDir("${slug}"): the scratch directory exists only inside a test body`)

			return owned.path
		},
	}
}

/**
 * Read back the canonical rows a `runAdapter` call wrote at `<outputDir>/<adapterID>/canonical.jsonl`.
 */
export function readCanonicalRows(outputDir: PathBuilderLike, adapterID: string): Promise<CanonicalRow[]> {
	return Array.fromAsync(
		JSONSpliterator.fromAsync<CanonicalRow>(PathBuilder.from(outputDir)(adapterID, "canonical.jsonl"))
	)
}

/**
 * Write a delimited fixture (a header line plus the given rows) and answer its path;
 * `createNewlineWriter` terminates every line, so a caller passes content without a delimiter.
 */
export async function writeDelimitedFixture<P extends PathBuilderLike>(
	filePath: P,
	header: string,
	rows: readonly string[]
): Promise<P> {
	await using out = createNewlineWriter(filePath)

	await out.write(header)

	for (const row of rows) {
		await out.write(row)
	}

	return filePath
}
