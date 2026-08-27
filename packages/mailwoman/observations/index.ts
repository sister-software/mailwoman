/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `mailwoman/observations` — the opt-in observation surface: two routes that state on whose authority an
 *   answer was reached, and the one carrier that takes what they record to a caller.
 *
 *   NOTHING HERE IS ON BY DEFAULT, and presence is the switch. A caller constructs a route and hands it in;
 *   `createRuntimePipeline` with no `poiSemanticLookup` is the pipeline that shipped, and the absence route
 *   reads a finished answer without being wired into a pipeline at all. There is no boolean, because a
 *   boolean would make the pipeline construct the artifact reader itself and put world semantics on the
 *   default construction path.
 *
 *   ROLLBACK IS REMOVING THE ARGUMENT at the one call site. A consumer who never passed a route is
 *   unaffected by anything under this directory, which is the property the opt-in posture buys.
 */

export type {
	AbsenceDecision,
	AbsenceObservation,
	AbsenceObservationRoute,
	AbsenceObservationRouteOptions,
	AbsenceRefusal,
	AbsenceRouteIdentity,
} from "./absence-route.ts"

export {
	ABSENCE_REFUSALS,
	createAbsenceObservationRoute,
	describeAbsenceObservation,
	recoverCoverageResolution,
} from "./absence-route.ts"

export {
	absenceObservationMarker,
	poiObservationKind,
	SEMANTIC_ABSENCE_MECHANISM,
	SEMANTIC_AFFORDS_MECHANISM,
	semanticObservationMarkers,
} from "./observation-marker.ts"

export type {
	SemanticObservation,
	SemanticObservationRoute,
	SemanticObservationRouteOptions,
	SemanticRouteIdentity,
} from "./semantic-route.ts"

export { createSemanticObservationRoute } from "./semantic-route.ts"
