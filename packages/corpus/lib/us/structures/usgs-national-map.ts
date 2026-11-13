// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   The United States entry of the structures layer: every point layer of the
 *   USGS National Map structures MapServer (`#us/structures/usgs-layers`),
 *   as `mailwoman corpus fetch usgs-structures` writes them.
 *
 *   Each record is filed under its layer's POI category, so the post offices of layer
 *   38 are the United States' post offices in the post-office parse suite.
 *
 *   The list is the USGS's compilation rather than each operator's own facility list,
 *   so its provenance is a mapping agency's.
 *   A work of the United States Government, public domain under 17 U.S.C. § 105.
 */

import type { PathBuilder } from "path-ts"
import { JSONSpliterator } from "spliterator"

import { createUnitSplitter, type UnitSplitter } from "#adapters/street/unit"
import {
	StructureProvenance,
	type StructureRecord,
	type StructureSource,
	type StructureSourceRead,
} from "#structures/source"
import { readManifest } from "#tools/fetch/download"
import {
	USGOV_USGS_STRUCTURES_ADAPTER_ID,
	USGS_STRUCTURES_FILENAME,
	type USGSStructureFeature,
	usgsStructureAddress,
} from "#us/adapters/usgov/usgs-structures/adapter"
import { usgsStructureLayer } from "#us/structures/usgs-layers"
import type { USGSStructuresManifest } from "#us/tools/fetch/usgs-structures"

/**
 * One fetched feature as a structure record, or `null` when it has no permanent identifier.
 *
 * The address is split as the `usgov-usgs-structures` adapter splits it.
 */
export function usgsStructureRecord(feature: USGSStructureFeature, units: UnitSplitter): StructureRecord | null {
	const id = feature.properties.permanent_identifier

	if (!id) return null

	const [longitude, latitude] = feature.geometry?.coordinates ?? []

	return {
		id,
		name: feature.properties.name,
		category: usgsStructureLayer(feature.properties.layer_id).poiCategory,
		point: typeof latitude === "number" && typeof longitude === "number" ? { latitude, longitude } : null,
		address: usgsStructureAddress(feature.properties, units),
	}
}

async function* records(path: PathBuilder): AsyncIterable<StructureRecord> {
	const units = await createUnitSplitter()

	for await (const feature of JSONSpliterator.fromAsync<USGSStructureFeature>(path.toString())) {
		const record = usgsStructureRecord(feature, units)

		if (record) {
			yield record
		}
	}
}

const FETCH_COMMAND = "mailwoman corpus fetch usgs-structures"

/**
 * The USGS National Map's structures.
 */
export const usgsNationalMapStructures: StructureSource = {
	id: "usgs-national-map",
	country: "US",
	publisher: "U.S. Geological Survey",
	attribution: "U.S. Geological Survey, The National Map",
	license: "LicenseRef-USGov-Public-Domain",
	registerSource: "us-public-administration-3",
	provenance: StructureProvenance.MappingAgency,
	fetchCommand: FETCH_COMMAND,

	async read(sourcesRoot): Promise<StructureSourceRead> {
		const directory = sourcesRoot(USGOV_USGS_STRUCTURES_ADAPTER_ID)
		const manifest = await readManifest<USGSStructuresManifest>(directory("MANIFEST.json"))

		if (!manifest?.downloaded_at) {
			throw new Error(`${directory} holds no MANIFEST.json with a fetch date. Run \`${FETCH_COMMAND}\` first.`)
		}

		return { vintage: manifest.downloaded_at.slice(0, 10), records: records(directory(USGS_STRUCTURES_FILENAME)) }
	},
}
