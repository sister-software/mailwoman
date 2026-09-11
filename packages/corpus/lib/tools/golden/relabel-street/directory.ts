/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Rewrites a golden-set directory and renders its review deck.
 */

import { pathExists, readDirectoryEntries, readLocalBuffer, readLocalTextFile } from "@mailwoman/core/fs/readers"
import { makeDirectories, writeLocalFile, writeLocalJSONFile, writeLocalTextFile } from "@mailwoman/core/fs/writers"
import { sha256File } from "@mailwoman/core/hash"
import { parseJSONStrict, tryParsingJSON } from "@mailwoman/core/json"
import { isPresent } from "@mailwoman/core/objects"
import { basename, join } from "path-ts"
import { TextSpliterator } from "spliterator"

import {
	relabelGoldenStreetRow,
	type GoldenRelabelClass,
	type GoldenRelabelFlag,
	type GoldenStreetRow,
} from "#tools/golden/relabel-street/row"

// ── Directory-level relabel ────────────────────────────────────────────────

/**
 * Per-class row counts for one relabelled file.
 */
export type GoldenRelabelCounts = Record<GoldenRelabelClass, number>

/**
 * One line of the review deck: what a changed (or notably unchanged) row looked like before and after.
 */
export interface GoldenRelabelDeckEntry {
	file: string
	line: number
	raw: string
	rowClass: GoldenRelabelClass
	before: Record<string, string>
	after: Record<string, string>
	flags: GoldenRelabelFlag[]
}

/**
 * Options for {@linkcode relabelGoldenDirectory}.
 */
export interface RelabelGoldenOptions {
	/**
	 * Parent golden version dir (read-only), e.g. `data/eval/golden/v0.1.2`.
	 */
	input: string
	/**
	 * Output golden version dir. Created; never overwritten in place.
	 */
	output: string
	/**
	 * Review-deck JSONL path. Default `<output>/REVIEW-DECK.jsonl`.
	 */
	deck?: string
	/**
	 * Parent version label recorded in the manifest. Default: the input dir's basename.
	 */
	parentLabel?: string
	/**
	 * Tool provenance recorded in the manifest — the commit the relabel ran at.
	 */
	commit?: string
	/**
	 * Passed through to {@linkcode relabelGoldenStreetRow}. Default true.
	 */
	splitPrefix?: boolean
}

/**
 * Aggregate outcome for a whole golden version.
 */
export interface RelabelGoldenReport {
	files: Record<
		string,
		{ entries: number; changed: number; flagged: number; prefixSplit: number; counts: GoldenRelabelCounts }
	>
	deckPath: string
	outputDir: string
	totalChanged: number
	totalFlagged: number
}

const EMPTY_COUNTS = (): GoldenRelabelCounts => ({
	"split-suffix": 0,
	"split-suffix-postdirectional": 0,
	"split-prefix-only": 0,
	"already-split": 0,
	"single-token": 0,
	"suffix-only-street": 0,
	"postdirectional-tail-only": 0,
	"no-suffix-match": 0,
	"no-street": 0,
	"not-us": 0,
	"untrimmed-street": 0,
})

/**
 * Classes that are LEFT FOLDED but still belong in the deck, because the operator asked to see them by name: a street
 * that is entirely one suffix word, and a bare post-directional tail.
 */
const DECK_WORTHY_UNCHANGED: ReadonlySet<GoldenRelabelClass> = new Set([
	"suffix-only-street",
	"postdirectional-tail-only",
	"untrimmed-street",
])

/**
 * Relabel every `.jsonl` in a golden version dir, writing a new version dir plus a review deck and a MANIFEST that
 * records the convention, the parent, and the counts. Non-JSONL siblings (README, split manifests) are copied forward
 * so the new version is self-contained; nested split dirs (`dev/`, `test/`) are relabelled recursively.
 */
