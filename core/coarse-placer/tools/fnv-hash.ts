/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   FNV-1a hashing for deterministic coarse-placer dataset ordering and variant selection.
 */

/**
 * FNV-1a → uint32, for deterministic ordering/variant choice.
 */
export function hashFNV1a(s: string): number {
	let h = 2_166_136_261

	for (let i = 0; i < s.length; i++) {
		h ^= s.charCodeAt(i)
		h = Math.imul(h, 16_777_619)
	}

	return h >>> 0
}
