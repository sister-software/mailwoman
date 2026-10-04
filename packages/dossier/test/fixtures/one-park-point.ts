/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   One Park Point — 11 Ocean Parkway, Brooklyn (tax lot BBL 3053220010, BIN 3429422) — the first
 *   dossier built from independently retrieved public records rather than synthetic fixtures.
 *
 *   Provenance, all retrieved 2026-10-05:
 *
 *   - NYC DOB NOW: Build — Job Application Filings (Socrata w9ak-ipjd), filing B00520132-I1, the new
 *     building: filed 2021-09-16, approved 2022-11-11, first permit 2022-11-15. The DOB NOW Public
 *     Portal has published NB filings, searchable by address, since the 2021-03-01 expansion that added
 *     the New Building job type (nyc.gov DOB NOW guidance, and PincusCo, 2021-09-03), so a filing's
 *     `availableAt` is its filing date and each dated status's `availableAt` is that status's date.
 *   - NYC DOB Job Application Filings (Socrata ic3t-wcy2, the legacy BIS mirror), builders pavement plan
 *     filings 3314476 and 3314484. Their `dobrundate` (2022-05-03) is the dataset's own publication
 *     stamp and serves as `availableAt`.
 *   - NYC DCP PLUTO 26v2 (Socrata 64uk-42ks, rowsUpdatedAt 2026-08-24): 375 residential units, 379
 *     total, 13 floors, year built 2022, owner of record International Baptist Church (the ground
 *     lessor. JEMB Realty is the development entity named as owner on the DOB filings).
 *   - NYC Planning Geosearch (PAD 26c), live lookup: address 11 Ocean Parkway ↔ BIN 3429422 ↔ BBL
 *     3053220010. A live service, so `availableAt` is the retrieval date.
 *   - FCC Broadband Data Collection, through the National Broadband Map Public Data API
 *     (bdc.fcc.gov, credentialed). Three files, all NY state location coverage: cable as of
 *     2022-06-30 (file bdc_36_Cable_fixed_broadband_J22_10may2024) and fiber-to-the-premises as of
 *     2022-06-30 (bdc_36_FibertothePremises_fixed_broadband_J22_10may2024) and as of 2025-12-31
 *     (bdc_36_FibertothePremises_fixed_broadband_D25_29sep2026). The 2022-06-30 vintage first became
 *     public with the National Broadband Map launch on 2022-11-18, so its `availableAt` is that launch
 *     date: a dossier built for mid-2022 cannot have known it. Rows are provider-filed claims, so a
 *     block with no row is `source_present` empty, never established absence. Readings are block- and
 *     tract-scoped because the location id was not joined to the Fabric on this pass. Provider
 *     availability below therefore reads at census-block granularity rather than per-premises.
 *
 *   Claims in a dossier are scoped to record fields dated on or before the cutoff, so a row retrieved
 *   today does not leak its later statuses into an earlier `asOf`.
 */

import type { ProviderAvailability } from "#availability"
import { type Claim, ClaimAxis } from "#claims"
import { type UnitCount, UnitStage } from "#counts"
import type { LayerReading } from "#coverage"
import type { Entity } from "#entities"
import type { OrganizationRelation, ConstructionWindow } from "#events"
import { entityID } from "#identifiers"
import { type Alias, type Containment, ContainmentRelation } from "#links"
import type { SourceRecord } from "#sources"
import type { DossierRecords } from "#validate"

const OPP_PARCEL = entityID("parcel", "nyc-bbl-3053220010")
export const OPP_BUILDING = entityID("building", "nyc-bin-3429422")

