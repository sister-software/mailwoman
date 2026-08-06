/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Golden-set street-suffix relabel — v0.1.2 → v0.1.3.
 *
 *   ## Why this exists
 *
 *   The golden answer key and the training corpus disagreed about ONE thing, and the v9.0.0
 *   promotion gate read the disagreement as a model regression (`us.street` 87.4 vs a floor of
 *   87.8). The corpus SPLITS a US street into `street` + `street_suffix` — TIGER's adapter
 *   decomposes at `corpus/src/adapters/tiger/street-decompose.ts`, the `street-affix` shard recipe
 *   teaches it from USPS Pub-28, and `ComponentTag` carries `street_suffix` as a first-class tag.
 *   The golden set FOLDED it: 2,216 US rows carry a `street`, and exactly 2 of them label a
 *   `street_suffix`. Operator ruling, 2026-08-06: **the split is canonical**; the golden is the
 *   stale side. This tool moves the answer key onto the corpus convention.
 *
 *   ## The instrument
 *
 *   `matchTrailingSuffix` from `@mailwoman/codex/us` — the USPS Pub-28 Appendix C table, which is
 *   also what the corpus shard recipe splits on. The table is NOT re-implemented here, and the
 *   libpostal dictionary TIGER reads is deliberately not used: measured on this golden set the two
 *   disagree on 51 US rows, and the disagreements run in the codex table's favour (libpostal's
 *   `directionals.txt` lists `center|c`, so TIGER reads the `C` of "C STREET" as a directional
 *   prefix and then emits no suffix at all).
 *
 *   ## What it changes, and what it refuses to
 *
 *   Applied only to rows whose `country` is `US`. Three branches, mirroring the SHAPE of TIGER's
 *   `decomposeStreet` on codex tables:
 *
 *   - **street type** — the last whitespace-separated word is a Pub-28 suffix, and something is left
 *       over: "Main St" → `street: "Main"`, `street_suffix: "St"` (1,559 rows).
 *   - **street type + post-directional** — the last word is a directional AND the one before it is a
 *       Pub-28 suffix: "Pennsylvania Avenue NW" → `street: "Pennsylvania"`,
 *       `street_suffix: "Avenue NW"` (347 rows). The post-directional joins the suffix rather than
 *       becoming a tag of its own, because that is what the corpus adapter emits; there is no
 *       `street_postfix` tag to move it to.
 *   - **everything else is left folded** and reported. In particular a BARE post-directional tail
 *       ("Seymour East", "BROADWAY N" — 16 rows) is NOT split: a directional is not a Pub-28 suffix,
 *       and the observed rows in that class are unit-contaminated ("1ST AVE SW BOX E", where the
 *       trailing "E" is a box letter).
 *
 *   FR rows are untouched, deliberately and permanently as far as this tool is concerned. French
 *   street typology puts the type FIRST ("Rue de la Paix") and the golden labels only 7 of 665 FR
 *   street rows with a `street_prefix`; whether FR should split at all is a different question with
 *   a different table behind it, and nothing here should be read as having answered it.
 *
 *   ## Surface bytes
 *
 *   The split is a cut at a whitespace run in the ORIGINAL string — no trimming, no case
 *   normalization, no re-joining of tokens. `street + gap + street_suffix` reconstructs the input
 *   byte-for-byte, so the whitespace between them belongs to neither span (the same shape the corpus
 *   adapter's spans have). The tool asserts this per row and refuses to write a file if it ever
 *   fails.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { basename, join } from "node:path"

import { isStreetDirectionalToken, matchTrailingSuffix, type USStreetSuffix } from "@mailwoman/codex/us"
import { parseJSONStrict, tryParsingJSON } from "@mailwoman/core/objects"
import { sha256File } from "@mailwoman/core/utils"
import { TextSpliterator } from "spliterator"

// ── Types ──────────────────────────────────────────────────────────────────

/**
 * A golden-set row, as stored one-per-line in `us.jsonl` / `fr.jsonl` / `adversarial.jsonl`. Only the fields this tool
 * reads are modeled; every other key rides through untouched.
 */
export interface GoldenStreetRow {
	raw: string
	components: Record<string, string>
	country?: string
	source?: string
	notes?: string
	[key: string]: unknown
}

/**
 * What the tool decided about one row. Every value except the two `split-*` classes means "left folded".
 */
export type GoldenRelabelClass =
	| "split-suffix"
	| "split-suffix-postdirectional"
	| "split-prefix-only"
	| "already-split"
	| "single-token"
	| "suffix-only-street"
	| "postdirectional-tail-only"
	| "no-suffix-match"
	| "no-street"
	| "not-us"
	| "untrimmed-street"

/**
 * A review trigger on a row the tool DID change. A flag is never an adjudication — it marks the row for the operator's
 * deck, and the split is applied either way.
 */
export interface GoldenRelabelFlag {
	kind: "name-prone-suffix" | "venue-context" | "remainder-is-affix"
	detail: string
}

/**
 * Row-level relabel outcome.
 */
export interface GoldenRelabelResult {
	/**
	 * The row to write. Identical object reference when nothing changed.
	 */
	row: GoldenStreetRow
	changed: boolean
	rowClass: GoldenRelabelClass
	flags: GoldenRelabelFlag[]
	/**
	 * A leading directional was lifted into `street_prefix` on this row.
	 */
	prefixSplit: boolean
	/**
	 * The street span as it stood in the parent version — recorded for the review deck.
	 */
	beforeStreet?: string
}

// ── The name-prone suffix set ──────────────────────────────────────────────

/**
 * Pub-28 canonicals that are also ordinary head nouns of PROPER NAMES — "Lincoln Park", "Boston Common", "Willow
 * Brook". A split on one of these is still applied (the table is the table), but the row lands in the review deck
 * because the trailing word may belong to the name rather than to the street type.
 *
 * Chosen against the surfaces this golden set actually carries (park 6, green 5, hill 7, heights 3, hollow 3, brook 3,
 * pass 3 — the whole flagged class is 60 rows of 1,906), not from the whole 200-entry table: flagging every possible
 * name-head would mark a third of the corrections and stop being a review artifact.
 */
const NAME_PRONE_SUFFIXES: ReadonlySet<USStreetSuffix> = new Set<USStreetSuffix>([
	"BEACH",
	"BROOK",
	"BROOKS",
	"CAMP",
	"CENTER",
	"CENTERS",
	"CLUB",
	"COMMON",
	"COMMONS",
	"CREEK",
	"CROSSING",
	"ESTATE",
	"ESTATES",
	"FIELD",
	"FIELDS",
	"FOREST",
	"GARDEN",
	"GARDENS",
	"GLEN",
	"GREEN",
	"GREENS",
	"GROVE",
	"GROVES",
	"HARBOR",
	"HEIGHTS",
	"HILL",
	"HILLS",
	"HOLLOW",
	"ISLAND",
	"ISLANDS",
	"ISLE",
	"JUNCTION",
	"LAKE",
	"LAKES",
	"LANDING",
	"MALL",
	"MANOR",
	"MEADOW",
	"MEADOWS",
	"MILL",
	"MILLS",
	"MISSION",
	"ORCHARD",
	"PARK",
	"PASS",
	"PLAZA",
	"POINT",
	"POINTS",
	"RANCH",
	"RIDGE",
	"SHORE",
	"SHORES",
	"SPRING",
	"SPRINGS",
	"SQUARE",
	"STATION",
	"SUMMIT",
	"VALLEY",
	"VIEW",
	"VIEWS",
	"VILLAGE",
	"VISTA",
])

// ── Byte-exact tail split ──────────────────────────────────────────────────

interface TailSplit {
	head: string
	gap: string
	tail: string
}

/**
 * Cut `s` at its LAST whitespace run, returning the three pieces verbatim. Null when there is no interior whitespace,
 * when the head would be empty, or when `s` carries leading/trailing whitespace (a golden row is stored trimmed; an
 * untrimmed one is reported rather than silently normalized).
 */
function splitLastWord(s: string): TailSplit | null {
	if (s !== s.trim() || !s) return null
	const match = /^(.*\S)(\s+)(\S+)$/.exec(s)

	if (!match) return null

	return { head: match[1]!, gap: match[2]!, tail: match[3]! }
}

/**
 * Cut `s` at its FIRST whitespace run — the leading-directional counterpart of {@link splitLastWord}. `head` is the
 * first word, `tail` the rest, both verbatim.
 */
function splitFirstWord(s: string): TailSplit | null {
	if (s !== s.trim() || !s) return null
	const match = /^(\S+)(\s+)(\S.*)$/.exec(s)

	if (!match) return null

	return { head: match[1]!, gap: match[2]!, tail: match[3]! }
}

// ── Row-level relabel ──────────────────────────────────────────────────────

/**
 * Rebuild `components` with `street_suffix` inserted immediately after `street`, so the written row reads in address
 * order rather than with the new tag appended at the end.
 */
function withStreetSpans(
	components: Record<string, string>,
	spans: { prefix?: string; street: string; suffix?: string }
): Record<string, string> {
	const out: Record<string, string> = {}

	for (const [key, value] of Object.entries(components)) {
		if (key === "street") {
			if (spans.prefix) {
				out.street_prefix = spans.prefix
			}

			out.street = spans.street

			if (spans.suffix) {
				out.street_suffix = spans.suffix
			}

			continue
		}

		if (key === "street_prefix" || key === "street_suffix") continue
		out[key] = value
	}

	return out
}

/**
 * Options for {@linkcode relabelGoldenStreetRow}.
 */
export interface RelabelStreetRowOptions {
	/**
	 * Also lift a folded LEADING directional out into `street_prefix`. Default true.
	 *
	 * On by default because the fold cuts both ways and the answer key has to be corrected on both, or the correction is
	 * not a correction: 207 of the 1,682 split dev rows (12.3%) still opened with a directional after the suffix move —
	 * "N Desmet Avenue" would have graded `street: "N Desmet"` against a model that says `street_prefix: "N", street:
	 * "Desmet"`. Turn it OFF only to measure what the prefix fold alone costs.
	 */
	splitPrefix?: boolean
}

/**
 * Decide, and apply, the US street-span split for ONE golden row. Pure: never mutates its argument, and returns the
 * same object reference when the row is left alone.
 */
export function relabelGoldenStreetRow(
	row: GoldenStreetRow,
	options: RelabelStreetRowOptions = {}
): GoldenRelabelResult {
	const splitPrefix = options.splitPrefix ?? true

	const keep = (rowClass: GoldenRelabelClass): GoldenRelabelResult => ({
		row,
		changed: false,
		rowClass,
		flags: [],
		prefixSplit: false,
	})

	if ((row.country ?? "").toUpperCase() !== "US") return keep("not-us")
	const street = row.components.street

	if (!street) return keep("no-street")

	if (row.components.street_suffix) return keep("already-split")

	if (street !== street.trim()) return keep("untrimmed-street")

	const flags: GoldenRelabelFlag[] = []
	let rowClass: GoldenRelabelClass
	let name = street
	let suffix: string | undefined
	let suffixGap = ""
	let canonical: USStreetSuffix | undefined

	const cut = splitLastWord(street)

	if (!cut) {
		rowClass = matchTrailingSuffix(street) ? "suffix-only-street" : "single-token"
	} else if (isStreetDirectionalToken(cut.tail)) {
		// Street type + post-directional ("Pennsylvania Avenue NW"). The corpus adapter emits the pair as
		// ONE suffix span, and there is no post-directional tag to move it to.
		const inner = splitLastWord(cut.head)
		const typeMatch = inner ? matchTrailingSuffix(inner.tail) : null

		if (!inner || !typeMatch) {
			rowClass = "postdirectional-tail-only"
		} else {
			rowClass = "split-suffix-postdirectional"
			name = inner.head
			suffix = `${inner.tail}${cut.gap}${cut.tail}`
			suffixGap = inner.gap
			canonical = typeMatch.canonical
		}
	} else {
		const typeMatch = matchTrailingSuffix(street)

		if (!typeMatch) {
			rowClass = "no-suffix-match"
		} else {
			rowClass = "split-suffix"
			name = cut.head
			suffix = cut.tail
			suffixGap = cut.gap
			canonical = typeMatch.canonical
		}
	}

	// Leading directional → street_prefix, on whatever name survived the suffix move. Independent of the
	// suffix branch, because "N Main" is as folded as "N Main St" is.
	let prefix: string | undefined
	let prefixGap = ""

	if (splitPrefix && !row.components.street_prefix) {
		const lead = splitFirstWord(name)

		if (lead && isStreetDirectionalToken(lead.head)) {
			prefix = lead.head
			prefixGap = lead.gap
			name = lead.tail
		}
	}

	if (!suffix && !prefix) return keep(rowClass)

	if (!suffix) {
		rowClass = "split-prefix-only"
	}

	// The invariant this tool exists to keep: the spans plus the whitespace between them ARE the original
	// span, byte for byte. Anything else means a token was rewritten.
	const rebuilt = `${prefix ? prefix + prefixGap : ""}${name}${suffix ? suffixGap + suffix : ""}`

	if (rebuilt !== street) {
		throw new Error(`golden-relabel: span reconstruction failed for ${JSON.stringify(street)}`)
	}

	if (canonical && NAME_PRONE_SUFFIXES.has(canonical)) {
		flags.push({
			kind: "name-prone-suffix",
			detail: `${canonical} heads proper names as often as street types`,
		})
	}

	const venue = row.components.venue

	if (suffix && venue && new RegExp(`(^|\\W)${escapeRegExp(suffix)}(\\W|$)`, "i").test(venue)) {
		flags.push({
			kind: "venue-context",
			detail: `venue ${JSON.stringify(venue)} also carries ${JSON.stringify(suffix)}`,
		})
	}

	// Narrow on purpose: a name that happens to be a Pub-28 canonical is NOT interesting ("Mountain Rd",
	// "Valley Dr", "Mills Ln" are ordinary streets, and flagging them buried the deck — 108 rows of noise
	// on the first run). A name that is a bare DIRECTIONAL is: "East Rd" leaves `street: "East"`, which is
	// a direction, not a name.
	if (isStreetDirectionalToken(name)) {
		flags.push({
			kind: "remainder-is-affix",
			detail: `street would become the bare directional ${JSON.stringify(name)}`,
		})
	}

	return {
		row: {
			...row,
			components: withStreetSpans(row.components, {
				...(prefix ? { prefix } : row.components.street_prefix ? { prefix: row.components.street_prefix } : {}),
				street: name,
				...(suffix ? { suffix } : {}),
			}),
		},
		changed: true,
		rowClass,
		flags,
		prefixSplit: Boolean(prefix),
		beforeStreet: street,
	}
}

function escapeRegExp(s: string): string {
	return s.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

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
	mkdirSync(output, { recursive: true })

	const deck: GoldenRelabelDeckEntry[] = []
	const files: RelabelGoldenReport["files"] = {}

	const walk = (dirIn: string, dirOut: string, prefix: string): void => {
		mkdirSync(dirOut, { recursive: true })

		for (const name of readdirSync(dirIn, { withFileTypes: true })) {
			const from = join(dirIn, name.name)
			const to = join(dirOut, name.name)

			if (name.isDirectory()) {
				walk(from, to, `${prefix}${name.name}/`)

				continue
			}

			if (!name.name.endsWith(".jsonl")) {
				// MANIFEST is rewritten below; everything else (README, SPLIT-MANIFEST) rides forward.
				if (name.name !== "MANIFEST.json") {
					writeFileSync(to, readFileSync(from))
				}

				continue
			}

			const counts = EMPTY_COUNTS()
			let changed = 0
			let flagged = 0
			let prefixSplit = 0
			const out: string[] = []
			let lineNumber = 0

			for (const line of TextSpliterator.from(readFileSync(from, "utf8"))) {
				if (!line.trim()) continue

				lineNumber++
				// A corrupt answer-key line must STOP the relabel, not silently drop a row — a golden file
				// short by one row is a floor cut against a different denominator.
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

			writeFileSync(to, out.join("\n") + "\n")
			files[`${prefix}${name.name}`] = { entries: lineNumber, changed, flagged, prefixSplit, counts }

			report(
				`  ${prefix}${name.name}: ${lineNumber} rows, ${changed} changed (${prefixSplit} with a prefix lift), ${flagged} flagged`
			)
		}
	}

	report(`relabel ${input} → ${output}`)
	walk(input, output, "")

	writeFileSync(deckPath, deck.map((entry) => JSON.stringify(entry)).join("\n") + "\n")
	writeFileSync(deckPath.replace(/\.jsonl$/, ".md"), renderDeckMarkdown(deck, basename(input), basename(output)))

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

	writeFileSync(join(output, "MANIFEST.json"), JSON.stringify(manifest, null, "\t") + "\n")
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
			.filter(Boolean)
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
export function goldenDeclaresSplitStreets(dir: string): boolean {
	for (const candidate of [join(dir, "MANIFEST.json"), join(dir, "..", "MANIFEST.json")]) {
		if (!existsSync(candidate)) continue

		const manifest = tryParsingJSON<{ convention?: { street_convention?: Record<string, string> } }>(
			readFileSync(candidate, "utf8")
		)

		if (manifest?.convention?.street_convention?.US === "split") return true
	}

	return false
}
