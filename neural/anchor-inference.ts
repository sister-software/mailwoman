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
 *
 *   The layout matched; the SPAN COLLECTION did not (2026-08-05,
 *   `docs/records/evals/2026-08-05-en-gb-anchor-off.md`). Train keys a postcode as
 *   `raw[begin:end].replace(" ", "").upper()` over a shape-detected span, so a GB unit enters the
 *   lookup as `SW1A2AA`. Inference scanned `[A-Za-z0-9]+` runs, which can never produce a key
 *   spanning a space — `SW1A 2AA` was probed as `SW1A` and `2AA`. Nothing caught it because every
 *   shipped lookup held DE/FR/US five-digit keys only, where the two rules agree exactly.
 *   {@linkcode AnchorSpanMode} is the fix, and it is OPT-IN: `shaped` changes what the encoder sees,
 *   so it lands with the retrain that widened the lookup, not before.
 */

import { collectMatches } from "./postcode-repair.ts"
import type { TokenizedPiece } from "./tokenizer.ts"

/**
 * The locale class order — MUST match Python `mailwoman_train/labels.py::LOCALE_COUNTRIES`. The posterior occupies
 * indices `[0, LOCALE_ORDER.length)`; the normalized centroid the last two. (Pinned by the test; do not reorder.)
 */
export const LOCALE_ORDER = ["US", "FR", "DE", "CA", "GB", "JP", "ES", "IT", "NL"] as const

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
 * Build the fixed-width anchor feature vector — the exact mirror of Python `anchor_feature_vector`: a uniform country
 * posterior over {@linkcode LOCALE_ORDER} (renormalized over the in-set mass) + a normalized centroid (`lat/90`,
 * `lon/180` ∈ [-1, 1]).
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
 * Parse the pilot postcode→anchor lookup JSON (`{postcode: [posterior, lat, lon, source?]}`) into a Map. The optional
 * trailing `source` is the centroid's provenance label (#525 — `"wof"`, `"census-zcta-2024"`, or `null` for a
 * placeholder); build-side bookkeeping, ignored at inference. Pure (takes the parsed object, not a path) so this module
 * stays browser-safe — the file read lives in the Node-side caller (the eval).
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
 * How {@linkcode buildAnchorFeatures} decides WHICH substrings to look up.
 *
 * - `alnum-run` — every `[A-Za-z0-9]+` run in the text, uppercased. The shipped behaviour, and structurally incapable of
 *   producing a key that contains a space-joined pair: `SW1A 2AA` is scanned as `SW1A` then `2AA`, never as the
 *   `SW1A2AA` the train painter writes. Every model shipped to date was trained against a DE/FR/US-only lookup whose
 *   keys are all five digits, so this never mattered — no space-containing postcode had a key.
 * - `shaped` — the postcode-SHAPED spans from {@linkcode collectMatches} (`neural/postcode-repair.ts`), keyed the way
 *   `mailwoman_train/tokenizer.py::_paint_anchor_chars` keys them: `span.replace(" ", "").toUpperCase()`. This is the
 *   TRAIN-PARITY mode. Pair it with a lookup that has letter-bearing keys and a model trained on both; on its own
 *   against a shipped model it is a no-op, because no shaped GB/NL span will resolve.
 *
 * The train painter's shape source is `mailwoman_train/postcode_shapes.py::collect_matches`, a declared verbatim mirror
 * of `collectMatches`. It is not quite verbatim today: the TS list carries an IE Eircode pattern the Python list lacks.
 * That costs nothing while no IE key exists in any lookup (a shaped span that misses paints nothing, exactly as at
 * train), but the two lists must be reconciled before an IE postcode source is added.
 */
export type AnchorSpanMode = "alnum-run" | "shaped"

/**
 * The GB unit-postcode key shape, space-stripped (`SW1A2AA`). Used only to derive the outward code for the fallback
 * below — the inward half is always the trailing three characters.
 */
const GB_UNIT_KEY = /^[A-Z]{1,2}\d[A-Z\d]?\d[A-Z]{2}$/

/**
 * Length of a GB inward code (`2AA`); the outward district is the rest of the key.
 */
const GB_INWARD_LENGTH = 3

export interface BuildAnchorFeaturesOptions {
	/**
	 * Span-collection mode. Defaults to `alnum-run` — the shipped behaviour, byte-identical to the pre-2026-08-05 path.
	 */
	spanMode?: AnchorSpanMode
}

/**
 * Per-piece anchor features + confidence for `text`, projected onto its SP `pieces` by the SAME char→piece rule the
 * labels use (a piece takes the anchor of the postcode span its first non-whitespace char falls inside) — so the anchor
 * lands on exactly the postcode's sub-tokens.
 *
 * Which substrings count as postcode spans is {@linkcode AnchorSpanMode}'s job. A recognized span yields a
 * confidence-1.0 anchor, like training's gold-span. Returns `(pieces × ANCHOR_FEATURE_DIM)` features + `(pieces,)`
 * confidence.
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
	 * Paint `[spanBegin, spanEnd)` with `entry`'s vector. Shared by both modes so they can only ever differ in WHERE they
	 * paint, never in WHAT they paint or HOW it lands on pieces — the same guarantee the train side gets from sharing
	 * `_paint_anchor_chars`.
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
		for (const match of collectMatches(text)) {
			// The train painter's normalization VERBATIM: literal spaces removed, uppercased. Not `\s+`,
			// not the `D-` strip `normalizePostcode` does — those would diverge from what trained.
			const key = text.slice(match.start, match.end).replaceAll(" ", "").toUpperCase()
			let entry = lookup.get(key)

			// Outward fallback: an unknown GB unit (a new-build code, or an NI `BT` code Code-Point Open
			// does not carry) still anchors from its district — and paints the WHOLE unit span, not just
			// the outward half, so the painted extent matches what a known unit would have produced.
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
