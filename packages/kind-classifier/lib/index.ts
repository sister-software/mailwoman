/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `@mailwoman/kind-classifier` — Stage 2.5 of the runtime pipeline.
 *
 *   Categorize inputs into one of eight `QueryKind`s by composing rule-based scorers over the
 *   QueryShape sub-system's output. Pure functions, no ML, no place-name dictionaries. Returns
 *   possibilities (alternatives) alongside the top pick so the coordinator can fall back when the
 *   winning kind isn't actionable.
 *
 *   See `docs/engineering/reference/STAGES.md` § Stage 2.5 for the contract.
 */

export { classifyKind, classifyKindSync, createKindClassifier } from "#classify"
export type { KindClassifierOpts } from "#classify"
export { deriveIntentMarkers } from "#intent-markers"
export type { IntentMarkerContext } from "#intent-markers"
export { nearMeSubject, scoreBareToponym, scoreNearMe, scoreRoutePair } from "#intent-rules"
export { matchPOICategory, matchPOISubject } from "#poi"
export type { POIPhraseMatch, POIPhraseLookup, POIQuerySpan, POISpatialRelation, POISubjectMatch } from "#poi"

export {
	scoreIntersection,
	scoreLandmark,
	scoreLocalityOnly,
	scorePoBox,
	scorePostcodeOnly,
	scoreStructuredAddress,
	scoreVague,
	scoreVenueLandmark,
} from "#rules"
