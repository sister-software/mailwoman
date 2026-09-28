/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Load the curated regression corpus from `cases/<cc>/*.jsonl`.
 *
 *   The loader re-sorts rather than trusting file order: country dir ascending, then case `id` ascending within
 *   the file, so a hand-appended row at the bottom cannot change what the corpus is.
 */

import { sha256Hex } from "@mailwoman/core/hash"
import { tryParsingJSON, stringifyJSON } from "@mailwoman/core/json"
import { resolvePackageDirectory } from "@mailwoman/core/module/resolvers"
import { type PathBuilder, type PathBuilderLike, resolvePathBuilder } from "path-ts"
import { TextSpliterator } from "spliterator"
import { Globerator } from "spliterator/node/fs"

import { canonicalizeSeedCase, type SeedCase, SeedCaseSchema } from "#eval-harness/gauntlet/cases/seed-case"

const COUNTRY_DIR = /^[a-z]{2}$/

const MALFORMED_EXCERPT_CHARS = 60

/**
 * The committed corpus root, `new URL`-relative for the source tree with a compiled-tree fallback —
 * `tsc` emits no `.jsonl` into `out/`, so the compiled tree reads the source-tree copy.
 */
export const CASES_DIR: PathBuilder = resolvePackageDirectory("mailwoman")("lib", "eval-harness", "gauntlet", "cases")

/**
 * A malformed corpus row, named by file and line, and for a schema failure by the offending path.
 */
export class CorpusRowError extends Error {
	constructor(file: string, line: number, detail: string, options?: ErrorOptions) {
		super(`${file}:${line} — ${detail}`, options)
		this.name = "CorpusRowError"
	}
}

/**
 * Read one `<cc>/*.jsonl` file, skipping blank lines while counting them
 * so line numbers in errors match the editor.
 */
async function loadCorpusFile(source: PathBuilder, expectedCC: string): Promise<SeedCase[]> {
	const path = source.toString()
	const rows: SeedCase[] = []
	let line = 0

	// `skipEmpty: false` makes the line number true; blank lines are dropped below after they are counted.
	for await (const text of TextSpliterator.fromAsync(path, { skipEmpty: false })) {
		line++

		if (!text) continue

		const parsed = tryParsingJSON<unknown>(text)

		if (parsed === null) {
			const excerpt = text.length > MALFORMED_EXCERPT_CHARS ? `${text.slice(0, MALFORMED_EXCERPT_CHARS)}…` : text

			throw new CorpusRowError(path, line, `not valid JSON (${excerpt})`)
		}

		const result = SeedCaseSchema.safeParse(parsed)

		if (!result.success) {
			const detail = result.error.issues
				.map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`)
				.join("; ")

			throw new CorpusRowError(path, line, `does not match SeedCase — ${detail}`)
		}

		// A row filed under the wrong `cc` still loads and runs, so no downstream check would ever notice.
		if (result.data.country.toLowerCase() !== expectedCC) {
			throw new CorpusRowError(
				path,
				line,
				`country "${result.data.country}" does not match its directory "${expectedCC}" — file it under cases/${result.data.country.toLowerCase()}/`
			)
		}

		rows.push(result.data)
	}

	return rows
}

/**
 * Load every case in the corpus, in the defined order (country dir, then case id).
 *
 * @throws {CorpusRowError} On a malformed or off-schema row, naming the file and line.
 */
export async function loadRegressionCases(dir: PathBuilderLike = CASES_DIR): Promise<SeedCase[]> {
	const entries = await Globerator.from("*", { cwd: dir, withFileTypes: true, onlyFiles: false }).toArray()

	const ccDirs = entries
		.filter((e) => e.isDirectory() && COUNTRY_DIR.test(e.name))
		.map((e) => e.name)
		.toSorted()

	const cases: SeedCase[] = []
	const seen = new Map<string, PathBuilder>()

	for (const cc of ccDirs) {
		const ccPath = resolvePathBuilder(dir, cc)
		const files = await Globerator.files("jsonl", { cwd: ccPath, absolute: false, recursive: false }).toSorted()
		const ccCases: SeedCase[] = []

		for (const file of files) {
			ccCases.push(...(await loadCorpusFile(ccPath(file), cc)))
		}

		for (const c of ccCases.toSorted((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
			const previous = seen.get(c.id)

			if (previous) {
				// `id` is the regression DB's primary KEY, so a duplicate would fail the
				// build with a constraint error naming neither file.
				throw new Error(`duplicate case id "${c.id}" — in ${previous.basename()} and cases/${cc}/`)
			}

			seen.set(c.id, ccPath)
			cases.push(canonicalizeSeedCase(c))
		}
	}

	return cases
}

/**
 * A content hash of a loaded corpus — canonical row keys, sorted, `sha256`.
 *
 * Order-independent on purpose: it answers whether these are the same cases, not
 * whether they were read in the same order.
 */
export function regressionCorpusHash(rows: readonly SeedCase[]): string {
	return sha256Hex(
		rows
			.map((r) => stringifyJSON(canonicalizeSeedCase(r)))
			.toSorted()
			.join("\n")
	)
}
