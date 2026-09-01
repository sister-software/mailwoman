/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `mailwoman/observations` — the opt-in observation surface: five routes that state on whose authority
 *   an answer was reached, and the one carrier that takes what they record to a caller.
 *
 *   NOTHING HERE IS ON BY DEFAULT, and presence is the switch. A caller constructs a route and hands it in;
 *   `createRuntimePipeline` with no `poiSemanticLookup` is the pipeline that shipped, the absence route
 *   reads a finished answer without being wired into a pipeline at all, and the authority-designation route
 *   reads a finished COORDINATE the same way. There is no boolean, because a boolean would make the caller
 *   construct the artifact reader itself and put world semantics — or a sealed spatial layer — on the
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
} from "#observations/absence-route"

export {
	ABSENCE_REFUSALS,
	createAbsenceObservationRoute,
	describeAbsenceObservation,
	recoverCoverageResolution,
} from "#observations/absence-route"

export type {
	AuthorityDesignationObservation,
	AuthorityDesignationRoute,
	AuthorityDesignationRouteOptions,
	DesignationDecision,
	DesignationRefusal,
} from "#observations/flood-route"

export {
	createAuthorityDesignationRoute,
	DESIGNATION_REFUSALS,
	describeAuthorityDesignation,
} from "#observations/flood-route"

export type {
	CoastalDecision,
	CoastalErosionObservation,
	CoastalErosionRoute,
	CoastalErosionRouteOptions,
	CoastalRefusal,
} from "#observations/coastal-route"

export { COASTAL_REFUSALS, createCoastalErosionRoute, describeCoastalErosion } from "#observations/coastal-route"

export type {
	SoilCapabilityObservation,
	SoilCapabilityRoute,
	SoilCapabilityRouteOptions,
	SoilDesignationDecision,
	SoilDesignationRefusal,
} from "#observations/soil-route"

export { createSoilCapabilityRoute, describeSoilCapability, SOIL_DESIGNATION_REFUSALS } from "#observations/soil-route"

export type {
	ZoningDecision,
	ZoningDesignationObservation,
	ZoningDesignationRoute,
	ZoningDesignationRouteOptions,
	ZoningRefusal,
} from "#observations/zoning-route"

export { createZoningDesignationRoute, describeZoningDesignation, ZONING_REFUSALS } from "#observations/zoning-route"

export {
	absenceObservationMarker,
	authorityDesignationMarker,
	authorityDesignationMarkers,
	COASTAL_EROSION_DESIGNATION_MECHANISM,
	coastalErosionMarker,
	coastalErosionMarkers,
	FLOOD_ZONE_DESIGNATION_MECHANISM,
	layerDesignationMarkers,
	SOIL_CAPABILITY_DESIGNATION_MECHANISM,
	soilCapabilityMarker,
	soilCapabilityMarkers,
	poiObservationKind,
	SEMANTIC_ABSENCE_MECHANISM,
	SEMANTIC_AFFORDS_MECHANISM,
	semanticObservationMarkers,
	ZONING_DESIGNATION_MECHANISM,
	zoningDesignationMarker,
	zoningDesignationMarkers,
} from "#observations/observation-marker"

export type { LayerDesignationRoutes } from "#observations/observation-marker"

export type {
	SemanticObservation,
	SemanticObservationRoute,
	SemanticObservationRouteOptions,
	SemanticRouteIdentity,
} from "#observations/semantic-route"

export { createSemanticObservationRoute } from "#observations/semantic-route"
