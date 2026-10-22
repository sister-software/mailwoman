/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Structure sources published in Germany.
 *
 *   Germany's open 3D building data is published by each state. The nationwide LoD2-DE product is sold under
 *   separate terms, so each source here records its state as `region`.
 */

import { LicenseReviewState, type LicenseDecision } from "@mailwoman/core/license/decision"

import { permittedByGrant } from "#grants"
import { StructureDetail, type StructureOperation, type StructureSource } from "#types"

/**
 * Germany's structure sources, one per publishing state, from the 2026-10-22 landmark-data research handoff.
 */
export const DE_SOURCES: readonly StructureSource[] = [
	{
		sourceID: "de-hh-lod3",
		jurisdiction: "de",
		region: "DE-HH",
		name: "3D-Gebäudemodell LoD3.0-HH (untexturiert)",
		publisher: "Landesbetrieb Geoinformation und Vermessung (LGV), Freie und Hansestadt Hamburg",
		datasetURL: "https://data.gov.de/suche/daten/3d-gebaudemodell-lod3-0-hh-hamburg-untexturiert",
		detail: [StructureDetail.LoD3],
		formats: ["CityGML"],
		license: "de-hh-lod3",
		attribution:
			"Freie und Hansestadt Hamburg, Landesbetrieb Geoinformation und Vermessung, dl-de/by-2-0, modified by Mailwoman",
		attributionURL: "https://www.govdata.de/dl-de/by-2-0",
		note:
			"LoD3.0-HH is Hamburg's own variant: manually interpreted roofscapes from 2020 imagery, without modeled " +
			"windows or doors. The textured release is a separate distribution with its own record.",
	},
	{
		sourceID: "de-be-lod2",
		jurisdiction: "de",
		region: "DE-BE",
		name: "3D-Gebäudemodelle im Level of Detail 2 (LoD 2)",
		publisher: "Senatsverwaltung für Stadtentwicklung, Bauen und Wohnen Berlin",
		datasetURL: "https://daten.berlin.de/datensaetze/3d-gebaudemodelle-im-level-of-detail-2-lod-2-3c7c49af",
		detail: [StructureDetail.LoD2],
		formats: ["CityGML"],
		license: "de-be-lod2",
		attribution: "Geoportal Berlin / 3D-Gebäudemodelle im Level of Detail 2 (LoD 2), dl-de/zero-2-0",
		attributionURL: "https://gdi.berlin.de/data/a_lod2/atom/",
		note: "Berlin's photogrammetric mesh is a different distribution, and this decision does not cover it.",
	},
]

/**
 * The license decisions {@link DE_SOURCES} point at.
 */
export const DE_LICENSES: readonly LicenseDecision<StructureOperation>[] = [
	{
		licenseID: "de-hh-lod3",
		state: LicenseReviewState.Elected,
		electedTerms: "Datenlizenz Deutschland – Namensnennung – Version 2.0",
		spdx: "DL-DE-BY-2.0",
		retrievedCopy: "packages/structures/data/licenses/de-hh-lod3-untextured.md",
		retrievedAt: "2026-10-22",
		electedBecause:
			"The untextured release's MetaVer record states DL-DE BY 2.0 as its Nutzungsbedingungen. " +
			"The license text is in packages/structures/data/licenses/de-hh-lod3.md.",
		operations: permittedByGrant({
			fetch: 'DL-DE BY 2.0 §1: data may "be copied, printed, presented".',
			convert: 'DL-DE BY 2.0 §1: data may be "altered, processed and transmitted to third parties".',
			adapt: "DL-DE BY 2.0 §1 permits altering and processing. §3 requires changes to be marked in the source note.",
			redistribute: "DL-DE BY 2.0 §1 permits transmission to third parties, with the §2 source note.",
			"commercial-sublicense":
				'DL-DE BY 2.0 §1 permits integration "in internal and external business processes, products and applications".',
		}),
	},
	{
		licenseID: "de-be-lod2",
		state: LicenseReviewState.Elected,
		electedTerms: "Datenlizenz Deutschland – Zero – Version 2.0",
		spdx: "DL-DE-ZERO-2.0",
		retrievedCopy: "packages/structures/data/licenses/de-be-lod2.md",
		retrievedAt: "2026-10-22",
		electedBecause: "The publisher's Atom download feed states DL-DE Zero 2.0 for the data.",
		operations: permittedByGrant({
			fetch: 'DL-DE Zero 2.0: "Any use is permitted without restrictions or conditions."',
			convert: 'DL-DE Zero 2.0 permits data to be "altered, processed and transmitted to third parties".',
			adapt: "DL-DE Zero 2.0 permits altering, processing and combining into new datasets.",
			redistribute: "DL-DE Zero 2.0 permits transmission to third parties without conditions.",
			"commercial-sublicense":
				'DL-DE Zero 2.0 permits integration "in internal and external business processes, products and applications".',
		}),
	},
]