const OPP_SOURCES: SourceRecord[] = [
	{
		id: "dobnow-filing-b00520132-i1",
		publisher: "NYC Department of Buildings",
		title: "DOB NOW: Build — New Building filing B00520132-I1",
		url: "https://data.cityofnewyork.us/resource/w9ak-ipjd.json?job_filing_number=B00520132-I1",
		observedAt: "2021-09-16",
		availableAt: "2021-09-16",
		retrievedAt: "2026-10-05",
	},
	{
		id: "dobnow-approval-b00520132-i1",
		publisher: "NYC Department of Buildings",
		title: "DOB NOW: Build — approval of B00520132-I1",
		url: "https://data.cityofnewyork.us/resource/w9ak-ipjd.json?job_filing_number=B00520132-I1",
		observedAt: "2022-11-11",
		availableAt: "2022-11-11",
		retrievedAt: "2026-10-05",
	},
	{
		id: "dobnow-first-permit-b00520132-i1",
		publisher: "NYC Department of Buildings",
		title: "DOB NOW: Build — first permit on B00520132-I1",
		url: "https://data.cityofnewyork.us/resource/w9ak-ipjd.json?job_filing_number=B00520132-I1",
		observedAt: "2022-11-15",
		availableAt: "2022-11-15",
		retrievedAt: "2026-10-05",
	},
	{
		id: "dob-bpp-3314476",
		publisher: "NYC Department of Buildings",
		title: "DOB Job Application Filings — builders pavement plan 3314476",
		url: "https://data.cityofnewyork.us/resource/ic3t-wcy2.json?job_s1_no=3314476",
		observedAt: "2021-09-17",
		availableAt: "2022-05-03",
		retrievedAt: "2026-10-05",
	},
	{
		id: "pluto-26v2",
		publisher: "NYC Department of City Planning",
		title: "PLUTO 26v2 — tax lot 3053220010",
		url: "https://data.cityofnewyork.us/resource/64uk-42ks.json?bbl=3053220010",
		observedAt: "2026-08-24",
		availableAt: "2026-08-24",
		retrievedAt: "2026-10-05",
	},
	{
		id: "pad-geosearch-26c",
		publisher: "NYC Planning",
		title: "Geosearch / PAD 26c — 11 Ocean Parkway",
		url: "https://geosearch.planninglabs.nyc/v2/search?text=11%20OCEAN%20PARKWAY%2C%20Brooklyn",
		availableAt: "2026-10-05",
		retrievedAt: "2026-10-05",
	},
	{
		id: "fcc-bdc-cable-j22",
		publisher: "Federal Communications Commission",
		title: "BDC fixed broadband availability — NY cable, as of 2022-06-30",
		url: "https://bdc.fcc.gov/api/public/map/downloads/downloadFile/availability/558779",
		observedAt: "2022-06-30",
		availableAt: "2022-11-18",
		retrievedAt: "2026-10-05",
	},
	{
		id: "fcc-bdc-fttp-j22",
		publisher: "Federal Communications Commission",
		title: "BDC fixed broadband availability — NY fiber to the premises, as of 2022-06-30",
		url: "https://bdc.fcc.gov/api/public/map/downloads/downloadFile/availability/558835",
		observedAt: "2022-06-30",
		availableAt: "2022-11-18",
		retrievedAt: "2026-10-05",
	},
	{
		id: "fcc-bdc-fttp-d25",
		publisher: "Federal Communications Commission",
		title: "BDC fixed broadband availability — NY fiber to the premises, as of 2025-12-31",
		url: "https://bdc.fcc.gov/api/public/map/downloads/downloadFile/availability/1810679",
		observedAt: "2025-12-31",
		availableAt: "2026-09-29",
		retrievedAt: "2026-10-05",
	},
]

const OPP_ENTITIES: Entity[] = [
	{
		id: OPP_PARCEL,
		kind: "parcel",
		externalIDs: [{ namespace: "nyc:bbl", value: "3053220010" }],
		label: "Brooklyn tax lot 5322-10",
	},
	{
		id: OPP_BUILDING,
		kind: "building",
		externalIDs: [{ namespace: "nyc:bin", value: "3429422" }],
		label: "11 Ocean Parkway",
	},
]

const OPP_ALIASES: Alias[] = [
	{
		text: "11 Ocean Parkway, Brooklyn, NY 11218",
		candidates: [{ entity: OPP_BUILDING, evidence: { source: "pad-geosearch-26c" } }],
	},
]

const OPP_CONTAINMENT: Containment[] = [
	{
		child: OPP_BUILDING,
		parent: OPP_PARCEL,
		relation: ContainmentRelation.BuildingOn,
		evidence: { source: "dobnow-filing-b00520132-i1", observedAt: "2021-09-16" },
	},
]

const OPP_CLAIMS: Claim[] = [
	{
		id: "opp-stories",
		subject: OPP_BUILDING,
		axis: ClaimAxis.Premises,
		predicate: "proposed_stories",
		value: 13,
		status: "observed",
		evidence: { source: "dobnow-filing-b00520132-i1" },
	},
	{
		id: "opp-height",
		subject: OPP_BUILDING,
		axis: ClaimAxis.Premises,
		predicate: "proposed_height_ft",
		value: 145,
		status: "observed",
		evidence: { source: "dobnow-filing-b00520132-i1" },
	},
	{
		id: "opp-floor-area",
		subject: OPP_BUILDING,
		axis: ClaimAxis.Premises,
		predicate: "total_construction_floor_area_sqft",
		value: 395_643,
		status: "observed",
		evidence: { source: "dobnow-filing-b00520132-i1" },
	},
	{
		id: "opp-initial-cost",
		subject: OPP_BUILDING,
		axis: ClaimAxis.Engineering,
		predicate: "initial_cost_usd",
		value: 20_000_000,
		status: "observed",
		evidence: { source: "dobnow-filing-b00520132-i1" },
	},
	{
		id: "opp-zoning",
		subject: OPP_BUILDING,
		axis: ClaimAxis.Premises,
		predicate: "zoning",
		value: "R8A within the Special Ocean Parkway District",
		status: "observed",
		evidence: { source: "dob-bpp-3314476" },
	},
	{
		id: "opp-pluto-total-units",
		subject: OPP_BUILDING,
		axis: ClaimAxis.Premises,
		predicate: "total_tax_lot_units",
		value: 379,
		status: "observed",
		evidence: { source: "pluto-26v2" },
	},
	{
		id: "opp-year-built",
		subject: OPP_BUILDING,
		axis: ClaimAxis.Premises,
		predicate: "year_built",
		value: 2022,
		status: "observed",
		evidence: { source: "pluto-26v2" },
	},
]

