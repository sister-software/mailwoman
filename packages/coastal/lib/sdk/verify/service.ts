/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Reads nearby coastal-zone features from the Environment Agency service.
 */

import { createOGCFeaturesBBoxReader } from "@mailwoman/core/api"

import { EA_NCERM_SPATIAL_BASE_URL, type EANCERMClient } from "#sdk/client"
import { NCERM_SCENARIOS_BY_KEY } from "#vocabulary"

/**
 * Half-width of the bbox the service is asked for, in degrees. About 11 m at this latitude — wide enough that a polygon
 * containing the point is certainly returned, narrow enough that the response stays small.
 */
const PROBE_HALF_WIDTH_DEGREES = 0.0001

/**
 * Features per service request. The probe bbox is metres wide, so this is a ceiling rather than a page size.
 */
const SERVICE_FEATURE_LIMIT = 200

/**
 * One feature as the service publishes it — the only shape the comparison reads.
 */
export interface ServiceFeature {
	properties?: Record<string, unknown>
	geometry?: { type: string; coordinates: unknown }
}

/**
 * The ONE call the verification makes against the service: the features it publishes near a point, in one scenario's
 * collection.
 *
 * A function rather than the client, and that is what makes the check's own logic testable. The comparison's value is
 * that it decides which of three outcomes a point gets; expressed against an HTTP client it could only ever be watched
 * on a live run, and a scripted reader lets those decisions be pinned. {@link createEAServiceReader} builds the real
 * one.
 */
export type ServiceFeatureReader = (
	latitude: number,
	longitude: number,
	scenarioKey: string
) => Promise<ServiceFeature[]>

/**
 * The reader the live check uses: an OGC API Features bbox query against the EA's own service, in the collection named
 * by the scenario asked about.
 *
 * The service answers a BBOX, not a point, so this returns what it published nearby and the containment decision is
 * made in {@link readServiceContainment} against those rings — comparing the artifact's verdict against a bare "the
 * service returned something here" would pass on any polygon within eleven metres.
 */
export function createEAServiceReader(client: Pick<EANCERMClient, "fetch">): ServiceFeatureReader {
	return async (latitude, longitude, scenarioKey) => {
		const scenario = NCERM_SCENARIOS_BY_KEY.get(scenarioKey)

		if (!scenario) {
			throw new Error(`coastal verify: ${JSON.stringify(scenarioKey)} is not one of the twelve published scenarios`)
		}

		return createOGCFeaturesBBoxReader<ServiceFeature>({
			client,
			collectionURL: `${EA_NCERM_SPATIAL_BASE_URL}/ogc/features/v1/collections/${scenario.layer}`,
			halfWidthDegrees: PROBE_HALF_WIDTH_DEGREES,
			limit: SERVICE_FEATURE_LIMIT,
		})(latitude, longitude)
	}
}
