/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Reads nearby flood features from the Environment Agency service.
 */

import { createOGCFeaturesBBoxReader, type OGCFeature } from "@mailwoman/core/api"

import { EA_SPATIAL_BASE_URL, type EAFloodClient } from "#sdk/client"
import { EA_FLOOD_LAYER } from "#vocabulary"

/**
 * Half-width of the bbox the service is asked for, in degrees.
 */
const PROBE_HALF_WIDTH_DEGREES = 0.0001

/**
 * Features per service request.
 *
 * The probe bbox is meters wide, so this is a ceiling rather than a page size.
 */
const SERVICE_FEATURE_LIMIT = 200

/**
 * One feature as the service publishes it — the only shape the comparison reads.
 */
export type ServiceFeature = OGCFeature<{ flood_zone?: string }>

/**
 * The one call the verification makes against the service: the features it publishes near a point.
 *
 * The reader is a function.
 * Tests can exercise the check's logic without a live client.
 *
 * The comparison's value is that it decides which of three outcomes a point gets.
 *
 * An HTTP client would let tests observe these decisions only in a live run.
 * A scripted reader lets tests pin each decision. {@link createEAServiceReader}
 * builds the production reader.
 */
export type ServiceFeatureReader = (latitude: number, longitude: number) => Promise<ServiceFeature[]>

/**
 * The reader the live check uses: an OGC API Features bbox query against the EA's own service.
 *
 * The service answers a bbox rather than a point, so this returns what it published nearby
 * and the containment decision is made in {@link readServiceZone} against those rings —
 * comparing the artifact's verdict against a bare "the service returned something
 * here" would pass on any polygon within eleven meters.
 */
export function createEAServiceReader(client: Pick<EAFloodClient, "fetch">): ServiceFeatureReader {
	return createOGCFeaturesBBoxReader<ServiceFeature>({
		client,
		collectionURL: `${EA_SPATIAL_BASE_URL}/ogc/features/v1/collections/${EA_FLOOD_LAYER}`,
		halfWidthDegrees: PROBE_HALF_WIDTH_DEGREES,
		limit: SERVICE_FEATURE_LIMIT,
	})
}
