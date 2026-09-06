/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `normalize(raw, opts)` — the Stage 1 entry point. Composes NFC + punctuation + whitespace
 *   (always) with case-fold + abbreviation expansion (opt-in).
 */

import { expandAbbreviations } from "#abbreviations"
import { applyCjkNormalization } from "#cjk"
import { spaceAfterComma } from "#comma-spacing"
import { applyNFC } from "#nfc"
import { composeMaps, identityMap } from "#offset-map"
import { applyPunctuation } from "#punctuation"
import type { NormalizationTransform, NormalizedInput, NormalizeOpts } from "#types"
import { collapseWhitespace } from "#whitespace"

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
		const r = applyCjkNormalization(text, opts?.postalMark ? { postalMark: opts.postalMark } : {})

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

	// 2.5 Comma spacing — a comma glued to a letter gains a space. Runs after punctuation (so a folded
	// full-width comma is seen) and before whitespace collapse (so a comma already followed by a space is
	// never doubled).
	{
		const r = spaceAfterComma(text)

		if (r.inserted > 0) {
			text = r.text
			map = composeMaps(map, r.map)
			transforms.push({ kind: "space_after_comma", inserted: r.inserted })
		}
	}

	// 3. Whitespace
	{
		const r = collapseWhitespace(text)

		// Compare the TEXT, not its length: folding a lone tab to a space is length-preserving, and a
		// length test reads that edit as no edit at all.
		if (r.text !== text) {
			text = r.text
			map = composeMaps(map, r.map)
			transforms.push({ kind: "collapse_whitespace", runs: r.runs })
		}
	}

	// 4. Abbreviation expansion (opt-in) — runs BEFORE case-fold so case-folding the canonical
	// expansion form (e.g. "Street") gives a consistent final case.
	if (opts?.expandAbbreviations) {
		const r = expandAbbreviations(text, opts.locale)

		if (r.expansions.length) {
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
