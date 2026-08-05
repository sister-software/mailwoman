/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Load the curated regression corpus from `cases/<cc>/*.jsonl`.
 *
 *   The corpus was one 3,530-line TS array until 2026-08-05. It is now one JSONL file per ISO-3166 alpha-2
 *   country dir — the per-`cc` layout the gazetteer shard set already uses (`postcode-<cc>-overture.db`) —
 *   because the array had reached the size where "does GB assert dependent_locality anywhere?" was a scroll
 *   rather than a listing.
 *
 *   ORDER IS DEFINED, not incidental: country dir ascending, then case `id` ascending within the file. The
 *   loader re-sorts rather than trusting file order, so a hand-appended row at the bottom of a file cannot
 *   change what the corpus IS — only what a text diff looks like. Nothing downstream depends on the old
 *   chronological array order; the ablation board id hashes a SORTED fingerprint (`ablation.ts`), and the
 *   regression runner grades per row.
 *
 *   What the prose migration cost, stated plainly: JSONL carries no comments, so the 16 batch headers and 18
 *   per-case margin notes that lived between the array literals moved VERBATIM to `batch-notes.md`, keyed by
 *   the `source` value their rows carry. They are not lost, but they are no longer adjacent to their rows.
 *   That is the real price of this layout and the reason `source` must stay a curated, batch-shaped value.
 */

import { existsSync, readdirSync } from "node:fs"
import { readdir } from "node:fs/promises"
import { basename, join } from "node:path"
import { fileURLToPath } from "node:url"

import { tryParsingJSON } from "@mailwoman/core/objects"
import { sha256Hex } from "@mailwoman/core/utils"
import { TextSpliterator } from "spliterator"

import { canonicalizeSeedCase, type SeedCase, SeedCaseSchema } from "./seed-case.ts"

/**
 * An ISO-3166 alpha-2 country directory, lowercase — the layout key. Matches `postcode-<cc>-overture.db` in
 * `gazetteer-pipeline`, which is where the repo's per-`cc` convention already lives.
 */
const COUNTRY_DIR = /^[a-z]{2}$/

/**
 * How much of an unparseable line to quote back. A corpus row is one JSON object per line and the longest here is ~1.4
 * kB of `note` prose — echoing it whole buries the file:line that actually locates the problem.
 */
const MALFORMED_EXCERPT_CHARS = 60

/**
 * The committed corpus root.
 *
 * `new URL`-relative for the source tree with a compiled-tree fallback — tsc emits no `.jsonl` into `out/`, so
 * `mailwoman/out/eval-harness/gauntlet/cases/` reads the source-tree copy. Same bridge as `baseline-assert.ts`'s
 * `resolveBaselineFilePath` and `promotion-gate.ts`'s `resolveGateSpecPath`.
 */
export const CASES_DIR = ((): string => {
	const sibling = fileURLToPath(new URL(".", import.meta.url))

	if (existsSync(sibling) && readdirSync(sibling).some((name) => COUNTRY_DIR.test(name))) return sibling

	return fileURLToPath(new URL("../../../../eval-harness/gauntlet/cases/", import.meta.url))
})()

/**
 * A malformed corpus row, named by file and line.
 *
 * A bare `SyntaxError: Unexpected token }` over a 192-row corpus spread across 29 files is not a diagnosis. Every throw
 * out of {@linkcode loadRegressionCases} carries `<file>:<line>` and, for a schema failure, the offending path.
 */
export class CorpusRowError extends Error {
	constructor(file: string, line: number, detail: string, options?: ErrorOptions) {
		super(`${file}:${line} — ${detail}`, options)
		this.name = "CorpusRowError"
	}
}

/**
 * Read one `<cc>/*.jsonl` file. Blank lines are skipped; the line counter still counts them, so the number in an error
 * is the number your editor shows.
 */
async function loadCorpusFile(path: string, expectedCC: string): Promise<SeedCase[]> {
	const rows: SeedCase[] = []
	let line = 0

	// `skipEmpty: false` is what makes the line NUMBER true. On the default (skip), the counter counts ROWS and
	// silently under-reports by one per blank line above the failure — the report is then confidently wrong,
	// which is worse than absent. Blank lines are dropped below, after they have been counted.
	for await (const raw of TextSpliterator.fromAsync(path, { skipEmpty: false })) {
		line++

		const text = raw.trim()

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

		// The dir IS the country claim. A row filed under the wrong `cc` still loads and still runs, so nothing
		// downstream would ever notice; the listing it was filed under would just be quietly wrong.
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
export async function loadRegressionCases(dir: string = CASES_DIR): Promise<SeedCase[]> {
	const entries = await readdir(dir, { withFileTypes: true })

	const ccDirs = entries
		.filter((e) => e.isDirectory() && COUNTRY_DIR.test(e.name))
		.map((e) => e.name)
		.toSorted()

	const cases: SeedCase[] = []
	const seen = new Map<string, string>()

	for (const cc of ccDirs) {
		const ccPath = join(dir, cc)
		const files = (await readdir(ccPath)).filter((f) => f.endsWith(".jsonl")).toSorted()
		const ccCases: SeedCase[] = []

		for (const file of files) {
			ccCases.push(...(await loadCorpusFile(join(ccPath, file), cc)))
		}

		for (const c of ccCases.toSorted((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
			const previous = seen.get(c.id)

			if (previous) {
				// `id` is the regression DB's PRIMARY KEY, so a duplicate would fail the build with a constraint
				// error naming neither file. Fail here instead, naming both.
				throw new Error(`duplicate case id "${c.id}" — in ${basename(previous)} and cases/${cc}/`)
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
 * ORDER-INDEPENDENT on purpose: it answers "are these the same cases?", never "were they read in the same order?".
 * `load.test.ts` pins it, and that pin is what carried the 2026-08-05 TS-array → JSONL migration across the commit that
 * deleted the array — the hash was measured against the array while both existed, so a later edit that changes corpus
 * CONTENT has to change the pin deliberately.
 */
export function regressionCorpusHash(rows: readonly SeedCase[]): string {
	return sha256Hex(
		rows
			.map((r) => JSON.stringify(canonicalizeSeedCase(r)))
			.toSorted()
			.join("\n")
	)
}
