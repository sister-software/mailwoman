/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The coarse-placer tools' shared FNV-1a hash — the one home for the four byte-identical copies
 *   the 2026-07-09 dedupe survey found (`build-dataset` / `build-outlier-{oa,latin,exposure}`).
 *   Deterministic ordering + variant choice depends on this exact stream — datasets rebuilt with a
 *   different hash won't reproduce. Internal to the tools; deliberately NOT exported from
 *   `@mailwoman/core` (featurize.ts carries its own FNV, bucketed mod FEATURE_DIM — different
 *   contract, do not merge).
 */

/** FNV-1a → uint32, for deterministic ordering/variant choice. */
export function hashFNV1a(s: string): number {
	let h = 2166136261

	for (let i = 0; i < s.length; i++) {
		h ^= s.charCodeAt(i)
		h = Math.imul(h, 16777619)
	}

	return h >>> 0
}
