/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   FNV-1a hashing for the coarse-placer: feature bucketing in {@link featurize} and deterministic
 *   dataset ordering/variant selection in the dataset builders. Pure, zero deps — safe for the
 *   always-resident inference path and the browser bundle.
 */

/**
 * FNV-1a → uint32. The default seed is the standard FNV offset basis; {@link featurize} salts it per feature family by
 * XOR before hashing.
 */
export function hashFNV1a(s: string, seed = 2_166_136_261): number {
	let h = seed

	for (let i = 0; i < s.length; i++) {
		h ^= s.charCodeAt(i)
		h = Math.imul(h, 16_777_619)
	}

	return h >>> 0
}
