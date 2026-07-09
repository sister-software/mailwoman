/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `normalize(raw, opts)` — the Stage 1 entry point. Composes NFC + punctuation + whitespace
 *   (always) with case-fold + abbreviation expansion (opt-in).
 */

import { expandAbbreviations } from "./abbreviations.ts"
import { applyCjkNormalization } from "./cjk.ts"
import { applyNFC } from "./nfc.ts"
import { composeMaps, identityMap } from "./offset-map.ts"
import { applyPunctuation } from "./punctuation.ts"
import type { NormalizationTransform, NormalizedInput, NormalizeOpts } from "./types.ts"
import { collapseWhitespace } from "./whitespace.ts"

export function normalize(raw: string, opts?: NormalizeOpts): NormalizedInput {
	const transforms: NormalizationTransform[] = []
	let text = raw
	let map = identityMap(raw.length)

	// 1. NFC
	if (!opts?.skipNFC) {
		const r = applyNFC(text)
		text = r.text
		map = composeMaps(map, r.map)
		transforms.push({ kind: "nfc", changed: r.changed })
	}

	// 1.5 CJK normalization — strip the postal mark 〒 (byte-fallback OOV that poisons the postcode
	// parse) and fold full-width ASCII + the ideographic space. Runs after NFC so it sees composed
	// forms, before punctuation/whitespace so any gap left by 〒 is then collapsed. No-op off-script.
	{
		const r = applyCjkNormalization(text)

		if (r.folded > 0 || r.stripped > 0) {
			text = r.text
			map = composeMaps(map, r.map)
			transforms.push({ kind: "normalize_cjk", folded: r.folded, stripped: r.stripped })
		}
	}

	// 2. Punctuation
	{
		const r = applyPunctuation(text)

		if (r.replacements > 0) {
			text = r.text
			map = composeMaps(map, r.map)
			transforms.push({ kind: "normalize_punctuation", replacements: r.replacements })
		}
	}

	// 3. Whitespace
	{
		const r = collapseWhitespace(text)

		if (r.runs > 0 || r.text.length !== text.length) {
			text = r.text
			map = composeMaps(map, r.map)
			transforms.push({ kind: "collapse_whitespace", runs: r.runs })
		}
	}

	// 4. Abbreviation expansion (opt-in) — runs BEFORE case-fold so case-folding the canonical
	// expansion form (e.g. "Street") gives a consistent final case.
	if (opts?.expandAbbreviations) {
		const r = expandAbbreviations(text, opts.locale)

		if (r.expansions.length > 0) {
			text = r.text
			map = composeMaps(map, r.map)

			for (const e of r.expansions) {
				transforms.push({ kind: "expand_abbreviation", from: e.from, to: e.to, at: e.at })
			}
		}
	}

	// 5. Case fold (opt-in)
	if (opts?.caseFold) {
		const lc = text.toLocaleLowerCase(opts.locale)

		if (lc !== text) {
			text = lc
			// Case-fold is identity-length for ASCII + most Latin; map unchanged.
			transforms.push({ kind: "case_fold", locale: opts.locale ?? "und" })
		}
	}

	return Object.freeze({
		raw,
		normalized: text,
		transforms: Object.freeze(transforms) as NormalizationTransform[],
		offsetMap: map,
		appliedLocale: opts?.locale,
	}) satisfies NormalizedInput
}