const OPP_COUNTS: UnitCount[] = [
	{
		id: "opp-planned-residential",
		subject: OPP_BUILDING,
		stage: UnitStage.Planned,
		count: 375,
		at: "2021-09-16",
		membership: "nyc-bbl-3053220010:residential",
		evidence: { source: "dobnow-filing-b00520132-i1" },
	},
	{
		id: "opp-completed-residential",
		subject: OPP_BUILDING,
		stage: UnitStage.Completed,
		count: 375,
		at: "2026-08-24",
		membership: "nyc-bbl-3053220010:residential",
		evidence: { source: "pluto-26v2" },
	},
]

const OPP_RELATIONS: OrganizationRelation[] = [
	{
		organization: "JEMB Realty",
		role: "developer",
		subject: OPP_BUILDING,
		signingAuthority: "unknown",
		evidence: { source: "dobnow-filing-b00520132-i1" },
	},
	{
		organization: "FXCollaborative Architects LLP",
		role: "architect",
		subject: OPP_BUILDING,
		signingAuthority: "unknown",
		evidence: { source: "dobnow-filing-b00520132-i1" },
	},
	{
		organization: "International Baptist Church",
		role: "owner",
		subject: OPP_BUILDING,
		signingAuthority: "unknown",
		evidence: { source: "pluto-26v2" },
	},
]

const OPP_WINDOWS: ConstructionWindow[] = [
	{
		subject: OPP_BUILDING,
		start: "2021-09-16",
		stage: "new building filed, standard plan examination",
		evidence: { source: "dobnow-filing-b00520132-i1" },
	},
	{
		subject: OPP_BUILDING,
		start: "2022-11-15",
		stage: "first permit issued",
		evidence: { source: "dobnow-first-permit-b00520132-i1" },
	},
]

const OPP_READINGS: LayerReading[] = [
	{
		layer: "fcc-bdc-fttp",
		extent: "census-block:360470504012000",
		basis: "source_present",
		surveyedAt: "2022-06-30",
		records: 0,
		evidence: { source: "fcc-bdc-fttp-j22" },
	},
	{
		layer: "fcc-bdc-fttp",
		extent: "census-tract:36047050401",
		basis: "source_present",
		surveyedAt: "2022-06-30",
		records: 70,
		evidence: { source: "fcc-bdc-fttp-j22" },
	},
	{
		layer: "fcc-bdc-cable",
		extent: "census-block:360470504012000",
		basis: "source_present",
		surveyedAt: "2022-06-30",
		records: 2,
		evidence: { source: "fcc-bdc-cable-j22" },
	},
	{
		layer: "fcc-bdc-fttp",
		extent: "census-block:360470504012000",
		basis: "source_present",
		surveyedAt: "2025-12-31",
		records: 6,
		evidence: { source: "fcc-bdc-fttp-d25" },
	},
]

const OPP_AVAILABILITY: ProviderAvailability[] = [
	{
		provider: "Charter Communications (Spectrum)",
		subject: OPP_BUILDING,
		product: "cable 1000/35 Mbps (census block, business)",
		from: "2022-06-30",
		evidence: { source: "fcc-bdc-cable-j22" },
	},
	{
		provider: "Verizon",
		subject: OPP_BUILDING,
		product: "fiber to the premises 2300/2300 Mbps (census block, residential)",
		from: "2025-12-31",
		evidence: { source: "fcc-bdc-fttp-d25" },
	},
]

export const OPP_RECORDS: DossierRecords = {
	sources: OPP_SOURCES,
	entities: OPP_ENTITIES,
	aliases: OPP_ALIASES,
	containment: OPP_CONTAINMENT,
	claims: OPP_CLAIMS,
	counts: OPP_COUNTS,
	events: [],
	relations: OPP_RELATIONS,
	windows: OPP_WINDOWS,
	availability: OPP_AVAILABILITY,
	readings: OPP_READINGS,
	filings: [],
}
