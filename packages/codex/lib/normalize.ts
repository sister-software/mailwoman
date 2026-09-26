/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Name-normalization primitives shared across the codex tables and the lexicon builders that read
 *   them. They live here rather than in `core` or `normalize` because codex is the
 *   zero-runtime-dependency reference package and everything matching a name against a codex table
 *   already depends on it; keeping the folding rules beside the tables they fold stops a lookup and
 *   its table from disagreeing about what counts as the same name.
 */

/**
 * Fold a name to a lossy ASCII match key for codex table lookups; never render the result back to a user.
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
 * Normalize a word list without folding case or non-Latin scripts — `"Кыргызстан,"`
 * and `"日本 。"` survive with their content intact — for surface lexicons whose entries
 * must remain renderable; unlike {@link foldName} this is not a match key.
 */
export function wordNorm(s: string): string {
	return s
		.split(/\s+/)
		.map((w) => w.replaceAll(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ""))
		.filter((w) => w.length)
		.join(" ")
}

/**
 * {@link wordNorm}, lower-cased — the case-insensitive lexicon key.
 */
export function wordNormLower(s: string): string {
	return wordNorm(s).toLowerCase()
}

/**
 * Fold a single token to a lowercase, diacritic-free form, leaving punctuation
 * and whitespace alone (unlike {@link foldName}); the shared core of the per-country
 * token matchers, each of which layers its own character filtering on top.
 */
export function foldToken(s: string): string {
	return s
		.toLowerCase()
		.normalize("NFD")
		.replaceAll(/[\u0300-\u036F]/g, "")
}
