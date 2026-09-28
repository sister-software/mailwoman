/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Feature extraction for the coarse-placer. A fastText-style hashed char-n-gram representation
 *   plus explicit Unicode-script presence tokens. Deterministic and pure, shared by training and
 *   the always-resident inference, with zero dependencies. A string maps to a set of active
 *   feature indices in [0, FEATURE_DIM).
 *
 *   Script is the dominant coarse-geography signal. Char n-grams separate within a script, so a
 *   linear model over both stays a few hundred KB and runs in microseconds.
 */

import { hashFNV1a } from "#coarse-placer/fnv-hash"

/**
 * The trained classes: the well-represented corpus countries, the Overture-sourced EU
 * expansion, and `other`, the explicit off-map class trained on non-Latin and non-CJK
 * scripts via outlier exposure, so the model learns the edge of its competence.
 *
 * Index order is the label id.
 *
 * It acts as a soft prior, so a neighbour confusion (DK↔NO, EE↔LT↔LV) still keeps
 * resolution in-region, off the global-pop attractors.
 *
 * Adding a class requires a retrain and a fresh artifact.
 * The bundled meta.json carries its own `classes` for inference, so this constant drives training.
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
	"AU",
	"OTHER",
] as const

/**
 * Hashed-feature dimensionality (2^16).
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

export type Script = (typeof SCRIPTS)[number]

/**
 * Coarse Unicode-script bucket of a codepoint — the strong prior the n-grams refine.
 */
export function scriptOf(cp: number): Script {
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
	return hashFNV1a(s, (2_166_136_261 ^ salt) >>> 0) % FEATURE_DIM
}

/**
 * Featurize an address into a deduped list of active feature indices: char 3/4/5-grams over the lowercased,
 * boundary-marked string + one presence token per Unicode script seen (+ the dominant script).
 *
 * Non-Latin characters are preserved (lowercasing only touches cased scripts).
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

	const marked = `^${norm}$`

	for (const n of [3, 4, 5]) {
		for (let i = 0; i + n <= marked.length; i++) {
			active.add(bucket(marked.slice(i, i + n), n))
		}
	}

	return [...active]
}
