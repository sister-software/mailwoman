/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Stage 2.5 classifier: compose rule-based scorers over QueryShape and return a top kind with alternatives.
 */

export { classifyKind, classifyKindSync, createKindClassifier } from "#classify"
export type { KindClassifierOpts } from "#classify"
export { deriveIntentMarkers } from "#intent/markers"
export type { IntentMarkerContext } from "#intent/markers"
export { nearMeSubject, scoreBareToponym, scoreNearMe, scoreRoutePair } from "#intent/rules"
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
