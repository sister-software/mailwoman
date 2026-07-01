/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Build a street-morphology FST from libpostal's street_types dictionaries. The morphology FST maps
 *   street-typing affixes (Street/Avenue/rue/Calle/Straße/...) to a single synthetic placetype
 *   `"street_affix"` — distinct from the admin FST in source data, intent, and binary artifact.
 *
 *   The morphology FST closes the inference-time vacuum identified by the v0.6.1 postmortem: street
 *   tokens have no admin-FST anchor, so synth-street training pushed the model toward over-emitting
 *   `dependent_locality` on subcomponents. With the morphology FST, the neural decoder gets
 *   positive evidence for street-typing affixes and the adjacent name tokens, plus negative
 *   evidence away from `dependent_locality` on the same neighbours.
 *
 *   Design rationale + the four-layer street-supplement architecture lives in
 *   `docs/articles/concepts/street-supplement-architecture.md`.
 *
 *   Source: `core/data/libpostal/dictionaries/{locale}/street_types.txt`. Each line is pipe-delimited
 *   surface forms with the canonical form first: avenue|av|ave|aven|avenu|avn|avnu|avnue
 *
 *   Output: an `FSTMatcher` ready to serialize via `serializeFST` to e.g.
 *   `fst-street-morphology.bin`.
 */

import { readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"

import type { FSTNode } from "./fst-matcher.js"
import { FSTMatcher, normalizeTokens } from "./fst-matcher.js"
import type { FSTProvenance, PlaceEntry } from "./fst-types.js"

/**
 * Reserved synthetic wofID base for street-morphology entries. 32-bit unsigned, well above any realistic WOF
 * allocation. Reusing the same base across rebuilds keeps IDs stable for any consumer that caches them. See
 * [[project-schema-storage-decision]] for the reserved range policy.
 */
const STREET_AFFIX_WOFID_BASE = 1_900_000_000

const STREET_TYPES_FILENAME = "street_types.txt"

export interface BuildStreetMorphologyFSTOpts {
	/** Path to the `core/data/libpostal/dictionaries` directory containing per-locale subfolders. */
	dictionariesDir: string
	/**
	 * Optional locale filter — only ingest these locale subfolders. Defaults to all that have a `street_types.txt`.
	 */
	locales?: string[]
	/**
	 * Minimum length (in characters, post-normalization) of variant surface forms to insert into the trie. Defaults to 3.
	 *
	 * Rationale: libpostal's street_types dictionaries contain 1-2 character abbreviations (`a`, `b`, `av`, `bd`, `br`,
	 * ...) that collide with non-affix tokens at parse time — notably US state abbreviations (`OR`, `CA`, `ND`, `NY`),
	 * single-letter unit designators, and arbitrary short tokens. Empirically these collisions push the morphology prior
	 * to mis-tag state abbreviations as `street_suffix`. A minimum length of 3 retains useful forms (`ave`, `blvd`,
	 * `rue`, `str`) while filtering out the noise.
	 */
	minVariantLength?: number
	/** Optional progress callback. */
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
 * Parse one `street_types.txt` line into `{ canonical, variants }`. Canonical is the first token (pre-`|`); variants
 * are all whitespace-stripped non-empty tokens including the canonical.
 *
 * Lines with no `|` are treated as a single-form entry where canonical == variant.
 */
function parseLine(line: string): { canonical: string; variants: string[] } | null {
	const trimmed = line.trim()

	if (trimmed.length === 0 || trimmed.startsWith("#")) return null
	const parts = trimmed
		.split("|")
		.map((s) => s.trim())
		.filter((s) => s.length > 0)

	if (parts.length === 0) return null

	return { canonical: parts[0]!, variants: parts }
}

export function buildStreetMorphologyFST(opts: BuildStreetMorphologyFSTOpts): BuildStreetMorphologyFSTResult {
	const progress = opts.onProgress ?? (() => {})
	const minVariantLength = opts.minVariantLength ?? 3

	// Discover locales — either provided explicitly, or all directories containing street_types.txt.
	let locales: string[]

	if (opts.locales && opts.locales.length > 0) {
		locales = opts.locales
	} else {
		locales = readdirSync(opts.dictionariesDir).filter((entry) => {
			const localePath = join(opts.dictionariesDir, entry)

			if (!statSync(localePath).isDirectory()) return false

			try {
				statSync(join(localePath, STREET_TYPES_FILENAME))

				return true
			} catch {
				return false
			}
		})
	}
	progress("discover", `Found ${locales.length} locales with ${STREET_TYPES_FILENAME}`)

	// Collect canonical → set-of-variants across all locales. Same canonical form may appear in
	// multiple locales (e.g. "avenue" in en/fr); we union the variant sets.
	const canonicalToVariants = new Map<string, Set<string>>()

	for (const locale of locales) {
		const filePath = join(opts.dictionariesDir, locale, STREET_TYPES_FILENAME)
		const content = readFileSync(filePath, "utf8")

		for (const line of content.split("\n")) {
			const parsed = parseLine(line)

			if (!parsed) continue
			const existing = canonicalToVariants.get(parsed.canonical) ?? new Set<string>()

			for (const variant of parsed.variants) existing.add(variant)
			canonicalToVariants.set(parsed.canonical, existing)
		}
	}
	progress("collect", `Collected ${canonicalToVariants.size} canonical affixes`)

	// Assign stable synthetic wofIDs. Sort canonicals for determinism.
	const sortedCanonicals = [...canonicalToVariants.keys()].sort()
	const canonicalToWOFID = new Map<string, number>()

	for (let i = 0; i < sortedCanonicals.length; i++) {
		canonicalToWOFID.set(sortedCanonicals[i]!, STREET_AFFIX_WOFID_BASE + i)
	}

	// Build the trie. Each variant is inserted as a token sequence pointing to its canonical's
	// PlaceEntry — so all variants of "avenue" (av/ave/aven/...) lead to the same terminal entry.
	const nodes: FSTNode[] = [{ edges: new Map(), places: [] }]

	function insertName(tokens: string[], entry: PlaceEntry): void {
		if (tokens.length === 0) return
		let stateId = 0

		for (const t of tokens) {
			const node = nodes[stateId]!
			let next = node.edges.get(t)

			if (next === undefined) {
				next = nodes.length
				nodes.push({ edges: new Map(), places: [] })
				node.edges.set(t, next)
			}
			stateId = next
		}
		const existing = nodes[stateId]!.places

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
			// Fixed importance: street affixes are structurally unambiguous (Avenue is almost never
			// anything but street-typing). The morphology prior caps bias separately; this value
			// just feeds the cap formula `importance * cap`.
			importance: 1.0,
			lat: 0,
			lon: 0,
		}

		for (const variant of variants) {
			const tokens = normalizeTokens(variant)

			if (tokens.length === 0) continue
			// Filter out collision-prone short surface forms — see `minVariantLength` docstring.
			// We measure against the joined token form (no spaces) since FST keys are token sequences.
			const joined = tokens.join("")

			if (joined.length < minVariantLength) continue
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
		sourceDb: opts.dictionariesDir,
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
