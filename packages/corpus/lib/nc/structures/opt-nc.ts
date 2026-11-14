// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   New Caledonia's entry in the structures layer: OPT-NC's agencies,
 *   as `mailwoman corpus fetch nc-opt-agences` writes them.
 *
 *   An `Agence` or an `Annexe` serves the public and is filed under the post-office category.
 *   The mail-processing center (type `Ctc`) is closed to the public and yields no record.
 *
 *   The list is OPT-NC's own record of its counters, so its provenance is the postal operator's.
 *   Licence Ouverte 2.0.
 */

import type { PathBuilder } from "path-ts"
import { JSONSpliterator } from "spliterator"

import {
	NC_OPT_AGENCES_ADAPTER_ID,
	NC_OPT_AGENCES_FILENAME,
	type OPTNCAgencyFeature,
	readOPTNCAddress,
} from "#nc/adapters/opt-nc/adapter"
import type { OPTNCAgencesManifest } from "#nc/tools/fetch/opt-nc"
import {
	postOfficeCategoryID,
	StructureProvenance,
	type StructureRecord,
	type StructureSource,
	type StructureSourceRead,
} from "#structures/source"
import { readManifest } from "#tools/fetch/download"

/**
 * The agency types that serve the public.
 */
const COUNTER_TYPES: ReadonlySet<string> = new Set(["agence", "annexe"])

/**
 * One fetched feature as a structure record, or `null` when it has no identifier
 * or doesn't serve the public.
 */
export function optNCStructureRecord(feature: OPTNCAgencyFeature, category: string): StructureRecord | null {
	const { properties } = feature
	const id = properties.globalid

	if (!id || !COUNTER_TYPES.has(properties.type?.toLowerCase() ?? "")) return null

	const [longitude, latitude] = feature.geometry?.coordinates ?? []
	const address = readOPTNCAddress(properties)

	return {
		id,
		name: properties.texte ?? properties.nom,
		category,
		point: typeof latitude === "number" && typeof longitude === "number" ? { latitude, longitude } : null,
		address: "components" in address ? address.components : null,
	}
}

async function* records(path: PathBuilder): AsyncIterable<StructureRecord> {
	const category = postOfficeCategoryID()

	for await (const feature of JSONSpliterator.fromAsync<OPTNCAgencyFeature>(path.toString())) {
		const record = optNCStructureRecord(feature, category)

		if (record) {
			yield record
		}
	}
}

const FETCH_COMMAND = "mailwoman corpus fetch nc-opt-agences"

/**
 * OPT-NC's agencies.
 */
export const optNCAgencesStructures: StructureSource = {
	id: "opt-nc-agences",
	country: "NC",
	publisher: "Office des postes et télécommunications de Nouvelle-Calédonie",
	attribution: "OPT-NC, Localisation des agences OPT-NC, via data.gouv.nc",
	license: "etalab-2.0",
	registerSource: "nc-postal-1",
	provenance: StructureProvenance.PostalOperator,
	fetchCommand: FETCH_COMMAND,

	async read(sourcesRoot): Promise<StructureSourceRead> {
		const directory = sourcesRoot(NC_OPT_AGENCES_ADAPTER_ID)
		const manifest = await readManifest<OPTNCAgencesManifest>(directory("MANIFEST.json"))

		if (!manifest?.downloaded_at) {
			throw new Error(`${directory} holds no MANIFEST.json with a fetch date. Run \`${FETCH_COMMAND}\` first.`)
		}

		return {
			vintage: (manifest.publisher_version ?? manifest.downloaded_at).slice(0, 10),
			records: records(directory(NC_OPT_AGENCES_FILENAME)),
		}
	},
}
