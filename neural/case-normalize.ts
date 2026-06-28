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
		if (c >= 65 && c <= 90) upper++
	}

	return upper >= 3
}

/**
 * Title-case each ASCII alphabetic run (`PALESTINE` → `Palestine`). Length-preserving — token offsets unchanged.
 */
export function titleCaseInput(text: string): string {
	return text.replace(/[A-Za-z]+/g, (w) => w[0]!.toUpperCase() + w.slice(1).toLowerCase())
}

/** Title-case the input iff it is all-caps; otherwise return it unchanged. The parser's #690 hook. */
export function normalizeInputCase(text: string): string {
	return isAllCapsInput(text) ? titleCaseInput(text) : text
}
