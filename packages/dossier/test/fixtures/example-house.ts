/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The fictional Example House, Example Annex and Example Parcel that every scenario in the spec uses.
 *   Dates are chosen so that an `asOf` of 2022-06-30 admits the permit and the first inspection and
 *   excludes the later manager statement. The permit states the parcel's lot number and each building's
 *   identification number, so each identifier cites the permit.
 *
 *   The cable check on Example House fails at a source-present empty reading, and the operator's log
 *   records one investigation of it with its outcome.
 *
 *   The survey places Example House in cell-1, and the permit places both buildings in district-1. No
 *   record places a building in cell-3, so the survey's cable reading there attaches to no building. Every
 *   position is synthetic: its coordinates lie in the open South Atlantic, where no building stands. The
 *   permit and the survey state two different positions for Example Annex.
 */

import type { ProviderAvailability } from "#availability"
import { type Claim, ClaimAxis } from "#claims"
import { type UnitCount, UnitStage } from "#counts"
import type { LayerReading } from "#coverage"
import type { Entity } from "#entities"
import {
	type CommercialEvent,
	CommercialEventKind,
	type ConstructionWindow,
	type OrganizationRelation,
	OrganizationRole,
} from "#events"
import { type AvailabilityCheck, ExplanationKind, type OperatorDisposition } from "#explanations"
import type { FilingRow } from "#filings"
import { entityID } from "#identifiers"
import { type Alias, type Containment, ContainmentRelation } from "#links"
import type { BuildingPosition, ExtentMembership } from "#placement"
import type { SourceRecord } from "#sources"
import type { DossierRecords } from "#validate"

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
	{
		id: "operator-log-2022",
		publisher: "Example Operator",
		title: "Investigation log",
		observedAt: "2022-06-20",
		availableAt: "2022-06-25",
		retrievedAt: "2026-10-04",
	},
]

/**
 * The permit's statement of an identifier.
 */
const permitEvidence = { source: "permit-2021", observedAt: "2021-05-10" }

