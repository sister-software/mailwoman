/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Structure sources published in Finland.
 */

import { LicenseReviewState, type LicenseDecision } from "@mailwoman/core/license/decision"

import { permittedByGrant } from "#grants"
import { StructureDetail, type StructureOperation, type StructureSource } from "#types"

/**
 * Finland's structure sources, from the 2026-10-22 landmark-data research handoff.
 */
export const FI_SOURCES: readonly StructureSource[] = [
	{
		sourceID: "fi-helsinki-3d",
		jurisdiction: "fi",
		region: "FI-18",
		municipality: "Helsinki",
		name: "Helsinki 3D city model and reality mesh",
		publisher: "City of Helsinki",
		datasetURL: "https://www.hel.fi/en/decision-making/information-on-helsinki/maps-and-geospatial-data/helsinki-3d",
		detail: [StructureDetail.LoD2, StructureDetail.Mesh],
		formats: ["CityGML", "OBJ", "3MX"],
		license: "fi-helsinki-3d",
		attribution: "Helsinki 3D city model and mesh © City of Helsinki, CC BY 4.0, modified by Mailwoman",
		attributionURL:
			"https://www.hel.fi/en/decision-making/information-on-helsinki/maps-and-geospatial-data/helsinki-3d",
		note: "Coordinates are ETRS-GK25 with N2000 heights, so conversion must reproject both axes and the datum.",
	},
]

/**
 * The license decisions {@link FI_SOURCES} point at.
 */
export const FI_LICENSES: readonly LicenseDecision<StructureOperation>[] = [
	{
		licenseID: "fi-helsinki-3d",
		state: LicenseReviewState.Elected,
		electedTerms: "Creative Commons Attribution 4.0 International",
		spdx: "CC-BY-4.0",
		retrievedCopy: "packages/structures/data/licenses/fi-helsinki-3d.md",
		retrievedAt: "2026-10-22",
		electedBecause: "The city's page states CC BY 4.0 for both the urban data model and the 3D mesh.",
		operations: permittedByGrant({
			fetch: "CC BY 4.0 §2(a)(1)(A) grants reproduction.",
			convert: "CC BY 4.0 §2(a)(1)(B) grants producing Adapted Material.",
			adapt: "CC BY 4.0 §2(a)(1)(B) grants producing Adapted Material.",
			redistribute: "CC BY 4.0 §2(a)(1) grants sharing, conditioned by §3(a) on attribution and a modification note.",
			"commercial-sublicense": "CC BY 4.0 places no restriction on commercial use.",
		}),
	},
]
