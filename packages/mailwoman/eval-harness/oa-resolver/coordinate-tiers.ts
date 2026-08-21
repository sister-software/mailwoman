/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file The coordinate tiers a run grades — which lookups to open, and the postcode-anchor reads that sit between the
 *   admin centroid and the street-level point.
 */

import { dataRootPath, mailwomanDataRoot } from "@mailwoman/core/utils"
import type { AddressPointLookup, InterpolationLookup } from "@mailwoman/resolver"

import type { ShardProvider } from "../../geocode-core.ts"
import type { OAResolverEvalOptions } from "./options.ts"

/**
 * The postcode shard reader the anchor extractor probes — the WOF postcode lookup's structural contract, named here so
 * the eval never has to import the SQLite class it only ever holds by reference.
 */
export interface PostcodeCentroidLookup {
	lookup(pc: string): Array<{ country: string; lat: number; lon: number }>
	close(): void
}

/**
 * The postcode-anchor extractor, loaded dynamically because the anchor rows are opt-in.
 */
export type ExtractPostcodeAnchors = typeof import("@mailwoman/neural/postcode-anchor").extractPostcodeAnchors

/**
 * Wire up the coordinate tiers this run grades, from the flags that select them.
 *
 * Each tier answers WHERE, never WHICH PLACE: every `neural+<tier>` arm keeps neural's admin match and replaces only
 * the coordinate, so the delta between arms isolates exactly what the tier sharpens. `--cascade` supersedes the
 * single-state `--address-points`/`--interpolation` flags with per-row, per-state shard selection through a
 * ShardProvider.
 */
export async function buildCoordinateTiers(options: OAResolverEvalOptions) {
	// Postcode-anchor fusion (opt-in via `--postcode-anchor`). The resolver supplies the admin/place
	// identity, but its coordinate is the place CENTROID — legitimately tens of km from edge addresses.
	// The postcode anchor supplies the postcode's OWN centroid, the finer tier between admin-centroid and
	// street. The `neural+anchor` row keeps neural's admin match but takes the COORDINATE from the anchor
	// when it has a placed candidate for the eval's country, else falls back to the resolver coord. So the
	// row isolates exactly what the anchor sharpens: where, not which place.
	// `--address-points <db>` (#476): the street-level exact-point tier. Adds `addressPoints` to
	// resolveOpts; the `neural+addrpt` row keeps neural's admin flags but takes the COORDINATE from
	// the address-point hit when present (the tier's whole contribution is "where", street-level).
	const addressPointsDB = options.addressPoints || ""
	let addressPoints: AddressPointLookup | null = null

	if (addressPointsDB) {
		const { AddressPointSqliteLookup } = await import("@mailwoman/resolver-wof-sqlite")
		addressPoints = new AddressPointSqliteLookup(addressPointsDB)
	}

	// `--interpolation <segments-db>` (#483): the house-number interpolation tier (StreetInterpolator,
	// tiger-range). Adds `interpolation` to resolveOpts; the `neural+interp` row takes the COORDINATE
	// from the exact point when present, else the interpolated estimate, else the admin centroid — the
	// full street-level coordinate cascade. The delta vs `neural+addrpt` is interpolation's lift on the
	// long tail of valid-but-unlisted numbers the exact tier misses.
	const interpolationDB = options.interpolation || ""
	let interpolation: InterpolationLookup | null = null

	if (interpolationDB) {
		const { StreetInterpolator } = await import("@mailwoman/resolver-wof-sqlite")
		interpolation = new StreetInterpolator({ dbPath: interpolationDB })
	}

	// `--cascade` (#718 situs-eval): grade the PRODUCTION coordinate path (mailwoman/geocode-core.ts) —
	// per-row, per-state situs + interpolation shards via ShardProvider — so the eval reports the SHIPPED
	// coordinate (address_point > interpolated > admin) across ALL states, not the admin centroid the
	// neural headline alone reports. The diagnostic that motivated this: the headline read 3.3 km p50 /
	// 10 km p90 (admin centroid) while the production cascade over the same rows is ~0 m p50 / 1 km p90,
	// 85.9% within 100 m — the eval simply wasn't grading what ships. The single-state
	// --address-points/--interpolation flags still work for a one-state run; --cascade supersedes them
	// with multi-state per-row selection. --data-root locates the shards (<root>/address-points/,
	// <root>/interpolation/).
	const cascadeOn = options.cascade ?? false
	const dataRoot = options.dataRoot || mailwomanDataRoot()
	let cascadeProvider: ShardProvider | null = null

	if (cascadeOn) {
		const { ShardProvider } = await import("../../geocode-core.ts")
		const { AddressPointSqliteLookup, StreetInterpolator } = await import("@mailwoman/resolver-wof-sqlite")
		cascadeProvider = new ShardProvider({ AddressPointSqliteLookup, StreetInterpolator }, dataRoot)
	}

	// The addrpt + interp arms run when EITHER a single-state shard was given OR --cascade is on.
	const runAddrPt = !!addressPoints || cascadeOn
	const runInterp = !!interpolation || cascadeOn
	const useAnchor = options.postcodeAnchor ?? false
	// `--anchor-rerank` (#369 S8): feed the postcode anchor's country posterior into the resolver's
	// locality re-rank (`ResolveOpts.anchorPosterior`), to measure whether the merged re-ranker pulls
	// resolves into the right country's polygon when no locale gate is set (`--default-country none`).
	const anchorRerank = options.anchorRerank ?? false

	let postcodeLookup: PostcodeCentroidLookup | null = null
	let extractAnchors: ExtractPostcodeAnchors | null = null

	if (useAnchor || anchorRerank) {
		const shards = (
			options.postcodeShards ||
			`${dataRootPath("wof", "postalcode-us.db")},${dataRootPath("wof", "postalcode-intl.db")}`
		)
			.split(",")
			.map((s) => s.trim())

		const { WOFPostcodeLookup } = await import("@mailwoman/resolver-wof-sqlite")
		postcodeLookup = new WOFPostcodeLookup(shards)
		extractAnchors = (await import("@mailwoman/neural/postcode-anchor")).extractPostcodeAnchors
	}

	return {
		addressPoints,
		interpolation,
		cascadeProvider,
		dataRoot,
		cascadeOn,
		runAddrPt,
		runInterp,
		useAnchor,
		anchorRerank,
		postcodeLookup,
		extractAnchors,
	}
}

