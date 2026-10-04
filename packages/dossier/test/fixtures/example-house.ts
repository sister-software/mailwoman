/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The fictional Example House, Example Annex and Example Parcel that every scenario in the spec uses.
 *   Dates are chosen so that an `asOf` of 2022-06-30 admits the permit and the first inspection and
 *   excludes the later manager statement.
 */

import type { Entity } from "#entities"
import { entityID } from "#identifiers"
import { type Alias, type Containment, ContainmentRelation } from "#links"
import type { SourceRecord } from "#sources"

export const PARCEL = entityID("parcel", "example-parcel")
export const HOUSE = entityID("building", "example-house")
export const ANNEX = entityID("building", "example-annex")
export const NORTH = entityID("entrance", "example-house-north")
export const SOUTH = entityID("entrance", "example-house-south")

export const SOURCES: SourceRecord[] = [
	{
		id: "permit-2021",
		publisher: "Example City Buildings Department",
		title: "New building permit",
		observedAt: "2021-05-10",
		availableAt: "2021-05-12",
		retrievedAt: "2026-10-04",
	},
	{
		id: "inspection-2022",
		publisher: "Example City Buildings Department",
		title: "Inspection record",
		observedAt: "2022-04-01",
		availableAt: "2022-04-03",
		retrievedAt: "2026-10-04",
	},
	{
		id: "manager-2023",
		publisher: "Example Management Co",
		title: "Manager statement",
		observedAt: "2023-02-01",
		availableAt: "2023-02-01",
		retrievedAt: "2026-10-04",
	},
	{
		id: "survey-2022",
		publisher: "Example Surveyor",
		title: "Entrance survey",
		observedAt: "2022-03-15",
		availableAt: "2022-03-20",
		retrievedAt: "2026-10-04",
	},
	{ id: "undated-listing", publisher: "Example Listings", title: "Rental listing", retrievedAt: "2026-10-04" },
]

export const ENTITIES: Entity[] = [
	{ id: PARCEL, kind: "parcel", externalIDs: [{ namespace: "example:lot", value: "12-34" }], label: "Example Parcel" },
	{ id: HOUSE, kind: "building", externalIDs: [{ namespace: "example:bin", value: "1001" }], label: "Example House" },
	{ id: ANNEX, kind: "building", externalIDs: [{ namespace: "example:bin", value: "1002" }], label: "Example Annex" },
	{ id: NORTH, kind: "entrance", externalIDs: [], label: "North entrance" },
	{ id: SOUTH, kind: "entrance", externalIDs: [], label: "South entrance" },
]

export const ALIASES: Alias[] = [
	{
		text: "North entrance, Example House",
		candidates: [{ entity: NORTH, evidence: { source: "survey-2022", observedAt: "2022-03-15" } }],
	},
	{
		text: "South entrance, Example House",
		candidates: [{ entity: SOUTH, evidence: { source: "survey-2022", observedAt: "2022-03-15" } }],
	},
]

export const CONTAINMENT: Containment[] = [
	{
		child: NORTH,
		parent: HOUSE,
		relation: ContainmentRelation.EntranceOf,
		evidence: { source: "survey-2022", observedAt: "2022-03-15" },
	},
	{
		child: SOUTH,
		parent: HOUSE,
		relation: ContainmentRelation.EntranceOf,
		evidence: { source: "survey-2022", observedAt: "2022-03-15" },
	},
	{
		child: HOUSE,
		parent: PARCEL,
		relation: ContainmentRelation.BuildingOn,
		evidence: { source: "permit-2021", observedAt: "2021-05-10" },
	},
	{
		child: ANNEX,
		parent: PARCEL,
		relation: ContainmentRelation.BuildingOn,
		evidence: { source: "permit-2021", observedAt: "2021-05-10" },
	},
]