export async function relabelGoldenDirectory(
	options: RelabelGoldenOptions,
	report: (line: string) => void = console.log
): Promise<RelabelGoldenReport> {
	const { input, output } = options
	const deckPath = options.deck ?? join(output, "REVIEW-DECK.jsonl")
	await makeDirectories(output)

	const deck: GoldenRelabelDeckEntry[] = []
	const files: RelabelGoldenReport["files"] = {}

	const walk = async (dirIn: string, dirOut: string, prefix: string): Promise<void> => {
		await makeDirectories(dirOut)

		for (const name of await readDirectoryEntries(dirIn)) {
			const from = join(dirIn, name.name)
			const to = join(dirOut, name.name)

			if (name.isDirectory()) {
				await walk(from, to, `${prefix}${name.name}/`)

				continue
			}

			if (!name.name.endsWith(".jsonl")) {
				// MANIFEST is rewritten below; everything else (README, SPLIT-MANIFEST) rides forward.
				if (name.name !== "MANIFEST.json") {
					await writeLocalFile(await readLocalBuffer(from), to)
				}

				continue
			}

			const counts = EMPTY_COUNTS()
			let changed = 0
			let flagged = 0
			let prefixSplit = 0
			const out: string[] = []
			let lineNumber = 0

			for (const line of TextSpliterator.from(await readLocalTextFile(from))) {
				if (!line.trim()) continue

				lineNumber++
				// A corrupt answer-key line must STOP the relabel, not silently drop a row — a golden file
				// short by one row is a floor threshold against a different denominator.
				const row = parseJSONStrict<GoldenStreetRow>(line)
				const result = relabelGoldenStreetRow(row, { splitPrefix: options.splitPrefix ?? true })

				counts[result.rowClass]++

				if (result.changed) {
					changed++
				}

				if (result.prefixSplit) {
					prefixSplit++
				}

				if (result.flags.length) {
					flagged++
				}

				if (result.changed || DECK_WORTHY_UNCHANGED.has(result.rowClass)) {
					deck.push({
						file: `${prefix}${name.name}`,
						line: lineNumber,
						raw: row.raw,
						rowClass: result.rowClass,
						before: row.components,
						after: result.row.components,
						flags: result.flags,
					})
				}

				out.push(JSON.stringify(result.row))
			}

			await writeLocalTextFile(out.join("\n") + "\n", to)
			files[`${prefix}${name.name}`] = { entries: lineNumber, changed, flagged, prefixSplit, counts }

			report(
				`  ${prefix}${name.name}: ${lineNumber} rows, ${changed} changed (${prefixSplit} with a prefix lift), ${flagged} flagged`
			)
		}
	}

	report(`relabel ${input} → ${output}`)
	await walk(input, output, "")

	await writeLocalTextFile(deck.map((entry) => JSON.stringify(entry)).join("\n") + "\n", deckPath)
	await writeLocalFile(renderDeckMarkdown(deck, basename(input), basename(output)), deckPath.replace(/\.jsonl$/, ".md"))

	const manifestFiles: Record<
		string,
		{ entries: number; sha256: string; changed: number; flagged: number; prefix_split: number }
	> = {}

	for (const [name, stats] of Object.entries(files)) {
		manifestFiles[name] = {
			entries: stats.entries,
			sha256: await sha256File(join(output, name)),
			changed: stats.changed,
			flagged: stats.flagged,
			prefix_split: stats.prefixSplit,
		}
	}

	const totalChanged = Object.values(files).reduce((n, f) => n + f.changed, 0)
	const totalFlagged = Object.values(files).reduce((n, f) => n + f.flagged, 0)

	const manifest = {
		version: basename(output),
		parent: options.parentLabel ?? basename(input),
		generated_at: new Date().toISOString(),
		tool: "corpus/src/tools/golden-relabel-street.ts (mailwoman corpus golden-relabel)",
		...(options.commit ? { commit: options.commit } : {}),
		convention: {
			street_convention: { US: "split", "*": "folded" },
			declared:
				"US street spans are labeled SPLIT: a leading directional is its own `street_prefix` span, the Pub-28 " +
				"street type (plus a post-directional, when one trails it) is its own `street_suffix` span, and `street` " +
				"carries only the name. Non-US rows keep the folded convention of the parent version. A scorer that " +
				"folds `street_prefix`/`street`/`street_suffix` back together before comparing is NOT grading this " +
				"answer key.",
			instrument:
				"@mailwoman/codex/us — matchTrailingSuffix (USPS Pub-28 Appendix C) for the type, " +
				"isStreetDirectionalToken for the directionals",
			left_folded:
				"single-token streets, streets that are entirely one suffix word, bare post-directional tails, and any " +
				"street whose trailing word is not in the Pub-28 table",
			prefix_split: options.splitPrefix ?? true,
		},
		counts: {
			changed: totalChanged,
			flagged: totalFlagged,
			prefix_split: Object.values(files).reduce((n, f) => n + f.prefixSplit, 0),
			per_file: Object.fromEntries(Object.entries(files).map(([name, stats]) => [name, stats.counts])),
		},
		files: manifestFiles,
		review_deck: basename(deckPath),
	}

	await writeLocalJSONFile(manifest, join(output, "MANIFEST.json"))
	report(`✓ ${totalChanged} rows split, ${totalFlagged} flagged — deck at ${deckPath}`)

	return { files, deckPath, outputDir: output, totalChanged, totalFlagged }
}

