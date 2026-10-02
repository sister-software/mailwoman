/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The corpus adapter-test harness — the sibling of `mailwoman/test-kit/`.
 *
 *   `corpus/package.json` excludes this directory from the published tarball.
 *   That entry predates this file. The test harness can therefore import `vitest`.
 *   `mailwoman/test-kit/index.ts` uses the same packaging boundary.
 */

import { temporaryDirectory, type TemporaryDirectory } from "@mailwoman/core/fs/temporary"
import { PathBuilder, type PathBuilderLike } from "path-ts"
import { createNewlineWriter, JSONSpliterator } from "spliterator"
import { afterEach, beforeEach } from "vitest"

import type { CanonicalRow } from "#types"

/**
 * A per-test scratch directory.
 *
 * `path` exists only inside a test body.
 * A read before `beforeEach` or after `afterEach` throws.
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

/**
 * Whether a test that calls a publisher's live service should run.
 *
 * CI's `unit-slow` leg runs every `*.integration.test.ts`, and the required
 * `test` context fails when that leg does.
 * A test calling a foreign government host therefore makes a merge depend on that host's
 * availability: Poland's address service answered `ECONNRESET` mid-run on 2026-10-02
 * and reddened a local preflight that had passed an hour earlier.
 *
 * So a live-service test is opt-in, and the suite reports it as skipped
 * rather than passing on a check it did not make.
 * Run one with `MAILWOMAN_LIVE_PUBLISHER_TESTS=1 yarn vitest --run --config vitest.slow.config.ts <file>`.
 *
 * A test reading a committed fixture needs this switch unset, and most of
 * each harvester's coverage is there.
 * The switch is for the assertions only the publisher can answer: that a URL still serves,
 * that a feed still states what the register recorded, that a harvest the adapter can read comes back.
 *
 * It reads `process.env` directly, because it is a per-run test switch rather than
 * project configuration and so has no entry in `@mailwoman/core/env`.
 */
export const LIVE_PUBLISHER_TESTS =
	// oxlint-disable-next-line sister-software/no-process-globals -- stated in the block above.
	process.env.MAILWOMAN_LIVE_PUBLISHER_TESTS === "1"
