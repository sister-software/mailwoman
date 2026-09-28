/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The per-piece anchor feature layout is cross-language and must match the Python
 *   `anchor_feature_vector` byte-for-byte, since a wrong locale order or centroid scale feeds the
 *   model garbage.
 */

import { stringifyJSON } from "@mailwoman/core/json"
import type { PathBuilderLike } from "path-ts"

import { LOCALE_COUNTRIES as LOCALE_ORDER } from "#labels"
import { collectMatches } from "#postcode/repair"
import type { TokenizedPiece } from "#tokenizer"

// The pinned class order lives in `#labels`, and this alias name is kept
// because the anchor feature layout indexes it.
export { LOCALE_COUNTRIES as LOCALE_ORDER } from "#labels"

/**
 * Anchor feature width = posterior over the locale set + a 2-d centroid.
 */
export const ANCHOR_FEATURE_DIM = LOCALE_ORDER.length + 2

/**
 * One postcode's anchor record (from the pilot lookup): country posterior + a single centroid.
 */
export interface AnchorEntry {
	posterior: Record<string, number>
	lat: number
	lon: number
}

export type AnchorLookup = Map<string, AnchorEntry>

/**
 * Builds the fixed-width anchor feature vector mirroring Python's `anchor_feature_vector`: the in-set
 * country posterior renormalized over {@linkcode LOCALE_ORDER}, plus a `lat/90`, `lon/180` centroid.
 */
export function anchorFeatureVector(posterior: Record<string, number>, lat: number, lon: number): number[] {
	const vec = new Array<number>(ANCHOR_FEATURE_DIM).fill(0)
	let total = 0

	for (const [country, weight] of Object.entries(posterior)) {
		const idx = LOCALE_ORDER.indexOf(country.toUpperCase() as (typeof LOCALE_ORDER)[number])

		if (idx !== -1) {
			vec[idx] = weight
			total += weight
		}
	}

	if (total > 0) {
		for (let i = 0; i < LOCALE_ORDER.length; i++) {
			vec[i]! /= total
		}
	}

	vec[LOCALE_ORDER.length] = Math.max(-1, Math.min(1, lat / 90))
	vec[LOCALE_ORDER.length + 1] = Math.max(-1, Math.min(1, lon / 180))

	return vec
}

/**
 * Parses the pilot postcode→anchor lookup JSON (`{postcode: [posterior, lat, lon, source?]}`)
 * into a Map, taking the parsed object rather than a path so this module stays browser-safe.
 */
export function parseAnchorLookup(
	raw: Record<string, [Record<string, number>, number, number, (string | null)?]>
): AnchorLookup {
	const out: AnchorLookup = new Map()

	for (const [pc, [posterior, lat, lon]] of Object.entries(raw)) {
		out.set(pc, { posterior, lat, lon })
	}

	return out
}

/**
 * `alnum-run` scans `[A-Za-z0-9]+` runs and so can never key a space-joined postcode
 * (`SW1A 2AA`), while `shaped` takes the postcode-shaped spans from {@linkcode collectMatches}
 * and keys them `span.replace(" ", "").toUpperCase()` like the train painter.
 */
export type AnchorSpanMode = "alnum-run" | "shaped"

/**
 * The GB unit-postcode key shape, space-stripped (`SW1A2AA`), used only to derive
 * the outward code for the fallback below.
 */
const GB_UNIT_KEY = /^[A-Z]{1,2}\d[A-Z\d]?\d[A-Z]{2}$/

/**
 * Ascii-only uppercase is used rather than `toUpperCase()` because the match offsets index
 * into `text` and `String.prototype.toUpperCase` is not length-preserving (`ß` → `SS`),
 * which would shift every subsequent span and paint the anchor onto the wrong pieces.
 */
function asciiUpper(text: string): string {
	return text.replaceAll(/[a-z]/g, (c) => c.toUpperCase())
}

/**
 * Length of a GB inward code (`2AA`); the outward district is the rest of the key.
 */
const GB_INWARD_LENGTH = 3

/**
 * Merges per-binary anchor lookups by unioning the country posteriors per postcode and meaning
 * the centroids, treating a `(0,0)` centroid as a placeholder that is never averaged in.
 */
export function mergeAnchorLookups(lookups: readonly AnchorLookup[]): AnchorLookup {
	if (lookups.length === 1) return lookups[0]!
	const merged: AnchorLookup = new Map()

	for (const lookup of lookups) {
		for (const [postcode, entry] of lookup) {
			const existing = merged.get(postcode)

			if (!existing) {
				merged.set(postcode, { posterior: { ...entry.posterior }, lat: entry.lat, lon: entry.lon })

				continue
			}

			for (const country of Object.keys(entry.posterior)) {
				existing.posterior[country] = 1
			}

			if (entry.lat !== 0 || entry.lon !== 0) {
				if (existing.lat === 0 && existing.lon === 0) {
					existing.lat = entry.lat
					existing.lon = entry.lon
				} else {
					existing.lat = (existing.lat + entry.lat) / 2
					existing.lon = (existing.lon + entry.lon) / 2
				}
			}
		}
	}

	return merged
}

export function countShapedOnlyKeys(lookup: AnchorLookup): number {
	let count = 0

	for (const key of lookup.keys()) {
		if (GB_UNIT_KEY.test(key)) {
			count++

			if (count >= SHAPED_ONLY_KEY_SCAN_LIMIT) break
		}
	}

	return count
}

/**
 * The scan cap for {@linkcode countShapedOnlyKeys}.
 *
 * The error message needs to say only whether any keys exist and roughly how many.
 */
