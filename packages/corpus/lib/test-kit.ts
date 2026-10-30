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
import { stringifyJSON } from "@mailwoman/core/json"
import { PathBuilder, type PathBuilderLike } from "path-ts"
import { createNewlineWriter, JSONSpliterator } from "spliterator"
import { afterEach, beforeEach, expect } from "vitest"

import type { ParquetRow } from "#parquet/schema"
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
	let owned: TemporaryDirectory | null = null

	beforeEach(async () => {
		owned = await temporaryDirectory(`mailwoman-${slug}-`)
	})

	// The directory is owned by the test, never by a module-scoped stack: under `isolate: false`
	// this module is shared across every corpus adapter suite in a fork.
	afterEach(async () => {
		try {
			await owned?.[Symbol.asyncDispose]()
		} catch {}

		owned = null
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

/**
 * One GB parquet row whose postcode sits at the end of `raw`, the shape `rendered-gb-os-open` renders.
 *
 * The streets and postcodes come from OS OpenData (OGL v3.0), not from HM Land Registry Price Paid Data.
 *
 * The span triple is what the holdout splitter reads, so the offsets name the real substring:
 * a fixture whose spans pointed elsewhere would pass against a splitter reading the wrong column.
 */
export function gbOverlayRow(sourceID: string, street: string, locality: string, postcode: string): ParquetRow {
	const raw = `${street}, ${locality}, ${postcode}`
	const localityStart = street.length + 2
	const postcodeStart = localityStart + locality.length + 2

	return {
		raw,
		tokens: raw.split(" "),
		labels: raw.split(" ").map(() => "O"),
		span_starts: [0, localityStart, postcodeStart],
		span_ends: [street.length, localityStart + locality.length, raw.length],
		span_tags: ["street", "locality", "postcode"],
		country: "GB",
		locale: "en-GB",
		source: "rendered-gb-os-open",
		source_id: sourceID,
		license: "OGL-UK-3.0",
		register: "gb-os-opendata",
		surface: "composed",
		augmentation: null,
		base_source_id: null,
	}
}

/**
 * Asserts the invariants of every span-labeled row a corpus builder writes:
 * `0 <= start < end <= length` in code points, each span beginning and ending on a
 * non-whitespace character, and starts in ascending order.
 *
 * A builder's own record check allows whitespace inside a CJK span, so the edge rule is checked here.
 */
export function expectSpanInvariants(rows: readonly unknown[]): void {
	expect(rows.length).toBeGreaterThan(0)

	for (const row of rows as ReadonlyArray<{ raw: unknown; span_starts: unknown; span_ends: unknown }>) {
		const characters = Array.from(String(row.raw))
		const starts = Array.from(row.span_starts as Iterable<number | bigint>, Number)
		const ends = Array.from(row.span_ends as Iterable<number | bigint>, Number)

		expect(ends).toHaveLength(starts.length)

		for (const [i, start] of starts.entries()) {
			const end = ends[i]!
			const text = characters.slice(start, end)

			expect(start >= 0 && start < end && end <= characters.length, `${row.raw} [${start}, ${end})`).toBe(true)
			expect(/\s/u.test(text[0]!) || /\s/u.test(text.at(-1)!), `${row.raw} [${start}, ${end})`).toBe(false)

			if (i > 0) {
				expect(start, String(row.raw)).toBeGreaterThanOrEqual(starts[i - 1]!)
			}
		}
	}
}

/**
 * Asserts that a parsed build report matches its reference in every value and every key's position.
 *
 * `toEqual` alone ignores key order, which a report's bytes carry.
 * The comparison sorts the tags that tie within each `per_tag_rows` count on both sides first,
 * because the Python reference counted tags from a set and its tie order followed `PYTHONHASHSEED`.
 */
export function expectReportBytes(report: unknown, reference: unknown): void {
	expect(report).toEqual(reference)
	expect(stringifyJSON(sortTagRowTies(report))).toBe(stringifyJSON(sortTagRowTies(reference)))
}

function sortTagRowTies(value: unknown, key?: string): unknown {
	if (Array.isArray(value)) return value.map((item) => sortTagRowTies(item))

	if (typeof value !== "object" || value === null) return value

	const entries = Object.entries(value)

	if (key === "per_tag_rows") {
		return Object.fromEntries(
			(entries as Array<[string, number]>).toSorted(
				([leftTag, left], [rightTag, right]) => right - left || (leftTag < rightTag ? -1 : 1)
			)
		)
	}

	return Object.fromEntries(entries.map(([name, item]) => [name, sortTagRowTies(item, name)]))
}