/**
 * Render the operator-facing half of the review deck: the flagged rows first (those are the ones asking for a ruling),
 * then the classes the tool LEFT FOLDED by name, then a sample of the ordinary corrections. The JSONL sibling carries
 * every row; this file is the one a human reads.
 */
function renderDeckMarkdown(deck: GoldenRelabelDeckEntry[], parent: string, version: string): string {
	const span = (components: Record<string, string>): string =>
		[components.street_prefix, components.street, components.street_suffix]
			.filter(isPresent)
			.map((s) => JSON.stringify(s))
			.join(" + ")

	// The split dirs are copies of the same rows — dedupe the deck to the top-level files for reading.
	const top = deck.filter((entry) => !entry.file.includes("/"))
	const flagged = top.filter((entry) => entry.flags.length)
	const folded = top.filter((entry) => isLeftFolded(entry.rowClass))
	const plain = top.filter((entry) => !entry.flags.length && !isLeftFolded(entry.rowClass))

	const rows = (entries: GoldenRelabelDeckEntry[]): string =>
		entries
			.map(
				(entry) =>
					`| ${entry.file}:${entry.line} | ${span(entry.before)} | ${span(entry.after)} | ${entry.flags.map((f) => f.kind).join(", ") || "—"} | ${JSON.stringify(entry.raw)} |`
			)
			.join("\n")

	const header = "| row | before | after | flags | raw |\n|---|---|---|---|---|"

	return [
		`# Golden street-suffix relabel review deck — ${parent} → ${version}`,
		"",
		"Rows are deduped to the top-level files (`dev/` and `test/` carry the same rows).",
		"A flag is a REVIEW TRIGGER, not an adjudication: the split below is already applied.",
		"",
		`## Flagged (${flagged.length}) — needs a ruling`,
		"",
		header,
		rows(flagged),
		"",
		`## Left folded (${folded.length}) — the tool declined to split these`,
		"",
		header,
		rows(folded),
		"",
		`## Ordinary corrections (${plain.length}) — first 100 shown; the JSONL deck has all`,
		"",
		header,
		rows(plain.slice(0, 100)),
		"",
	].join("\n")
}

/**
 * Every relabel class that means the row was left folded, for callers that want to report the residue.
 */
export function isLeftFolded(rowClass: GoldenRelabelClass): boolean {
	return rowClass !== "split-suffix" && rowClass !== "split-suffix-postdirectional" && rowClass !== "split-prefix-only"
}

/**
 * True when a golden dir declares the US-split convention — i.e. it is safe to grade it with an UNFOLDED scorer.
 */
export async function goldenDeclaresSplitStreets(dir: string): Promise<boolean> {
	for (const candidate of [join(dir, "MANIFEST.json"), join(dir, "..", "MANIFEST.json")]) {
		if (!(await pathExists(candidate))) continue

		const manifest = tryParsingJSON<{ convention?: { street_convention?: Record<string, string> } }>(
			await readLocalTextFile(candidate)
		)

		if (manifest?.convention?.street_convention?.US === "split") return true
	}

	return false
}
