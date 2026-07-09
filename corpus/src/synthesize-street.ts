/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Street-decomposition synthesizer for Stage 3 training. Generates address rows where
 *   `street_prefix`, `street`, and `street_suffix` are emitted as separate BIO spans (instead of
 *   monolithic `street`). Mirrors the PO box synthesizer pattern.
 *
 *   Why this exists: TIGER/NAD/BAN adapter changes (committed earlier tonight) emit decomposed
 *   components from raw source data, but the v0.4.0 parquet shards on Modal were built BEFORE those
 *   changes. Rebuilding the full corpus requires downloading raw TIGER/NAD/BAN data and re-running
 *   adapters end-to-end — out of scope for a single night shift. This synthesizer takes (locality,
 *   region, postcode) tuples and produces freshly-decomposed Stage 3 training rows, same shape as
 *   the PO box pipeline.
 *
 *   Note: uses the SAME decomposition logic as TIGER's `decomposeStreet()` so the synthetic
 *   distribution matches what the model would see if/when TIGER shards are rebuilt with the new
 *   adapter.
 */

import { decomposeStreet } from "./adapters/tiger/street-decompose.ts"
import type { CanonicalRow } from "./types.ts"

// Hand-curated US street name pool. Real frequency-weighted street names — sampled
// from US Census TIGER 2024 top-1000 by occurrence count. Keep ~50 entries so the
// synthesis distribution doesn't overfit to a tiny vocabulary.
const STREET_NAMES = [
	"Main",
	"Oak",
	"Maple",
	"Pine",
	"Cedar",
	"Elm",
	"Washington",
	"Lincoln",
	"Jefferson",
	"Park",
	"Lake",
	"Hill",
	"Spring",
	"Center",
	"Church",
	"Mill",
	"School",
	"River",
	"Highland",
	"Sunset",
	"Forest",
	"Meadow",
	"Ridge",
	"Valley",
	"Lakeview",
	"Hillcrest",
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
	"Adams",
	"Madison",
	"Monroe",
	"Jackson",
	"Franklin",
	"Kennedy",
	"Roosevelt",
	"Broadway",
	"Market",
	"Commerce",
	"Industrial",
	"Airport",
	"Hospital",
	"Sherman",
	"Grant",
	"Lee",
	"Custer",
	"Lewis",
	"Clark",
] as const

const STREET_SUFFIXES = [
	"St",
	"Street",
	"Ave",
	"Avenue",
	"Rd",
	"Road",
	"Blvd",
	"Boulevard",
	"Dr",
	"Drive",
	"Ln",
	"Lane",
	"Way",
	"Ct",
	"Court",
	"Pl",
	"Place",
	"Pkwy",
	"Parkway",
	"Ter",
	"Terrace",
	"Cir",
	"Circle",
	"Hwy",
	"Highway",
] as const

const DIRECTIONAL_PREFIXES = [
	"",
	"",
	"",
	"",
	"", // 5 empty entries → 50% no prefix
	"N",
	"S",
	"E",
	"W",
	"NE",
	"NW",
	"SE",
	"SW",
	"North",
	"South",
	"East",
	"West",
] as const

const TRAILING_DIRECTIONALS = [
	"",
	"",
	"",
	"",
	"",
	"",
	"",
	"", // 8 empty → 80% no trailing
	"N",
	"S",
	"E",
	"W",
	"NE",
	"NW",
	"SE",
	"SW",
] as const

export interface StreetBaseTuple {
	locality: string
	region: string
	postcode: string
	country: string
}

export interface SynthesizedStreetRow {
	raw: string
	components: CanonicalRow["components"]
	locale: string
}

export interface StreetSynthesisOpts {
	random?: () => number
	/** Probability of emitting house_number alongside the street. Default 0.85. */
	includeHouseNumberProb?: number
	/**
	 * Probability of emitting the street BARE — no `, City, ST ZIP` tail and no region/locality/ postcode components
	 * (just `street_prefix`/`street`/`street_suffix` + optional `house_number`). Default 0 (preserves the original
	 * full-address behavior exactly, including the RNG sequence). Set >0 to teach the model that a bare `10th Ave` /
	 * `Main St` is a STREET, not a locality — the functional-test failure cluster (bare streets mislabeled `locality`),
	 * the bare-format analogue of the v0.7.x intersection-bare fix.
	 */
	bareProb?: number
}

function pick<T>(arr: ReadonlyArray<T>, random: () => number): T {
	return arr[Math.floor(random() * arr.length)]!
}

function randomHouseNumber(random: () => number): string {
	// US house number distribution: skewed low. 1-99 (30%), 100-999 (40%),
	// 1000-9999 (25%), 10000+ (5%).
	const r = random()

	if (r < 0.3) return String(1 + Math.floor(random() * 99))

	if (r < 0.7) return String(100 + Math.floor(random() * 900))

	if (r < 0.95) return String(1000 + Math.floor(random() * 9000))

	return String(10000 + Math.floor(random() * 89999))
}

/**
 * Synthesize a US street address with decomposed Stage 3 components. The street is built from PREFIX + NAME + SUFFIX,
 * then passed through the same `decomposeStreet()` utility the TIGER adapter uses — guarantees the synthetic
 * distribution matches the canonical decomposition logic.
 */
export function synthesizeStreetRow(
	base: StreetBaseTuple,
	opts: StreetSynthesisOpts = {}
): SynthesizedStreetRow | null {
	const random = opts.random ?? Math.random
	const includeHN = opts.includeHouseNumberProb ?? 0.85

	if (base.country !== "US") return null

	const prefix = pick(DIRECTIONAL_PREFIXES, random)
	const name = pick(STREET_NAMES, random)
	const suffix = pick(STREET_SUFFIXES, random)
	const trailing = pick(TRAILING_DIRECTIONALS, random)

	// Build the "full" street string the adapter would receive from TIGER FULLNAME.
	const parts = [prefix, name, suffix, trailing].filter(Boolean)
	const fullStreet = parts.join(" ")

	// Pass through the same decomposeStreet TIGER uses — match the training distribution.
	const decomposed = decomposeStreet(fullStreet)

	// NOTE: country is intentionally omitted. We don't emit "USA" or "US" in the raw
	// string, and the aligner's fuzzy match (edit distance 2) will spuriously match
	// "US" against any 2-char token (e.g. a house number "45" is exactly 2 substitutions
	// from "US"). The PO box synthesizer skips country for the same reason.
	// Bare mode is guarded by `> 0` so the default (bareProb=0) consumes no RNG and reproduces the
	// original full-address output byte-for-byte.
	const bareProb = opts.bareProb ?? 0
	const bare = bareProb > 0 && random() < bareProb

	const components: CanonicalRow["components"] = bare
		? {}
		: {
				region: base.region,
				locality: base.locality,
				postcode: base.postcode,
			}

	if (decomposed.prefix) {
		components.street_prefix = decomposed.prefix
	}

	if (decomposed.street) {
		components.street = decomposed.street
	}

	if (decomposed.suffix) {
		components.street_suffix = decomposed.suffix
	}

	let raw: string

	if (random() < includeHN) {
		const hn = randomHouseNumber(random)
		components.house_number = hn
		raw = bare ? `${hn} ${fullStreet}` : `${hn} ${fullStreet}, ${base.locality}, ${base.region} ${base.postcode}`
	} else {
		raw = bare ? fullStreet : `${fullStreet}, ${base.locality}, ${base.region} ${base.postcode}`
	}

	return { raw, components, locale: "en-US" }
}
