/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Reads Environment Agency product entries from the data.gov.uk CKAN catalogue.
 *
 *   The catalogue provides ISO reference dates, the licence and direct file URLs. The EA landing pages render
 *   client-side and return no data to a fetch. Download URLs must come from the catalogue because the EA file
 *   service uses a `fileDataSetId` that is unrelated to the dataset ID and changes on republish.
 */

import type { APIClient } from "#api/APIClient"
import { parseJSONArray, stringifyJSON } from "#json"

/**
 * The CKAN catalogue API base URL.
 */
export const CKAN_CATALOGUE_API_BASE_URL = "https://ckan.publishing.service.gov.uk/api/3/action"

/**
 * The fields read from a catalogue entry.
 */
export interface CKANPackageRecord {
	/**
	 * The dataset GUID, checked against the caller's expected value.
	 */
	datasetID: string
	/**
	 * The ISO `revision` reference date, which identifies the product version.
	 */
	revisionDate: string
	publicationDate: string | null
	creationDate: string | null
	/**
	 * The licence listed by the catalogue.
	 */
	licence: string
	/**
	 * Direct file URLs keyed by resource name.
	 */
	files: Record<string, string>
}

/**
 * Options for {@linkcode readCKANPackageRecord}.
 */
export interface ReadCKANPackageRecordOptions {
	/**
	 * The catalogue package ID.
	 */
	packageID: string
	/**
	 * The dataset GUID that the entry must contain.
	 */
	expectDatasetID: string
	/**
	 * The licence that the entry must list.
	 *
	 * Any other value means the licence changed, and the read throws.
	 */
	expectLicence: string
	/**
	 * The caller label used as the error message prefix, such as `flood client`.
	 */
	context: string
	/**
	 * The catalogue API base URL.
	 * The default is {@link CKAN_CATALOGUE_API_BASE_URL}.
	 */
	baseURL?: string
}

/**
 * Reads one product's catalogue entry: reference dates, licence and direct file URLs.
 *
 * @throws {Error} When the entry is missing, contains a different dataset,
 * has no `revision` reference date, or lists a different licence.
 */
export async function readCKANPackageRecord(
	client: Pick<APIClient, "fetch">,
	options: ReadCKANPackageRecordOptions
): Promise<CKANPackageRecord> {
	const { data } = await client.fetch<{
		success?: boolean
		result?: {
			extras?: Array<{ key: string; value: string }>
			resources?: Array<{ name?: string; url?: string }>
		}
	}>({
		method: "GET",
		url: `${options.baseURL ?? CKAN_CATALOGUE_API_BASE_URL}/package_show`,
		params: { id: options.packageID },
	})

	const result = data.result

	if (!data.success || !result) {
		throw new Error(`${options.context}: the catalogue returned no record for ${options.packageID}`)
	}

	const extras = new Map((result.extras ?? []).map((extra) => [extra.key, extra.value]))
	const datasetID = extras.get("guid") ?? ""

	if (datasetID !== options.expectDatasetID) {
		throw new Error(
			`${options.context}: catalogue entry ${options.packageID} names dataset ${stringifyJSON(datasetID)}, expected ${options.expectDatasetID}`
		)
	}

	const dates = parseJSONArray<{ type: string; value: string }>(extras.get("dataset-reference-date"), options.context)
	const revision = dates.find((date) => date.type === "revision")?.value

	if (!revision) {
		throw new Error(
			`${options.context}: the catalogue entry carries no \`revision\` reference date — the product vintage cannot be read, and guessing it would stamp an artifact with a version that means nothing`
		)
	}

	const licences = parseJSONArray<string>(extras.get("licence"), options.context)

	if (!licences.includes(options.expectLicence)) {
		throw new Error(
			`${options.context}: the catalogue entry names licence ${stringifyJSON(licences)}, expected ${stringifyJSON(options.expectLicence)} — a licence change decides whether this layer may be redistributed at all`
		)
	}

	const files: Record<string, string> = {}

	for (const resource of result.resources ?? []) {
		if (resource.name && resource.url) {
			files[resource.name] = resource.url
		}
	}

	return {
		datasetID,
		revisionDate: revision,
		publicationDate: dates.find((date) => date.type === "publication")?.value ?? null,
		creationDate: dates.find((date) => date.type === "creation")?.value ?? null,
		licence: options.expectLicence,
		files,
	}
}
