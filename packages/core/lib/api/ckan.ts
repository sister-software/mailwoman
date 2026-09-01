/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The data.gov.uk CKAN catalogue read the Environment Agency layer products share.
 *
 *   A catalogue entry is the readable primary source for a product's ISO reference dates, its licence field
 *   and its direct file URLs — the EA's own dataset landing pages are client-side applications that return
 *   only their shell to a fetch. The download URL is READ FROM HERE rather than assembled, because the EA's
 *   file service keys on an opaque `fileDataSetId` that has no relationship to the dataset id: a hard-coded
 *   URL survives a republish by pointing at a file that is no longer the product.
 */

import type { APIClient } from "#api/APIClient"
import { parseJSONArray } from "#objects"

/**
 * The catalogue API a package entry is read from.
 */
export const CKAN_CATALOGUE_API_BASE_URL = "https://ckan.publishing.service.gov.uk/api/3/action"

/**
 * What a catalogue entry says about a product.
 */
export interface CKANPackageRecord {
	/**
	 * The dataset's own identifier, asserted against the caller's expectation.
	 */
	datasetID: string
	/**
	 * The ISO `revision` reference date — the product vintage, and the freshness signal.
	 */
	revisionDate: string
	publicationDate: string | null
	creationDate: string | null
	/**
	 * The licence the catalogue names.
	 */
	licence: string
	/**
	 * Direct file URLs by resource name.
	 */
	files: Record<string, string>
}

export interface ReadCKANPackageRecordOptions {
	/**
	 * The catalogue package id the entry lives under.
	 */
	packageID: string
	/**
	 * The dataset guid the entry must name.
	 */
	expectDatasetID: string
	/**
	 * The licence value the entry must carry. A different value is a licence change, and a build that absorbed one would
	 * ship an artifact under terms nobody checked.
	 */
	expectLicence: string
	/**
	 * Names the caller in every refusal, e.g. `flood client`.
	 */
	context: string
	/**
	 * The catalogue API root. Defaults to {@link CKAN_CATALOGUE_API_BASE_URL}.
	 */
	baseURL?: string
}

/**
 * Read one product's catalogue entry: reference dates, licence, and the direct file URLs.
 *
 * @throws {Error} When the entry is missing, names a different dataset, carries no `revision` reference date, or names
 *   a licence other than the expected one.
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
			`${options.context}: catalogue entry ${options.packageID} names dataset ${JSON.stringify(datasetID)}, expected ${options.expectDatasetID}`
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
			`${options.context}: the catalogue entry names licence ${JSON.stringify(licences)}, expected ${JSON.stringify(options.expectLicence)} — a licence change decides whether this layer may be redistributed at all`
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
