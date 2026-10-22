/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Build a street-morphology FST from libpostal's street_types dictionaries. The morphology FST maps
 *   street-typing affixes (Street/Avenue/rue/Calle/Straße/...) to a single synthetic placetype
 *   `"street_affix"`. Its source data and purpose differ from the admin FST.
 *   It also produces a separate binary artifact.
 *
 *   The morphology FST closes the inference-time vacuum identified by the v0.6.1 postmortem: street
 *   tokens have no admin-FST anchor, so synth-street training pushed the model toward over-emitting
 *   `dependent_locality` on subcomponents. With the morphology FST, the neural decoder gets
 *   positive evidence for street-typing affixes and the adjacent name tokens, plus negative
 *   evidence away from `dependent_locality` on the same neighbors.
 *
 *   Design rationale + the four-layer street-supplement architecture lives in
 *   `docs/articles/concepts/street-supplement-architecture.md`.
 *
 *   Source: `dictionaries/data/libpostal/dictionaries/{locale}/street_types.txt`. Each line is pipe-delimited
 *   surface forms with the canonical form first: avenue|av|ave|aven|avenu|avn|avnu|avnue
 *
 *   Output: an `FSTMatcher` ready to serialize via `serializeFST` to e.g.
 *   `fst-street-morphology.bin`.
 */

import { AU_STATE_ABBREVIATIONS } from "@mailwoman/codex/au/state"
import { CA_PROVINCES } from "@mailwoman/codex/ca/province"
import { US_STATE_ABBREVIATIONS } from "@mailwoman/codex/us/state"
import { readLocalTextFile } from "@mailwoman/core/fs/readers"
import { isDirectory, isFile } from "@mailwoman/core/fs/readers/stat"
import { PathBuilder, type PathBuilderLike } from "path-ts"
import { TextSpliterator } from "spliterator"
import { Globerator } from "spliterator/node/fs"

import type { FSTNode } from "#fst/matcher"
import { FSTMatcher, normalizeTokens } from "#fst/matcher"
import type { FSTProvenance, PlaceEntry } from "#fst/types"

/**
 * Reserved synthetic wofID base for street-morphology entries. 32-bit unsigned,
 * well above any realistic WOF allocation.
 *
 * The same base across rebuilds keeps IDs stable for consumers that cache them.
 * See [[project-schema-storage-decision]] for the reserved range policy.
 */
const STREET_AFFIX_WOFID_BASE = 1_900_000_000

const STREET_TYPES_FILENAME = "street_types.txt"

/**
 * The region abbreviations the codex holds, in the lower-case joined form the trie keys use.
 *
 * A street-type variant that spells one of these is excluded from the trie by default.
 */
export const REGION_ABBREVIATION_VARIANTS: ReadonlySet<string> = new Set(
	[...US_STATE_ABBREVIATIONS, ...Object.keys(AU_STATE_ABBREVIATIONS), ...Object.keys(CA_PROVINCES)].map((code) =>
		code.toLowerCase()
	)
)

export interface BuildStreetMorphologyFSTOpts {
	/**
	 * Path to the `dictionaries/data/libpostal/dictionaries` directory containing per-locale subfolders.
	 */
	dictionariesDir: PathBuilderLike
	/**
	 * Optional locale filter — only ingest these locale subfolders.
	 *
	 * @defaultValue all that have a `street_types.txt`.
	 */
	locales?: string[]
	/**
	 * Minimum length (in characters, post-normalization) of variant surface forms to insert into the trie.
	 *
	 * libpostal's street_types dictionaries hold one-character variants (`a`, `b`, `c`) that collide
	 * with unit designators and single letters at parse time, so the default admits two characters
	 * and more: `st`, `rd`, `av`, `dr`, `ln`, `pl` and `sq` beside `ave`, `blvd`, `rue` and `str`.
	 * The two-character variants that are a region abbreviation go through {@link excludedVariants}.
	 *
	 * @defaultValue `2`
	 */
	minVariantLength?: number
	/**
	 * Variant surface forms, in joined post-normalization form, that the trie never holds.
	 *
	 * A two-character street type that is also a region abbreviation, `ct` for court
	 * and Connecticut or `la` for lane and Louisiana, reads as the region at parse time.
	 * The artifact is locale-general, so the variant stays out for every locale.
	 *
	 * @defaultValue {@link REGION_ABBREVIATION_VARIANTS}, the codex's US state, Australian state and
	 *   Canadian province abbreviations
	 */
	excludedVariants?: ReadonlySet<string>
	/**
	 * Optional progress callback.
	 */
	onProgress?: (phase: string, detail?: string) => void
}

export interface BuildStreetMorphologyFSTResult {
	matcher: FSTMatcher
	provenance: FSTProvenance
	canonicalCount: number
	variantCount: number
	insertCount: number
	locales: string[]
}

/**
 * Parse one `street_types.txt` line into `{ canonical, variants }`.
 *
 * Canonical is the first token (pre-`|`); variants are all whitespace-stripped
 * non-empty tokens including the canonical.
 *
 * Lines with no `|` are treated as a single-form entry where canonical == variant.
 */
function parseLine(line: string): { canonical: string; variants: string[] } | null {
	const trimmed = line.trim()

	if (!trimmed || trimmed.startsWith("#")) return null

	const parts = TextSpliterator.from(trimmed, { delimiter: "|" }).toArray()

	if (!parts.length) return null

	return { canonical: parts[0]!, variants: parts }
}