export const SHAPED_ONLY_KEY_SCAN_LIMIT = 1000

/**
 * Returns the ship-obligation message when a lookup carries GB unit keys that a
 * card without `span_mode: "shaped"` can never reach.
 *
 * The one artifact-pairing check a runtime can make, since the mode itself is
 * unobservable from the ONNX graph.
 */
export function shapedKeyerObligationViolation(
	lookup: AnchorLookup | undefined,
	spanMode: AnchorSpanMode | undefined,
	anchorSourcePath: PathBuilderLike | undefined
): string | null {
	if (!lookup || spanMode === "shaped") return null
	const shapedOnly = countShapedOnlyKeys(lookup)

	if (!shapedOnly) return null
	const magnitude = shapedOnly >= SHAPED_ONLY_KEY_SCAN_LIMIT ? `≥${SHAPED_ONLY_KEY_SCAN_LIMIT}` : String(shapedOnly)

	return (
		`the loaded anchor lookup${anchorSourcePath ? ` (${anchorSourcePath})` : ""} carries ${magnitude} GB unit keys, ` +
		`which the DEFAULT alnum-run scan can never produce — a GB unit is written with a space, so the scan probes ` +
		`"SW1A" and "2AA", never "SW1A2AA". The model-card declares \`requires.anchor.span_mode\` = ` +
		`${stringifyJSON(spanMode ?? null)}, so those keys are dead and the channel feeds zeros on exactly the rows ` +
		`the lookup exists for. Declare "requires": { "anchor": { "required": true, "span_mode": "shaped" } } on a ` +
		`card whose model TRAINED that way (the v4.2.0-base-anchor-v2 recipe's SHIP OBLIGATION), or ship a lookup ` +
		`without unit keys.`
	)
}

/**
 * One-shot latch for {@linkcode warnShapedKeyerObligationOnce}, since a mispackaged
 * bundle is a property of the artifact set worth saying once per process.
 */
let warnedShapedObligation = false

/**
 * Emits {@linkcode shapedKeyerObligationViolation} at most once per process from
 * `buildSoftFeatures`, the only site holding both the loaded lookup and the card-declared mode,
 * so it covers every construction path rather than only a loader-side one.
 */
export function warnShapedKeyerObligationOnce(
	lookup: AnchorLookup | undefined,
	spanMode: AnchorSpanMode | undefined,
	anchorSourcePath: PathBuilderLike | undefined
): void {
	if (warnedShapedObligation) return
	const violation = shapedKeyerObligationViolation(lookup, spanMode, anchorSourcePath)

	if (!violation) return
	warnedShapedObligation = true

	console.error(`[mailwoman/neural] ${violation}`)
}

export interface BuildAnchorFeaturesOptions {
	/**
	 * Span-collection mode, defaulting to `alnum-run` — the shipped behavior.
	 */
	spanMode?: AnchorSpanMode
}

/**
 * Projects per-piece anchor features onto `pieces` by the same char→piece rule the labels use —
 * a piece takes the anchor of the postcode span its first non-whitespace char falls inside.
 */
export function buildAnchorFeatures(
	text: string,
	pieces: ReadonlyArray<TokenizedPiece>,
	lookup: AnchorLookup,
	options: BuildAnchorFeaturesOptions = {}
): { features: number[][]; confidence: number[] } {
	const features: number[][] = pieces.map(() => new Array<number>(ANCHOR_FEATURE_DIM).fill(0))
	const confidence: number[] = pieces.map(() => 0)

	/**
	 * Paint `[spanBegin, spanEnd)` with `entry`'s vector.
	 *
	 * Shared by both modes so they can only ever differ in where they paint,
	 * never in what they paint or how it lands on pieces — the same guarantee the
	 * train side gets from sharing `_paint_anchor_chars`.
	 */
	const paint = (spanBegin: number, spanEnd: number, entry: AnchorEntry): void => {
		const vec = anchorFeatureVector(entry.posterior, entry.lat, entry.lon)

		for (let i = 0; i < pieces.length; i++) {
			const p = pieces[i]!

			for (let c = p.start; c < p.end; c++) {
				if (c < text.length && !/\s/.test(text[c]!)) {
					if (c >= spanBegin && c < spanEnd) {
						features[i] = vec
						confidence[i] = 1
					}

					break // first non-whitespace char of the piece decides (mirrors realign_anchor_to_pieces)
				}
			}
		}
	}

	if (options.spanMode === "shaped") {
		for (const match of collectMatches(asciiUpper(text))) {
			// The train painter's normalization verbatim — uppercased with literal spaces removed.
			// `normalizePostcode` instead collapses `\s+` runs and drops a `D-` prefix.
			const key = text.slice(match.start, match.end).replaceAll(" ", "").toUpperCase()
			let entry = lookup.get(key)

			// An unknown GB unit still anchors from its outward district, painting the whole unit span
			// so the painted extent matches what a known unit would have produced.
			if (!entry && GB_UNIT_KEY.test(key)) {
				entry = lookup.get(key.slice(0, -GB_INWARD_LENGTH))
			}

			if (entry) {
				paint(match.start, match.end, entry)
			}
		}

		return { features, confidence }
	}

	const tokenRe = /[A-Za-z0-9]+/g
	let m: RegExpExecArray | null

	while ((m = tokenRe.exec(text)) !== null) {
		const entry = lookup.get(m[0].toUpperCase())

		if (!entry) continue

		paint(m.index, m.index + m[0].length, entry)
	}

	return { features, confidence }
}
