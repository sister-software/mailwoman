/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Reads nearby coastal-zone features from the Environment Agency service.
 */

import { createOGCFeaturesBBoxReader, type OGCFeature } from "@mailwoman/core/api"
import { stringifyJSON } from "@mailwoman/core/json"

import { EA_NCERM_SPATIAL_BASE_URL, type EANCERMClient } from "#sdk/client"
import { NCERM_SCENARIOS_BY_KEY } from "#vocabulary"

/**
 * Half-width of the bbox the service is asked for, in degrees.
 *
 * About 11 m at this latitude — wide enough that a polygon containing the point is
 * certainly returned, narrow enough that the response stays small.
 */
const PROBE_HALF_WIDTH_DEGREES = 0.0001

/**
 * Features per service request.
 *
 * The probe bbox is meters wide, so this is a ceiling rather than a page size.
 */
const SERVICE_FEATURE_LIMIT = 200

/**
 * One feature as the service publishes it.
 * The only shape the comparison reads.
 */
export type ServiceFeature = OGCFeature

/**
 * The one call the verification makes against the service: the features it publishes
 * near a point, in one scenario's collection.
 *
 * A function lets tests exercise the check's own logic.
 * The comparison decides which of three results applies to a point.
 *
 * A test cannot observe these decisions through a live HTTP client.
 * A scripted reader lets the test pin them. {@link createEAServiceReader} builds the real reader.
 */
export type ServiceFeatureReader = (
	latitude: number,
	longitude: number,
	scenarioKey: string
) => Promise<ServiceFeature[]>

/**
 * The reader the live check uses: an OGC API Features bbox query against the EA's
 * own service, in the collection selected by the scenario.
 *
 * The service answers a bbox rather than a point, so this returns what it published nearby
 * and the containment decision is made in {@link readServiceContainment} against
 * those rings — comparing the artifact's verdict against a bare "the service returned
 * something here" would pass on any polygon within eleven meters.
 */
export function createEAServiceReader(client: Pick<EANCERMClient, "fetch">): ServiceFeatureReader {
	return async (latitude, longitude, scenarioKey) => {
		const scenario = NCERM_SCENARIOS_BY_KEY.get(scenarioKey)

		if (!scenario) {
			throw new Error(`coastal verify: ${stringifyJSON(scenarioKey)} is not one of the twelve published scenarios`)
		}

		return createOGCFeaturesBBoxReader<ServiceFeature>({
			client,
			collectionURL: `${EA_NCERM_SPATIAL_BASE_URL}/ogc/features/v1/collections/${scenario.layer}`,
			halfWidthDegrees: PROBE_HALF_WIDTH_DEGREES,
			limit: SERVICE_FEATURE_LIMIT,
		})(latitude, longitude)
	}
}