export async function buildStreetMorphologyFST(
	opts: BuildStreetMorphologyFSTOpts
): Promise<BuildStreetMorphologyFSTResult> {
	const progress = opts.onProgress ?? (() => {})
	const minVariantLength = opts.minVariantLength ?? 2
	const excludedVariants = opts.excludedVariants ?? REGION_ABBREVIATION_VARIANTS
	const dictionariesDir = PathBuilder.from(opts.dictionariesDir)

	// Discover locales — either provided explicitly, or all directories containing street_types.txt.
	let locales: string[]

	// oxlint-disable-next-line unicorn/prefer-ternary -- the else branch is a multi-line directory scan
	if (opts.locales && opts.locales.length) {
		locales = opts.locales
	} else {
		const entries = await Globerator.from("*", {
			cwd: dictionariesDir,
			absolute: false,
			onlyFiles: false,
		}).toArray()

		const localeProbes: Array<[string, boolean]> = []

		for (const entry of entries) {
			const localePath = dictionariesDir(entry)

			if (!(await isDirectory(localePath))) {
				localeProbes.push([entry, false])

				continue
			}

			localeProbes.push([entry, await isFile(localePath(STREET_TYPES_FILENAME))])
		}

		locales = localeProbes.filter(([, hasFile]) => hasFile).map(([entry]) => entry)
	}

	progress("discover", `Found ${locales.length} locales with ${STREET_TYPES_FILENAME}`)

	// Collect canonical → set-of-variants across all locales.
	// Same canonical form may appear in multiple locales (e.g. "avenue" in en/fr); we union the variant sets.
	const canonicalToVariants = new Map<string, Set<string>>()

	for (const locale of locales) {
		const filePath = dictionariesDir(locale, STREET_TYPES_FILENAME)
		const content = await readLocalTextFile(filePath)

		for (const line of TextSpliterator.from(content)) {
			const parsed = parseLine(line)

			if (!parsed) continue
			const existing = canonicalToVariants.get(parsed.canonical) ?? new Set<string>()

			for (const variant of parsed.variants) {
				existing.add(variant)
			}

			canonicalToVariants.set(parsed.canonical, existing)
		}
	}

	progress("collect", `Collected ${canonicalToVariants.size} canonical affixes`)

	// Assign stable synthetic wofIDs.
	// Sort canonicals for determinism.
	const sortedCanonicals = [...canonicalToVariants.keys()].toSorted()
	const canonicalToWOFID = new Map<string, number>()

	for (let i = 0; i < sortedCanonicals.length; i++) {
		canonicalToWOFID.set(sortedCanonicals[i]!, STREET_AFFIX_WOFID_BASE + i)
	}

	// Build the trie.
	// Each variant is inserted as a token sequence pointing to its canonical's PlaceEntry —
	// so all variants of "avenue" (av/ave/aven/...) lead to the same terminal entry.
	const nodes: FSTNode[] = [{ edges: new Map(), places: [] }]

	function insertName(tokens: string[], entry: PlaceEntry): void {
		if (!tokens.length) return
		let stateID = 0

		for (const t of tokens) {
			const node = nodes[stateID]!
			let next = node.edges.get(t)

			if (!next) {
				next = nodes.length
				nodes.push({ edges: new Map(), places: [] })
				node.edges.set(t, next)
			}

			stateID = next
		}

		const existing = nodes[stateID]!.places

		if (!existing.some((p) => p.wofID === entry.wofID && p.placetype === entry.placetype)) {
			existing.push(entry)
		}
	}

	let insertCount = 0
	let variantCount = 0

	for (const canonical of sortedCanonicals) {
		const variants = canonicalToVariants.get(canonical)!
		const wofID = canonicalToWOFID.get(canonical)!

		const entry: PlaceEntry = {
			wofID,
			placetype: "street_affix",
			name: canonical,
			parentChain: [],
			// Fixed referential score: street affixes are structurally unambiguous
			// (Avenue is almost never anything but street-typing).
			// The morphology prior caps bias separately.
			// This value only feeds the cap formula `referential * cap`.
			// No encyclopedic score — a street affix is not a place and has no article.
			referential: 1,
			encyclopedic: null,
			lat: 0,
			lon: 0,
			crossCountryBranches: null,
		}

		for (const variant of variants) {
			const tokens = normalizeTokens(variant)

			if (!tokens.length) continue
			// The length and the exclusions read the joined token form, since FST keys are token sequences.
			const joined = tokens.join("")

			if (joined.length < minVariantLength || excludedVariants.has(joined)) continue
			insertName(tokens, entry)

			insertCount++

			variantCount++
		}
	}

	progress("trie", `Built trie: ${nodes.length} states, ${insertCount} variant insertions`)

	const edgeCount = nodes.reduce((sum, n) => sum + n.edges.size, 0)
	const matcher = FSTMatcher.fromNodes(nodes)

	const provenance: FSTProvenance = {
		builtAt: new Date().toISOString(),
		countries: locales, // Reuse `countries` slot for locale provenance — semantics differ from admin FST.
		stateCount: nodes.length,
		placeCount: sortedCanonicals.length,
		edgeCount,
		nameInsertions: insertCount,
		importanceMatches: 0, // No importance scoring for morphology — fixed at 1.0.
		encyclopedicMatches: null,
		importanceSource: null,
		sourceDB: dictionariesDir.toString(),
		sourceDBMD5: null,
		sourceDBBytes: null,
		modelCardVersion: null,
		exclusionPolicy: null,
		excludedInsertions: null,
	}

	return {
		matcher,
		provenance,
		canonicalCount: sortedCanonicals.length,
		variantCount,
		insertCount,
		locales,
	}
}
