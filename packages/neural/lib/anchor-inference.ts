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

import type { PathBuilderLike } from "path-ts"

import { LOCALE_COUNTRIES as LOCALE_ORDER } from "#labels"
import { collectMatches } from "#postcode/repair"
import type { TokenizedPiece } from "#tokenizer"

// The pinned class order lives in labels.ts (`LOCALE_COUNTRIES`); this module keeps its historical
// export name for the anchor feature layout that indexes it.
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
 *   against a shipped model it is a no-op, because no shaped GB/NL span will resolve. The shape SCAN runs over an
 *   ASCII-uppercased copy of the text ({@linkcode asciiUpper}) — see #1512 there — so the register cannot silently cost
 *   the channel. The KEY is unchanged.
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
 * ASCII-only uppercase — the case fold the shaped keyer runs before shape DETECTION (#1512).
 *
 * The defect it closes: `POSTCODE_PATTERNS`' alphanumeric shapes require `[A-Z]` by design (they must not match
 * lowercase prose), so `collectMatches` finds NOTHING in the raw lowercase register. Measured on the 120-row gb-golden
 * board: 106/120 rows yield a shaped span as-written and UPPERCASE, **0/120** lowercase. The default parse path is
 * saved only by `normalizeInputCase` (#690/#829) restoring the postcode's case first — every GB letter run is ≤2
 * characters, so `restoreLowerInput` uppercases all of them. A `normalizeCase: false` parse gets no such rescue and
 * loses the entire GB/NL anchor channel silently, and lowercase is the USER register.
 *
 * WHY ASCII-ONLY, and not `toUpperCase()`. The match offsets index into `text`, and `String.prototype.toUpperCase` is
 * not length-preserving (`ß` → `SS`, `ﬁ` → `FI`): one such character upstream of a postcode shifts every subsequent
 * span and the anchor paints the wrong pieces. Folding `[a-z]` in place cannot change length, and every character the
 * alphanumeric patterns care about is ASCII anyway. Same reasoning, and the same guard, as `case-normalize.ts`.
 *
 * WHY THE FOLD IS ON DETECTION ONLY. The KEY was always uppercased (`span.replaceAll(" ", "").toUpperCase()`, the train
 * painter's normalization verbatim); it is the shape SCAN that was register-sensitive. Folding for the scan and keying
 * off the original text leaves the key byte-identical, so nothing about which lookup entry wins changes.
 */
function asciiUpper(text: string): string {
	return text.replaceAll(/[a-z]/g, (c) => c.toUpperCase())
}

/**
 * Length of a GB inward code (`2AA`); the outward district is the rest of the key.
 */
const GB_INWARD_LENGTH = 3

/**
 * How many of `lookup`'s keys the DEFAULT `alnum-run` scan can never reach — the SHIP OBLIGATION check (A2 of
 * ROAD_TO_V9 §1, from the `v4.2.0-base-anchor-v2` recipe header).
 *
 * The class is concrete, not hypothetical. A GB unit key is written with a space in every real address (`SW1A 2AA`), so
 * the alnum-run scan sees `SW1A` and `2AA` and can NEVER produce the `SW1A2AA` the train painter keys. Every such key
 * in a loaded lookup is therefore dead weight under `alnum-run` — 1,746,976 of them in `pilot-anchor-lookup-v2`, which
 * is the entire point of that lookup. If a package ships one of these and its card does not declare `span_mode:
 * "shaped"`, the anchor channel is silently feeding zeros on exactly the rows the retrain was for.
 *
 * NOT counted: NL PC6 (`1012LG`) and every numeric system. Those are written glued at least some of the time, so the
 * alnum-run scan reaches them — their presence says nothing about the card's declaration.
 *
 * Cheap by construction: it stops at {@linkcode SHAPED_ONLY_KEY_SCAN_LIMIT} keys, because the caller only needs "any?"
 * and a magnitude to print, and a 1.7M-key Map is walked at every load.
 */
/**
 * Merge per-binary anchor lookups: union the country posteriors per postcode, mean the centroids. A `(0,0)` centroid is
 * a placeholder and never averaged in.
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

			// Average a real centroid in; ignore (0,0) placeholders.
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
 * Scan cap for {@linkcode countShapedOnlyKeys}. The answer is used as "any, and roughly how many" in an error message;
 * walking all 1,749,839 keys of the GB lookup to distinguish 1,000 from 1,746,976 buys nothing.
 */
export const SHAPED_ONLY_KEY_SCAN_LIMIT = 1000

/**
 * The SHIP OBLIGATION message for a card that omits `span_mode: "shaped"` while its package ships a lookup full of keys
 * only the shaped keyer can reach, or `null` when the pairing is coherent (A2 of ROAD_TO_V9 §1).
 *
 * This is the fail-closed for the ONE thing about `span_mode` a runtime can actually check. The mode itself is
 * unobservable from the ONNX graph — the inputs are identical either way — so the card is the only source of truth for
 * it, and a card that simply OMITS the field is indistinguishable from a legitimately-`alnum-run` bundle. What IS
 * observable is the artifact PAIRING: a lookup carrying GB unit keys next to a card that cannot reach them has no
 * legitimate reading and the exact shape a v4.2.0 promote would ship if the card were copied forward unchanged.
 *
 * `createScorer` throws on it (fail closed, the eval path); `loadFromWeights` warns once (tolerant by contract).
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
		`${JSON.stringify(spanMode ?? null)}, so those keys are dead and the channel feeds zeros on exactly the rows ` +
		`the lookup exists for. Declare "requires": { "anchor": { "required": true, "span_mode": "shaped" } } on a ` +
		`card whose model TRAINED that way (the v4.2.0-base-anchor-v2 recipe's SHIP OBLIGATION), or ship a lookup ` +
		`without unit keys.`
	)
}

/**
 * One-shot latch for {@linkcode warnShapedKeyerObligationOnce}. A mispackaged bundle is a property of the ARTIFACT SET,
 * so it is worth saying once per process and pointless to repeat per load — the same posture the unfed-channel warnings
 * take in `classifier.ts`.
 */
let warnedShapedObligation = false

/**
 * {@linkcode shapedKeyerObligationViolation}, emitted at most once per process. The TOLERANT half of the A2 pair:
 * `createScorer` throws on the same condition (the eval path fails closed), while a runtime parse says it once and
 * carries on — the loader contract this package has always had for a mis-shipped channel.
 *
 * Called from `buildSoftFeatures`, not from a loader, and that placement is the point: it is the only site where the
 * loaded lookup and the card-declared mode are both in hand, so it covers every construction path (the Node loader, the
 * browser loader, a harness assembling a classifier by hand) rather than the single one a loader-side check would
 * catch. The latch keeps the per-parse cost at a boolean read.
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
		for (const match of collectMatches(asciiUpper(text))) {
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
