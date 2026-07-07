/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   #690: input case-normalization for the neural parser. ALL-CAPS registry/compliance data (`214
 *   JONES RD, ELKHART, TX 75839`) is partly out-of-domain for a model trained on mixed-case text —
 *   it drops/mis-bounds tokens (`PALESTINE` → locality `ALESTINE`). Title-casing an all-caps input
 *   before the model recovers it (measured: TX HHSC locality 90.1% → 99.7%,
 *   `docs/articles/evals/2026-06-17-geocoder-vs-provided-coords.md`).
 *
 *   Detection is deliberately STRICT — only a fully-shouting input qualifies — so mixed-case input is
 *   never touched (the caller's byte-stable path). Distinct from the identifier-casing all-caps
 *   idiom in `core/identifiers.ts` (`smartSnakeCase`/`smartCamelCase`): those skip _case
 *   conversion_ when a name is already uppercase; this _applies_ a title-case to address TEXT for
 *   the model.
 */

/**
 * True when `text` is PURE-ASCII ALL-CAPS: it has cased ASCII letters and ZERO lowercase, and NO non-ASCII characters.
 * The pure-ASCII requirement is deliberate — title-casing accented/non-Latin text is locale-sensitive and can change
 * length (`ß`→`SS`, Turkish dotted/dotless I), which would break the token-offset invariant the caller relies on. So
 * this fix targets ASCII registry data only; accented or non-Latin input falls back to the model's current behavior.
 * The 3-letter floor avoids treating a digit/punctuation-only or tiny-token input as a whole shouting address.
 */
export function isAllCapsInput(text: string): boolean {
	let upper = 0

	for (let i = 0; i < text.length; i++) {
		const c = text.charCodeAt(i)

		if (c > 127) return false

		// any non-ASCII (accented/non-Latin) → leave it alone
		if (c >= 97 && c <= 122) return false

		// any [a-z] → mixed case, leave it alone
		if (c >= 65 && c <= 90) {
			upper++
		}
	}

	return upper >= 3
}

/**
 * Title-case each ASCII alphabetic run ≥3 letters (`PALESTINE` → `Palestine`), PRESERVING runs of ≤2 letters. The
 * preserve is the #690→#252 fix (the Gauntlet's casing-invariance catch): an all-caps input title-cased BLINDLY turns a
 * 2-letter region code into a non-region form the model mis-parses — `NY`→`Ny`, `DC`→`Dc` land as a _locality_, not a
 * region, so `350 5TH AVE, NEW YORK, NY` lost its state. Every ≤2-letter all-caps token in a US address is an
 * abbreviation the model already reads correctly all-caps (state codes NY/DC, directionals N/NW/SE, suffixes ST/RD), so
 * keeping them shouting restores the model's correct input — `1600 PENNSYLVANIA AVE NW, WASHINGTON DC` now title-cases
 * to exactly the mixed-case form that parses `region:DC`. Length-preserving — token offsets unchanged. The #690 benefit
 * (≥3-letter locality/name recovery: PALESTINE→Palestine, ELKHART→Elkhart) is untouched.
 */
export function titleCaseInput(text: string): string {
	return text.replace(/[A-Za-z]+/g, (w) => (w.length <= 2 ? w : w[0]!.toUpperCase() + w.slice(1).toLowerCase()))
}

/**
 * True when `text` is PURE-ASCII ALL-LOWERCASE: it has cased ASCII letters and ZERO uppercase, and NO non-ASCII
 * characters. The mirror of {@link isAllCapsInput} for the #829 class — fully-lowercase input (`1600 pennsylvania ave
 * nw, washington dc`) is as out-of-domain as all-caps for a mixed-case-trained model: it fragments the street and drops
 * the state code (the Gauntlet metamorphic INV[lower] failures). Same pure-ASCII + 3-letter guards as the all-caps
 * detector, for the same reasons (accented/non-Latin casing is locale-sensitive + length-changing → left untouched).
 */
export function isAllLowerInput(text: string): boolean {
	let lower = 0

	for (let i = 0; i < text.length; i++) {
		const c = text.charCodeAt(i)

		if (c > 127) return false

		// any non-ASCII (accented/non-Latin) → leave it alone
		if (c >= 65 && c <= 90) return false

		// any [A-Z] → mixed case, leave it alone
		if (c >= 97 && c <= 122) {
			lower++
		}
	}

	return lower >= 3
}

/**
 * Restore a fully-lowercase input to the canonical mixed-case the model was trained on: title-case each ASCII run ≥3
 * letters (`pennsylvania` → `Pennsylvania`) and UPPERCASE each run ≤2 letters (`dc` → `DC`, `nw` → `NW`, `lg` → `LG`).
 * The ≤2 handling is where this differs from {@link titleCaseInput}: on all-caps input those tokens are ALREADY shouting
 * so #690 preserves them; on all-lowercase input they arrive as `dc`/`ny` and must be UPPERCASED to reach the same form
 * — every ≤2-letter token in an address is an abbreviation the model reads best uppercase (state codes NY/DC,
 * directionals N/NW/SE, suffixes ST/RD, the NL postcode suffix LG). Length-preserving — token offsets unchanged. Net:
 * `1600 pennsylvania ave nw, washington dc` and `1600 PENNSYLVANIA AVE NW, WASHINGTON DC` both canonicalize to `1600
 * Pennsylvania Ave NW, Washington DC`, the exact mixed-case form that parses `region:DC`.
 */
export function restoreLowerInput(text: string): string {
	return text.replace(/[A-Za-z]+/g, (w) =>
		w.length <= 2 ? w.toUpperCase() : w[0]!.toUpperCase() + w.slice(1).toLowerCase()
	)
}

/**
 * Normalize a shouting OR whispering ASCII input to canonical mixed-case before the model; mixed-case and
 * accented/non-Latin input pass through byte-identically. The parser's #690 (all-caps) + #829 (all-lowercase) hook.
 */
export function normalizeInputCase(text: string): string {
	if (isAllCapsInput(text)) return titleCaseInput(text)

	if (isAllLowerInput(text)) return restoreLowerInput(text)

	return text
}
