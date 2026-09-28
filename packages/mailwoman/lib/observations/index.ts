/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 * The opt-in `mailwoman/observations` surface: no route is on by default, presence is the switch, and rollback is removing the argument at the one call site.
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
