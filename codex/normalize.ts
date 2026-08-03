/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Name-normalization primitives shared across the codex tables and the lexicon builders that read
 *   them.
 *
 *   These live in `@mailwoman/codex` rather than in `core` or `normalize` for one reason: codex is
 *   the zero-runtime-dependency reference package, and everything that needs to match a name against
 *   a codex table already depends on it. Putting the folding rules next to the tables they fold
 *   means a lookup and its table can never disagree about what counts as the same name.
 *
 */

/**
 * Fold a name to its ASCII match key: lower-cased, accents stripped, every run of non-alphanumerics collapsed to a
 * single space.
 *
 * This is the aggressive fold used to match a user's surface form against a codex table — `"Québec"` and `"QUEBEC"` and
 * `"quebec"` all become `"quebec"`. It is lossy by design and never used to render anything back to a user.
 */
export function foldName(s: string): string {
	return s
		.toLowerCase()
		.normalize("NFD")
		.replaceAll(/[\u0300-\u036F]/g, "")
		.replaceAll(/[^a-z0-9]+/g, " ")
		.trim()
}

/**
 * Strip leading and trailing punctuation from every whitespace-separated word, dropping words that were nothing but
 * punctuation, and rejoin on single spaces.
 *
 * Unlike {@link foldName} this preserves case and non-Latin scripts — it works on Unicode letter and number classes, so
 * `"Кыргызстан,"` and `"日本 。"` survive with their content intact. That is what makes it the right normalizer for
 * building surface lexicons, where the entry has to remain renderable, and the wrong one for building a match key.
 */
export function wordNorm(s: string): string {
	return s
		.split(/\s+/)
		.map((w) => w.replaceAll(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ""))
		.filter(Boolean)
		.join(" ")
}

/**
 * {@link wordNorm}, lower-cased — the case-insensitive lexicon key.
 */
export function wordNormLower(s: string): string {
	return wordNorm(s).toLowerCase()
}
