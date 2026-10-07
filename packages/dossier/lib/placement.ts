/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The spatial key and the positions of a dossier's buildings. A membership is a source's statement that a
 *   building lies in an extent. It writes the extent as a layer reading writes it, so a reading over that
 *   extent can attach to the building.
 *
 *   A reading with a subject attaches to that building only. A reading without one attaches to each
 *   building that a membership places in the reading's extent, and to no building otherwise. A position
 *   is a source's latitude and longitude for a building. Two positions that state different locations
 *   leave the building's position unresolved, and the answer lists both. The dossier computes no
 *   geometry: each membership and each position is a source's statement.
 */

import type { LayerReading } from "#coverage"
import type { EntityID } from "#identifiers"
import type { Evidence } from "#links"
import type { ISODate } from "#time"

/**
 * A source's statement that a building lies in an extent.
 */
export interface ExtentMembership {
	/**
	 * The building.
	 * It must be a building the dossier's records supply.
	 */
	subject: EntityID
	/**
	 * The extent as a layer reading writes it, such as `census-block:<GEOID>`, an H3 cell or a postcode.
	 */
	extent: string
	evidence: Evidence
}

/**
 * A source's statement of a building's location, in WGS 84 decimal degrees.
 */
export interface BuildingPosition {
	/**
	 * The building.
	 * It must be a building the dossier's records supply.
	 */
	subject: EntityID
	latitude: number
	longitude: number
	/**
	 * `true` for a position invented for an example.
	 *
	 * Every output that shows a synthetic position labels it synthetic.
	 */
	synthetic: boolean
	evidence: Evidence
}

/**
 * A building's location on a date.
 *
 * It resolves when every position states the same latitude and longitude.
 * Otherwise it is unresolved and lists the positions that differ, or none when no position exists.
 */
export type PositionAnswer =
	| {
			status: "resolved"
			latitude: number
			longitude: number
			/**
			 * `true` when every position that states the location is synthetic.
			 */
			synthetic: boolean
			positions: readonly BuildingPosition[]
	  }
	| { status: "unresolved"; reason: string; conflicting: readonly BuildingPosition[] }

/**
 * The buildings a layer reading attaches to.
 *
 * A reading with a subject attaches to that building only.
 * A reading without one attaches to each building that a membership places in the reading's extent.
 * An empty list means that neither rule places the reading.
 */
export function readingBuildings(reading: LayerReading, memberships: readonly ExtentMembership[]): readonly EntityID[] {
	if (reading.subject !== null) return [reading.subject]

	const placed = memberships.filter((membership) => membership.extent === reading.extent)

	return [...new Set(placed.map((membership) => membership.subject))]
}

/**
 * The location of `subject` on `asOf`, from the supplied positions.
 *
 * Positions that state one latitude and longitude resolve to it.
 * Positions that state two or more locations stay unresolved, and the answer lists every one of them.
 */
export function positionOf(
	positions: readonly BuildingPosition[],
	query: { subject: EntityID; asOf: ISODate }
): PositionAnswer {
	const mine = positions.filter((position) => position.subject === query.subject)
	const [first] = mine

	if (!first)
		return { status: "unresolved", reason: `no position on ${query.asOf} for ${query.subject}`, conflicting: [] }

	const locations = new Set(mine.map((position) => `${position.latitude},${position.longitude}`))

	if (locations.size > 1) {
		return {
			status: "unresolved",
			reason: `${mine.length} positions state ${locations.size} different locations`,
			conflicting: mine,
		}
	}

	return {
		status: "resolved",
		latitude: first.latitude,
		longitude: first.longitude,
		synthetic: mine.every((position) => position.synthetic),
		positions: mine,
	}
}
