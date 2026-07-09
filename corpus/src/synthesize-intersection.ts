/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Intersection synthesizer — v0.7 coverage fix (night-3, DeepSeek-decided).
 *
 *   The 2026-05-29 harness diagnostic found the neural model emits `intersection_a`/`intersection_b`
 *   with ~0.0001 probability on canonical intersections ("Broadway & W 42nd St") — it never learned
 *   the tags, because the corpus has NO intersection training signal (no generator, and real-data
 *   adapters don't emit intersection-formatted rows). Intersections are 65 of the 376 harness
 *   assertions (17%), all 0% neural. This generator produces the missing signal as a small targeted
 *   supplement shard (synthesis-as-supplement discipline: weight < 0.25, one-and-done).
 *
 *   Output is a `CanonicalRow` ({raw, components}); the corpus aligner turns it into BIO labels
 *   (B-/I-intersection_a, O on the connector, B-/I-intersection_b). Surface forms of both streets
 *   MUST occur verbatim in `raw` so alignment lands.
 *
 *   US-idiomatic only (the harness intersection cases are US: "X & Y, City, ST ZIP").
 */

import type { CanonicalRow } from "./types.ts"

/** Street name cores (no suffix) — proper-noun streets that often appear bare. */
const STREET_CORES = [
	"Main",
	"Oak",
	"Elm",
	"Maple",
	"Pine",
	"Cedar",
	"Park",
	"Lake",
	"Hill",
	"Washington",
	"Lincoln",
	"Jefferson",
	"Madison",
	"Franklin",
	"Market",
	"Broad",
	"Church",
	"Mill",
	"Highland",
	"Sunset",
	"Union",
	"Spring",
] as const

/** Bare proper-noun streets that idiomatically take NO suffix. */
const BARE_NAMES = ["Broadway", "Wall", "Bourbon", "Esplanade", "Riverside", "Lakeshore"] as const

const ORDINALS = [
	"1st",
	"2nd",
	"3rd",
	"4th",
	"5th",
	"6th",
	"7th",
	"8th",
	"9th",
	"10th",
	"42nd",
	"23rd",
	"34th",
] as const

const SUFFIXES = ["St", "Ave", "Blvd", "Rd", "Dr", "Ln", "Way", "Pl", "Ct", "Pkwy", "Ter", "Cir"] as const

const DIRECTIONALS = ["N", "S", "E", "W", "NE", "NW", "SE", "SW"] as const

/**
 * Connectors between the two streets. Whitespace-padded forms keep tokens clean for alignment. `@` added in v0.7.2 —
 * the harness uses it ("Main St @ Second Ave") and v0.7.1 had never seen it.
 */
const CONNECTORS = [" & ", " and ", " at ", " / ", " @ "] as const

export interface IntersectionBaseTuple {
	locality: string
	region: string
	/** ZIP — optional; ~30% of synthetic intersections omit it (idiomatic). */
	postcode?: string
	country: string
}

export interface SynthesizedIntersectionRow {
	raw: string
	components: CanonicalRow["components"]
	locale: string
}

export interface IntersectionSynthesisOpts {
	random?: () => number
}

function pick<T>(arr: ReadonlyArray<T>, random: () => number): T {
	return arr[Math.floor(random() * arr.length)]!
}

/** Build a single street surface form, e.g. "W 42nd St", "Broadway", "Main St", "N Oak Ave". */
function buildStreetName(random: () => number): string {
	// ~20% bare proper-noun street (no suffix), else directional? + core/ordinal + suffix.
	if (random() < 0.2) return pick(BARE_NAMES, random)

	const parts: string[] = []

	if (random() < 0.35) {
		parts.push(pick(DIRECTIONALS, random))
	}
	parts.push(random() < 0.45 ? pick(ORDINALS, random) : pick(STREET_CORES, random))
	parts.push(pick(SUFFIXES, random))

	return parts.join(" ")
}

/**
 * Synthesize one US intersection row. Returns null on the rare degenerate case where the two streets collide (so
 * alignment never has two identical surface forms to disambiguate).
 */
export function synthesizeIntersectionRow(
	base: IntersectionBaseTuple,
	opts: IntersectionSynthesisOpts = {}
): SynthesizedIntersectionRow | null {
	const random = opts.random ?? Math.random

	if (base.country !== "US") return null

	const a = buildStreetName(random)
	let b = buildStreetName(random)
	// Ensure distinct surface forms (and not a substring of each other — alignment needs unambiguous spans).
	let tries = 0

	while ((b === a || a.includes(b) || b.includes(a)) && tries++ < 8) {
		b = buildStreetName(random)
	}

	if (b === a || a.includes(b) || b.includes(a)) return null

	const connector = pick(CONNECTORS, random)
	// "corner of" prefix variant (~20%) — still labels the two streets identically.
	const cornerPrefix = random() < 0.2 ? "corner of " : ""

	const components: CanonicalRow["components"] = { intersection_a: a, intersection_b: b }

	// v0.7.2: ~60% BARE (no locality tail). v0.7.1 always appended ", City, ST", so the model learned
	// to read post-intersection text as a locality and fumbled the harness's bare "X & Y" cases
	// (mislabeling the second street as a locality). Match the eval distribution.
	const bare = random() < 0.6
	let raw: string

	if (bare) {
		raw = `${cornerPrefix}${a}${connector}${b}`
	} else {
		const includePostcode = base.postcode != null && random() < 0.7
		const tail = includePostcode
			? `, ${base.locality}, ${base.region} ${base.postcode}`
			: `, ${base.locality}, ${base.region}`
		raw = `${cornerPrefix}${a}${connector}${b}${tail}`
		components.locality = base.locality
		components.region = base.region

		if (includePostcode) {
			components.postcode = base.postcode
		}
	}

	return { raw, components, locale: "en-US" }
}

/** A small built-in US city/region/zip pool for standalone shard generation + tests. */
export const DEFAULT_US_BASES: ReadonlyArray<IntersectionBaseTuple> = [
	{ locality: "New York", region: "NY", postcode: "10036", country: "US" },
	{ locality: "Chicago", region: "IL", postcode: "60613", country: "US" },
	{ locality: "Los Angeles", region: "CA", postcode: "90012", country: "US" },
	{ locality: "Seattle", region: "WA", postcode: "98109", country: "US" },
	{ locality: "Austin", region: "TX", postcode: "78701", country: "US" },
	{ locality: "Portland", region: "OR", postcode: "97205", country: "US" },
	{ locality: "Denver", region: "CO", postcode: "80202", country: "US" },
	{ locality: "Boston", region: "MA", postcode: "02116", country: "US" },
	{ locality: "Miami", region: "FL", postcode: "33130", country: "US" },
	{ locality: "Atlanta", region: "GA", postcode: "30303", country: "US" },
]

/** Generate `count` intersection rows over the provided bases (round-robin). */
export function generateIntersectionRows(
	count: number,
	bases: ReadonlyArray<IntersectionBaseTuple> = DEFAULT_US_BASES,
	opts: IntersectionSynthesisOpts = {}
): SynthesizedIntersectionRow[] {
	const random = opts.random ?? Math.random
	const out: SynthesizedIntersectionRow[] = []
	let guard = 0

	while (out.length < count && guard++ < count * 4) {
		const base = bases[out.length % bases.length]!
		const row = synthesizeIntersectionRow(base, { random })

		if (row) {
			out.push(row)
		}
	}

	return out
}
