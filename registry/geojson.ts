/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Export resolved entities as GeoJSON — the bridge to QGIS and any web map. Each entity becomes a
 *   Point at its resolved coordinate, carrying the properties an analyst needs: how many records
 *   merged into it, how tightly (cohesion), the canonical name/org/address, and the geocode tier
 *   (so rooftop-precise entities can be styled apart from admin-centroid guesses). Entities without
 *   a coordinate are omitted (a Point feature needs one).
 */

import type { GeoFeature, GeoFeatureCollection, PointLiteral } from "@mailwoman/spatial"

import type { EntityGeoData, ResolvedEntity, SourceRecord } from "./types.js"

/** Assemble a display name from a record's parsed person name, if any. */
function displayName(record: SourceRecord): string | null {
	const name = record.name

	if (!name) return null
	const joined = [name.prefix, name.given, name.middle, name.familyParticle, name.family, name.suffix]
		.filter(Boolean)
		.join(" ")
		.trim()

	return joined || null
}

/** One entity → one GeoJSON Point feature. */
function toFeature(entity: ResolvedEntity): GeoFeature<PointLiteral, EntityGeoData> {
	const rep = entity.representative

	return {
		type: "Feature",
		id: undefined, // Consider using entity.id here.
		geometry: {
			type: "Point",
			coordinates: [entity.coordinate!.longitude, entity.coordinate!.latitude],
		},
		properties: {
			entityID: entity.id,
			recordCount: entity.records.length,
			cohesion: entity.cohesion,
			sourceIds: entity.records.map((r) => r.id),
			// Distinct provenance labels the entity's records span — an entity with ≥2 is a cross-dataset link.
			sources: [...new Set(entity.records.map((r) => r.source).filter((s): s is string => !!s))].sort(),
			name: displayName(rep),
			organization: rep.organization?.canonical ?? null,
			address: rep.address?.formatted ?? null,
			geocodeTier: rep.address?.geocode?.tier ?? null,
		},
	}
}

/**
 * Convert resolved entities into a GeoJSON `FeatureCollection` of points, ready for QGIS. Entities with no resolved
 * coordinate are skipped.
 */
export function toGeoJSON(entities: readonly ResolvedEntity[]): GeoFeatureCollection<PointLiteral, EntityGeoData> {
	return {
		type: "FeatureCollection",
		features: entities.filter((entity) => entity.coordinate).map(toFeature),
	}
}