/**
 * The postcode-anchor reads' inputs. `minConfidence` is the floor below which the anchor's coordinate is not trusted
 * over the resolver's: a penalized house-number span scores ~0.2 (single-country times the house-number penalty) while
 * a genuinely ambiguous real code scores at least 0.52 (valid in three countries or fewer), so a 0.5 floor keeps the
 * latter and rejects the former — a span the position prior reads as a house number falls back to the resolver's
 * coordinate (the right city centroid) instead of placing the address at a far-away same-shaped ZIP.
 */
export interface AnchorSources {
	postcodeLookup: PostcodeCentroidLookup | null
	extractAnchors: ExtractPostcodeAnchors | null
	minConfidence: number
	preferCountry: string
}

/**
 * The postcode anchor's centroid for a raw address, preferring the run's `defaultCountry`.
 */
export function anchorCoordinateFor(input: string, sources: AnchorSources): { lat: number; lon: number } | null {
	const { postcodeLookup, extractAnchors, minConfidence, preferCountry } = sources

	if (!postcodeLookup || !extractAnchors) return null
	const prefer = (preferCountry && preferCountry.toLowerCase() !== "none" ? preferCountry : "").toUpperCase()
	// Pick the placed span with the HIGHEST position-aware confidence, above the trust floor. The
	// anchor down-weights a digit-only code that shares its segment with a street word (`12345 Main
	// St` reads as a house number, not a postcode), so a real trailing postcode (`… City, ST 90210`)
	// out-ranks an earlier house number on its own merit — no "take the last span" crutch needed.
	// Ties break toward the later span (the postcode trails the locality in a rendered address).
	let best: { lat: number; lon: number; conf: number; start: number } | null = null

	for (const a of extractAnchors(input, postcodeLookup)) {
		if (a.confidence < minConfidence) continue
		const placed = a.candidates.filter((c) => c.lat !== 0 || c.lon !== 0)

		if (!placed.length) continue
		// When the eval fixes a country, accept ONLY a placed candidate from it — never fall back to
		// another country's centroid (a US ZIP that is coordless here but a valid 5-digit shape in
		// DE/FR/IT must not borrow Europe's point). With no country fixed, take the first placed.
		const pick = prefer ? placed.find((c) => c.country.toUpperCase() === prefer) : placed[0]

		if (!pick) continue

		if (!best || a.confidence > best.conf || (a.confidence === best.conf && a.span.start >= best.start)) {
			best = { lat: pick.lat, lon: pick.lon, conf: a.confidence, start: a.span.start }
		}
	}

	return best ? { lat: best.lat, lon: best.lon } : null
}

/**
 * The postcode anchor's country posterior for a raw address (highest-confidence placed anchor), fed into the resolver's
 * locality re-rank via `ResolveOpts.anchorPosterior` (#369 S8).
 */
export function anchorCountryPosteriorFor(input: string, sources: AnchorSources): Record<string, number> | undefined {
	const { postcodeLookup, extractAnchors } = sources

	if (!postcodeLookup || !extractAnchors) return undefined
	let best: { posterior: Record<string, number>; conf: number } | null = null

	for (const a of extractAnchors(input, postcodeLookup)) {
		if (!a.candidates.length) continue

		if (!best || a.confidence > best.conf) {
			best = { posterior: a.posterior, conf: a.confidence }
		}
	}

	return best?.posterior
}
