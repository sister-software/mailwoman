// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   The United States entry of the post-office layer: the post offices (feature code 78006) in
 *   the USGS National Map structures layer, as `mailwoman corpus fetch usgs-post-offices` writes them.
 *
 *   The list is the USGS's compilation rather than the Postal Service's own facility list,
 *   so its provenance is a mapping agency's.
 *   A work of the United States Government, public domain under 17 U.S.C. § 105.
 */

import type { PathBuilder } from "path-ts"
import { JSONSpliterator } from "spliterator"

import { createUnitSplitter, type UnitSplitter } from "#adapters/street/unit"
import {
	PostOfficeProvenance,
	type PostOfficeRecord,
	type PostOfficeSource,
	type PostOfficeSourceRead,
} from "#post-offices/source"
import { readManifest } from "#tools/fetch/download"
import {
	USGOV_USGS_POST_OFFICES_ADAPTER_ID,
	USGS_POST_OFFICES_FILENAME,
	type USGSPostOfficeFeature,
	usgsPostOfficeAddress,
} from "#us/adapters/usgov/usgs-post-offices/adapter"
import type { USGSPostOfficesManifest } from "#us/tools/fetch/usgs-post-offices"

/**
 * One fetched feature as a post-office record, or `null` when it has no permanent identifier.
 *
 * The address is split as the `usgov-usgs-post-offices` adapter splits it.
 */
export function usgsPostOfficeRecord(feature: USGSPostOfficeFeature, units: UnitSplitter): PostOfficeRecord | null {
	const id = feature.properties.permanent_identifier

	if (!id) return null

	const [longitude, latitude] = feature.geometry?.coordinates ?? []

	return {
		id,
		name: feature.properties.name,
		point: typeof latitude === "number" && typeof longitude === "number" ? { latitude, longitude } : null,
		address: usgsPostOfficeAddress(feature.properties, units),
	}
}

async function* records(path: PathBuilder): AsyncIterable<PostOfficeRecord> {
	const units = await createUnitSplitter()

	for await (const feature of JSONSpliterator.fromAsync<USGSPostOfficeFeature>(path.toString())) {
		const record = usgsPostOfficeRecord(feature, units)

		if (record) {
			yield record
		}
	}
}

const FETCH_COMMAND = "mailwoman corpus fetch usgs-post-offices"

/**
 * The USGS National Map's post offices.
 */
export const usgsNationalMapPostOffices: PostOfficeSource = {
	id: "usgs-national-map",
	country: "US",
	publisher: "U.S. Geological Survey",
	attribution: "U.S. Geological Survey, The National Map",
	license: "LicenseRef-USGov-Public-Domain",
	registerSource: "us-public-administration-3",
	provenance: PostOfficeProvenance.MappingAgency,
	fetchCommand: FETCH_COMMAND,

	async read(sourcesRoot): Promise<PostOfficeSourceRead> {
		const directory = sourcesRoot(USGOV_USGS_POST_OFFICES_ADAPTER_ID)
		const manifest = await readManifest<USGSPostOfficesManifest>(directory("MANIFEST.json"))

		if (!manifest?.downloaded_at) {
			throw new Error(`${directory} holds no MANIFEST.json with a fetch date. Run \`${FETCH_COMMAND}\` first.`)
		}

		return { vintage: manifest.downloaded_at.slice(0, 10), records: records(directory(USGS_POST_OFFICES_FILENAME)) }
	},
}
