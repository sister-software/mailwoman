/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file The feature count a layer build declares, in one place.
 */

/**
 * The count a build may check a stream against when `limit` bounds the read. A limit above the layer's own count reads
 * every feature there is, so the declaration is the layer's count, not the limit's: a builder that compares what it
 * streamed against the limit as a strict equality would otherwise read a complete download as a short one and refuse
 * it.
 */
export function limitedFeatureCount(layerCount: number, limit: number | undefined): number {
	return limit === undefined ? layerCount : Math.min(limit, layerCount)
}

export interface DeclaredFeatureCountInput {
	/**
	 * A count the caller supplies for a RANGE it is reading, because `ogrinfo` reports a layer's total and nothing
	 * narrower. Wins when present, even at zero: a chunk that declares nothing about its size passes 0 and the parent
	 * checks the sum.
	 */
	declared?: number
	limit?: number
	layerCount: number
}

/**
 * The feature count a source declares: the caller's own range count when it supplied one, else the layer's count
 * bounded by the limit.
 */
export function declaredFeatureCount(input: DeclaredFeatureCountInput): number {
	return input.declared ?? limitedFeatureCount(input.layerCount, input.limit)
}
