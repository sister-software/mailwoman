/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Feature extraction for the #244 coarse-placer — a fastText-style hashed char-n-gram
 *   representation plus explicit Unicode-script presence tokens. Deterministic + pure (shared by
 *   training and the always-resident inference), zero deps. A string → a set of active feature
 *   indices in [0, FEATURE_DIM).
 *
 *   Why these features: script is the dominant coarse-geography signal (CJK→East Asia,
 *   Cyrillic→Eastern Europe, Arabic→MENA), and char n-grams separate WITHIN a script (Hangul→KR vs
 *   kana→JP vs Han-only→CN, or Dutch "straat" vs French "rue" within Latin). A linear model over
 *   both is a few hundred KB and runs in microseconds — the "always-resident, places the planet
 *   coarsely" tier.
 */

/**
 * The trained classes: the well-represented corpus countries, the #743 Overture-sourced EU expansion, and `OTHER` — the
 * explicit off-map class (milestone 2) trained on non-Latin/non-CJK scripts via outlier exposure, so the model learns
 * the edge of its competence and routes "probably off my loaded map" instead of a confident mis-placement. Index order
 * is the label id.
 *
 * The first 11 are the original v0.5.0-corpus countries. The next 16 (#743) are EU locales the placer previously
 * couldn't emit — ambiguous names there (FI "Helsinki", PL "Rybnik") landed off-continent in the population-first
 * candidate gazetteer because no country prior pinned them. They're trained from the Overture per-country addresses
 * theme (`build-dataset.mjs`), and they're pulled OUT of the Latin off-map OTHER outlier set
 * (`build-outlier-latin.mjs`) that used to teach PL/PT/CZ → OTHER. Widening the class set is the soft-prior lever; it
 * never hard-filters, so a neighbour confusion (DK↔NO, EE↔LT↔LV) still keeps resolution in-region, off the global-pop
 * attractors. Adding a class requires a retrain + a fresh artifact — the bundled meta.json carries its own `classes`,
 * so this constant only drives training (`train.mjs`), not inference.
 */
export const COARSE_CLASSES = [
	"US",
	"FR",
	"GB",
	"CN",
	"NL",
	"IT",
	"DE",
	"JP",
	"ES",
	"KR",
	"TW",
	"AT",
	"BE",
	"CH",
	"CZ",
	"DK",
	"EE",
	"FI",
	"HR",
	"LT",
	"LU",
	"LV",
	"NO",
	"PL",
	"PT",
	"SI",
	"SK",
	// #244/#928 AU expansion (2026-07-06): AU was unrepresentable (not in-map) AND its 4-digit postcode
	// is format-ambiguous, so no #928 format-prior lever applies — the placer is AU's only country
	// signal. Trained from the v0.9.2 G-NAF corpus shard (150k real Australian addresses).
	"AU",
	"OTHER",
] as const

export type CoarseClass = (typeof COARSE_CLASSES)[number]

/**
 * Hashed-feature dimensionality (2^16). Keeps the weight matrix small (28×65536 ≈ 1.8 MB int8) while collisions stay
 * tolerable for a linear bag-of-features model; the discriminative n-grams are few.
 */
export const FEATURE_DIM = 1 << 16

/**
 * Coarse Unicode-script buckets — strong priors the n-grams refine.
 */
const SCRIPTS = [
	"latin",
	"cjk",
	"cyrillic",
	"arabic",
	"greek",
	"hebrew",
	"devanagari",
	"thai",
	"digit",
	"other",
] as const

type Script = (typeof SCRIPTS)[number]

function scriptOf(cp: number): Script {
	if (cp >= 0x30 && cp <= 0x39) return "digit"

	if ((cp >= 0x41 && cp <= 0x5a) || (cp >= 0x61 && cp <= 0x7a) || (cp >= 0xc0 && cp <= 0x2_4f)) return "latin"

	if (
		(cp >= 0x30_40 && cp <= 0x30_ff) ||
		(cp >= 0x4e_00 && cp <= 0x9f_ff) ||
		(cp >= 0xac_00 && cp <= 0xd7_af) ||
		(cp >= 0x34_00 && cp <= 0x4d_bf)
	)
		return "cjk"

	if ((cp >= 0x4_00 && cp <= 0x5_2f) || (cp >= 0x2d_e0 && cp <= 0x2d_ff)) return "cyrillic"

	if ((cp >= 0x6_00 && cp <= 0x6_ff) || (cp >= 0x7_50 && cp <= 0x7_7f) || (cp >= 0xfb_50 && cp <= 0xfe_ff))
		return "arabic"

	if (cp >= 0x3_70 && cp <= 0x3_ff) return "greek"

	if (cp >= 0x5_90 && cp <= 0x5_ff) return "hebrew"

	if (cp >= 0x9_00 && cp <= 0x9_7f) return "devanagari"

	if (cp >= 0xe_00 && cp <= 0xe_7f) return "thai"

	return "other"
}

/**
 * FNV-1a → a feature bucket in [0, FEATURE_DIM).
 */
function bucket(s: string, salt: number): number {
	let h = (2_166_136_261 ^ salt) >>> 0

	for (let i = 0; i < s.length; i++) {
		h ^= s.charCodeAt(i)
		h = Math.imul(h, 16_777_619)
	}

	return (h >>> 0) % FEATURE_DIM
}

/**
 * Featurize an address into a deduped list of active feature indices: char 3/4/5-grams over the lowercased,
 * boundary-marked string + one presence token per Unicode script seen (+ the dominant script). Non-Latin characters are
 * PRESERVED (lowercasing only touches cased scripts).
 */
export function featurize(text: string): number[] {
	const norm = text.toLowerCase().replaceAll(/\s+/g, " ").trim()

	if (!norm) return []
	const active = new Set<number>()

	// Script presence + dominant script (counted on the original to preserve case-neutral codepoints).
	const counts = new Map<Script, number>()

	for (const ch of norm) {
		const sc = scriptOf(ch.codePointAt(0)!)
		counts.set(sc, (counts.get(sc) ?? 0) + 1)
	}

	let dominant: Script = "other"
	let max = -1

	for (const [sc, n] of counts) {
		active.add(bucket(`__scr_${sc}`, 1))

		if (sc !== "digit" && sc !== "other" && n > max) {
			max = n
			dominant = sc
		}
	}

	active.add(bucket(`__dom_${dominant}`, 2))

	// Char n-grams (3,4,5) over the boundary-marked string.
	const marked = `^${norm}$`

	for (const n of [3, 4, 5]) {
		for (let i = 0; i + n <= marked.length; i++) {
			active.add(bucket(marked.slice(i, i + n), n))
		}
	}

	return [...active]
}
