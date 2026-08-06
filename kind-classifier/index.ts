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

export { classifyKind, classifyKindSync, createKindClassifier } from "./classify.ts"
export type { KindClassifierOpts } from "./classify.ts"
export { deriveIntentMarkers } from "./intent-markers.ts"
export type { IntentMarkerContext } from "./intent-markers.ts"
export { nearMeSubject, scoreBareToponym, scoreNearMe, scoreRoutePair } from "./intent-rules.ts"
export { matchPOICategory, matchPOISubject } from "./poi.ts"
export type { POIPhraseMatch, POIPhraseLookup, POISubjectMatch } from "./poi.ts"

export {
	scoreIntersection,
	scoreLandmark,
	scoreLocalityOnly,
	scorePoBox,
	scorePostcodeOnly,
	scoreStructuredAddress,
	scoreVague,
	scoreVenueLandmark,
} from "./rules.ts"

export { QueryIntentCode } from "./types.ts"

export type {
	LocaleHint,
	NormalizedInputLite,
	QueryIntentMarker,
	QueryKind,
	QueryKindResult,
	QueryShapeLike,
} from "./types.ts"
