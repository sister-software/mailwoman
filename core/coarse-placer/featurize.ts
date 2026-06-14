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
 * The trained classes: the well-represented corpus countries + `OTHER` — the explicit off-map class
 * (milestone 2) trained on non-Latin/non-CJK scripts via outlier exposure, so the model learns the
 * edge of its competence and routes "probably off my loaded map" instead of a confident
 * mis-placement. Index order is the label id.
 */
export const COARSE_CLASSES = ["US", "FR", "GB", "CN", "NL", "IT", "DE", "JP", "ES", "KR", "TW", "OTHER"] as const
export type CoarseClass = (typeof COARSE_CLASSES)[number]

/**
 * Hashed-feature dimensionality (2^16). Keeps the weight matrix small (11×65536) while collisions
 * stay tolerable for a linear bag-of-features model; the discriminative n-grams are few.
 */
export const FEATURE_DIM = 1 << 16

/** Coarse Unicode-script buckets — strong priors the n-grams refine. */
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
	if ((cp >= 0x41 && cp <= 0x5a) || (cp >= 0x61 && cp <= 0x7a) || (cp >= 0xc0 && cp <= 0x24f)) return "latin"
	if (
		(cp >= 0x3040 && cp <= 0x30ff) ||
		(cp >= 0x4e00 && cp <= 0x9fff) ||
		(cp >= 0xac00 && cp <= 0xd7af) ||
		(cp >= 0x3400 && cp <= 0x4dbf)
	)
		return "cjk"
	if ((cp >= 0x400 && cp <= 0x52f) || (cp >= 0x2de0 && cp <= 0x2dff)) return "cyrillic"
	if ((cp >= 0x600 && cp <= 0x6ff) || (cp >= 0x750 && cp <= 0x77f) || (cp >= 0xfb50 && cp <= 0xfeff)) return "arabic"
	if (cp >= 0x370 && cp <= 0x3ff) return "greek"
	if (cp >= 0x590 && cp <= 0x5ff) return "hebrew"
	if (cp >= 0x900 && cp <= 0x97f) return "devanagari"
	if (cp >= 0xe00 && cp <= 0xe7f) return "thai"
	return "other"
}

/** FNV-1a → a feature bucket in [0, FEATURE_DIM). */
function bucket(s: string, salt: number): number {
	let h = (2166136261 ^ salt) >>> 0
	for (let i = 0; i < s.length; i++) {
		h ^= s.charCodeAt(i)
		h = Math.imul(h, 16777619)
	}
	return (h >>> 0) % FEATURE_DIM
}

/**
 * Featurize an address into a deduped list of active feature indices: char 3/4/5-grams over the
 * lowercased, boundary-marked string + one presence token per Unicode script seen (+ the dominant
 * script). Non-Latin characters are PRESERVED (lowercasing only touches cased scripts).
 */
export function featurize(text: string): number[] {
	const norm = text.toLowerCase().replace(/\s+/g, " ").trim()
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
