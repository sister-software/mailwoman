/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Inference-side postcode-anchor features (#239/#240) — the mirror of the Python training pipeline
 *   (`mailwoman_train/tokenizer.py::anchor_feature_vector` + `realign_anchor_to_pieces`). At
 *   inference the model conditions on per-piece anchor features fed alongside `input_ids`; this
 *   builds them from a raw address + its SentencePiece pieces, using the SAME postcode→anchor
 *   lookup the model trained against (`scripts/build-pilot-anchor-lookup.ts`), so the feature
 *   layout matches byte-for-byte.
 *
 *   The layout is ESSENTIAL and cross-language: a wrong locale order or centroid scale feeds the
 *   model garbage. `anchor-inference.test.ts` pins both `LOCALE_ORDER` and the vector to values
 *   emitted by the Python `anchor_feature_vector` — any drift fails the test.
 */

import type { TokenizedPiece } from "./tokenizer.js"

/**
 * The locale class order — MUST match Python `mailwoman_train/labels.py::LOCALE_COUNTRIES`. The
 * posterior occupies indices `[0, LOCALE_ORDER.length)`; the normalized centroid the last two.
 * (Pinned by the test; do not reorder.)
 */
export const LOCALE_ORDER = ["US", "FR", "DE", "CA", "GB", "JP", "ES", "IT", "NL"] as const

/** Anchor feature width = posterior over the locale set + a 2-d centroid. */
export const ANCHOR_FEATURE_DIM = LOCALE_ORDER.length + 2

/** One postcode's anchor record (from the pilot lookup): country posterior + a single centroid. */
export interface AnchorEntry {
	posterior: Record<string, number>
	lat: number
	lon: number
}

export type AnchorLookup = Map<string, AnchorEntry>

/**
 * Build the fixed-width anchor feature vector — the exact mirror of Python `anchor_feature_vector`:
 * a uniform country posterior over {@linkcode LOCALE_ORDER} (renormalized over the in-set mass) + a
 * normalized centroid (`lat/90`, `lon/180` ∈ [-1, 1]).
 */
export function anchorFeatureVector(posterior: Record<string, number>, lat: number, lon: number): number[] {
	const vec = new Array<number>(ANCHOR_FEATURE_DIM).fill(0)
	let total = 0
	for (const [country, weight] of Object.entries(posterior)) {
		const idx = LOCALE_ORDER.indexOf(country.toUpperCase() as (typeof LOCALE_ORDER)[number])
		if (idx >= 0) {
			vec[idx] = weight
			total += weight
		}
	}
	if (total > 0) {
		for (let i = 0; i < LOCALE_ORDER.length; i++) vec[i]! /= total
	}
	vec[LOCALE_ORDER.length] = Math.max(-1, Math.min(1, lat / 90))
	vec[LOCALE_ORDER.length + 1] = Math.max(-1, Math.min(1, lon / 180))
	return vec
}

/**
 * Parse the pilot postcode→anchor lookup JSON (`{postcode: [posterior, lat, lon, source?]}`) into a
 * Map. The optional trailing `source` is the centroid's provenance label (#525 — `"wof"`,
 * `"census-zcta-2024"`, or `null` for a placeholder); build-side bookkeeping, ignored at inference.
 * Pure (takes the parsed object, not a path) so this module stays browser-safe — the file read
 * lives in the Node-side caller (the eval).
 */
export function parseAnchorLookup(
	raw: Record<string, [Record<string, number>, number, number, (string | null)?]>
): AnchorLookup {
	const out: AnchorLookup = new Map()
	for (const [pc, [posterior, lat, lon]] of Object.entries(raw)) out.set(pc, { posterior, lat, lon })
	return out
}

/**
 * Per-piece anchor features + confidence for `text`, projected onto its SP `pieces` by the SAME
 * char→piece rule the labels use (a piece takes the anchor of the postcode span its first
 * non-whitespace char falls inside) — so the anchor lands on exactly the postcode's sub-tokens.
 *
 * Postcode spans are the alphanumeric runs in `text` that the lookup recognizes (gold-equivalent on
 * clean rendered addresses); a recognized span yields a confidence-1.0 anchor, like training's
 * gold-span. Returns `(pieces × ANCHOR_FEATURE_DIM)` features + `(pieces,)` confidence.
 */
export function buildAnchorFeatures(
	text: string,
	pieces: ReadonlyArray<TokenizedPiece>,
	lookup: AnchorLookup
): { features: number[][]; confidence: number[] } {
	const features: number[][] = pieces.map(() => new Array<number>(ANCHOR_FEATURE_DIM).fill(0))
	const confidence: number[] = pieces.map(() => 0)

	const tokenRe = /[A-Za-z0-9]+/g
	let m: RegExpExecArray | null
	while ((m = tokenRe.exec(text)) !== null) {
		const entry = lookup.get(m[0].toUpperCase())
		if (!entry) continue
		const spanBegin = m.index
		const spanEnd = m.index + m[0].length
		const vec = anchorFeatureVector(entry.posterior, entry.lat, entry.lon)
		for (let i = 0; i < pieces.length; i++) {
			const p = pieces[i]!
			for (let c = p.start; c < p.end; c++) {
				if (c < text.length && !/\s/.test(text[c]!)) {
					if (c >= spanBegin && c < spanEnd) {
						features[i] = vec
						confidence[i] = 1.0
					}
					break // first non-whitespace char of the piece decides (mirrors realign_anchor_to_pieces)
				}
			}
		}
	}
	return { features, confidence }
}