export const ENTITIES: Entity[] = [
	{
		id: PARCEL,
		kind: "parcel",
		externalIDs: [{ namespace: "example:lot", value: "12-34", evidence: permitEvidence }],
		label: "Example Parcel",
	},
	{
		id: HOUSE,
		kind: "building",
		externalIDs: [{ namespace: "example:bin", value: "1001", evidence: permitEvidence }],
		label: "Example House",
	},
	{
		id: ANNEX,
		kind: "building",
		externalIDs: [{ namespace: "example:bin", value: "1002", evidence: permitEvidence }],
		label: "Example Annex",
	},
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

const CLAIMS: Claim[] = [
	{
		id: "c1",
		subject: HOUSE,
		axis: ClaimAxis.Premises,
		predicate: "storeys",
		value: 13,
		status: "observed",
		evidence: { source: "permit-2021", observedAt: "2021-05-10" },
	},
	{
		id: "c2",
		subject: HOUSE,
		axis: ClaimAxis.Network,
		predicate: "nearest_cabinet_connects",
		value: "unknown",
		status: "inferred",
		derivedFrom: ["c1"],
		explanation: "A cabinet within 40 m is an observation of proximity, and connection requires its own record.",
		evidence: { source: "survey-2022" },
	},
]

export const PLANNED: UnitCount = {
	id: "p",
	subject: HOUSE,
	stage: UnitStage.Planned,
	count: 24,
	at: "2021-05-10",
	membership: "example-house:all",
	evidence: { source: "permit-2021" },
}

export const COMPLETED20: UnitCount = {
	id: "c20",
	subject: HOUSE,
	stage: UnitStage.Completed,
	count: 20,
	at: "2022-04-01",
	membership: "example-house:all",
	evidence: { source: "inspection-2022", observedAt: "2022-04-01" },
}

export const COMPLETED22: UnitCount = {
	id: "c22",
	subject: HOUSE,
	stage: UnitStage.Completed,
	count: 22,
	at: "2022-04-01",
	membership: "example-house:all",
	evidence: { source: "undated-listing" },
}

export const OCCUPIED: UnitCount = {
	id: "o",
	subject: HOUSE,
	stage: UnitStage.Occupied,
	count: 18,
	at: "2023-02-01",
	membership: "example-house:all",
	evidence: { source: "manager-2023" },
}

const COUNTS: UnitCount[] = [PLANNED, COMPLETED20, COMPLETED22, OCCUPIED]

export const EVENTS: CommercialEvent[] = [
	{
		id: "e1",
		kind: CommercialEventKind.Inquiry,
		parties: [{ name: "Household A", role: "resident" }],
		scope: [HOUSE],
		date: "2022-05-01",
		evidence: { source: "manager-2023" },
	},
	{
		id: "e2",
		kind: CommercialEventKind.Order,
		parties: [{ name: "Household B", role: "resident" }],
		scope: [HOUSE],
		date: "2022-05-02",
		evidence: { source: "manager-2023" },
	},
	{
		id: "e3",
		kind: CommercialEventKind.ActiveSubscription,
		parties: [{ name: "Household C", role: "resident" }],
		scope: [HOUSE],
		date: "2022-05-03",
		evidence: { source: "manager-2023" },
	},
	{
		id: "e4",
		kind: CommercialEventKind.LandlordPermission,
		parties: [{ name: "Example Management Co", role: "manager" }],
		scope: [NORTH],
		date: "2022-05-10",
		evidence: { source: "survey-2022" },
	},
	{
		id: "e5",
		kind: CommercialEventKind.ActiveSubscription,
		parties: [{ name: "Household D", role: "resident" }],
		scope: [HOUSE],
		evidence: { source: "undated-listing" },
	},
]

export const RELATIONS: OrganizationRelation[] = [
	{
		organization: "Example Holdings LLC",
		role: OrganizationRole.Owner,
		subject: HOUSE,
		signingAuthority: "unknown",
		evidence: { source: "permit-2021" },
	},
	{
		organization: "Example Management Co",
		role: OrganizationRole.Manager,
		subject: HOUSE,
		signingAuthority: "unknown",
		evidence: { source: "manager-2023" },
	},
]

const WINDOWS: ConstructionWindow[] = [
	{ subject: HOUSE, start: "2021-06-01", stage: "permit issued", evidence: { source: "permit-2021" } },
]

export const AVAILABILITY: ProviderAvailability[] = [
	{
		provider: "Example Fiber",
		subject: HOUSE,
		product: "1 Gbps",
		from: "2022-03-01",
		to: "2022-09-30",
		evidence: { source: "survey-2022" },
	},
]

const surveyEvidence = { source: "survey-2022" }

export const MISSING_READING: LayerReading = {
	layer: "ducts",
	extent: "cell-1",
	basis: null,
	records: null,
	evidence: surveyEvidence,
}

export const SURVEYED_EMPTY_READING: LayerReading = {
	layer: "cabinets",
	extent: "cell-1",
	basis: "surveyed",
	surveyedAt: "2022-03-15",
	records: 0,
	evidence: surveyEvidence,
}

export const SOURCE_PRESENT_EMPTY_READING: LayerReading = {
	layer: "poles",
	extent: "cell-1",
	basis: "source_present",
	records: 0,
	evidence: surveyEvidence,
}

export const POSITIVE_READING: LayerReading = {
	layer: "cabinets",
	extent: "cell-1",
	basis: "source_present",
	records: 1,
	evidence: { source: "undated-listing" },
}

/**
 * The cable reading that fails {@link CABLE_CHECK}: the source looked at cell-1 and found no record.
 */
const CABLE_EMPTY_READING: LayerReading = {
	layer: "cable",
	extent: "cell-1",
	basis: "source_present",
	surveyedAt: "2022-03-15",
	records: 0,
	evidence: surveyEvidence,
}

/**
 * Cable records in the surrounding district on the same survey.
 */
const CABLE_DISTRICT_READING: LayerReading = {
	layer: "cable",
	extent: "district-1",
	basis: "source_present",
	surveyedAt: "2022-03-15",
	records: 4,
	evidence: surveyEvidence,
}

/**
 * Cable records over cell-3 on the same survey.
 * No membership places a building in cell-3.
 */
const CABLE_CELL3_READING: LayerReading = {
	layer: "cable",
	extent: "cell-3",
	basis: "source_present",
	surveyedAt: "2022-03-15",
	records: 2,
	evidence: surveyEvidence,
}

const READINGS: LayerReading[] = [
	MISSING_READING,
	SURVEYED_EMPTY_READING,
	SOURCE_PRESENT_EMPTY_READING,
	POSITIVE_READING,
	CABLE_EMPTY_READING,
	CABLE_DISTRICT_READING,
	CABLE_CELL3_READING,
]

const MEMBERSHIPS: ExtentMembership[] = [
	{ subject: HOUSE, extent: "cell-1", evidence: { source: "survey-2022", observedAt: "2022-03-15" } },
	{ subject: HOUSE, extent: "district-1", evidence: { source: "permit-2021" } },
	{ subject: ANNEX, extent: "district-1", evidence: { source: "permit-2021" } },
]

export const HOUSE_POSITION: BuildingPosition = {
	subject: HOUSE,
	latitude: -30.00012,
	longitude: -20.00034,
	synthetic: true,
	evidence: { source: "survey-2022", observedAt: "2022-03-15" },
}

export const ANNEX_PERMIT_POSITION: BuildingPosition = {
	subject: ANNEX,
	latitude: -30.00021,
	longitude: -20.00032,
	synthetic: true,
	evidence: { source: "permit-2021" },
}

export const ANNEX_SURVEY_POSITION: BuildingPosition = {
	subject: ANNEX,
	latitude: -30.00025,
	longitude: -20.00041,
	synthetic: true,
	evidence: { source: "survey-2022", observedAt: "2022-03-15" },
}

/**
 * Whether the cable layer's source holds service at cell-1, where it keys Example House.
 */
export const CABLE_CHECK: AvailabilityCheck = { id: "house-cable", subject: HOUSE, layer: "cable", extent: "cell-1" }

export const ACCESS_DISPOSITION: OperatorDisposition = {
	id: "d1",
	check: CABLE_CHECK.id,
	investigated: ExplanationKind.Access,
	decision: "Ask Example Management Co whether the provider holds permission for the south entrance",
	decidedAt: "2022-06-01",
	evidence: { source: "operator-log-2022" },
	outcome: {
		held: true,
		at: "2022-06-20",
		minutesSpent: 30,
		baselineMinutes: 90,
		evidence: { source: "operator-log-2022" },
	},
}

export const FILING_ROWS: FilingRow[] = [
	{
		block: "360470001001000",
		provider: "Example Cable",
		technology: "cable",
		speedTier: "100/20",
		evidence: { source: "survey-2022" },
	},
	{
		block: "360470001001000",
		provider: "Example Cable",
		technology: "cable",
		speedTier: "1000/35",
		evidence: { source: "survey-2022" },
	},
]

export const EXAMPLE_RECORDS: DossierRecords = {
	sources: SOURCES,
	entities: ENTITIES,
	aliases: ALIASES,
	containment: CONTAINMENT,
	claims: CLAIMS,
	counts: COUNTS,
	events: EVENTS,
	relations: RELATIONS,
	windows: WINDOWS,
	availability: AVAILABILITY,
	readings: READINGS,
	filings: FILING_ROWS,
	memberships: MEMBERSHIPS,
	positions: [HOUSE_POSITION, ANNEX_PERMIT_POSITION, ANNEX_SURVEY_POSITION],
	checks: [CABLE_CHECK],
	dispositions: [ACCESS_DISPOSITION],
}

/**
 * The example records with each external identifier stripped of its evidence.
 *
 * The tests of an identifier whose source is unstated read these records.
 */
export const UNSTATED_IDENTIFIER_RECORDS: DossierRecords = {
	...EXAMPLE_RECORDS,
	entities: ENTITIES.map((entity) => ({
		...entity,
		externalIDs: entity.externalIDs.map(({ namespace, value }) => ({ namespace, value })),
	})),
}

export const EMPTY_RECORDS: DossierRecords = {
	sources: [],
	entities: [],
	aliases: [],
	containment: [],
	claims: [],
	counts: [],
	events: [],
	relations: [],
	windows: [],
	availability: [],
	readings: [],
	filings: [],
}
