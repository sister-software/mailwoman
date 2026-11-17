// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   Ties a held-out report to the frozen collection it scored and to the
 *   collections a release specification pins.
 *
 *   The report records the collection it read (`heldout/per/country.run.ts --dataset`)
 *   by path, id and version.
 *   The collection is read again from that path, so its version is recomputed from the rows
 *   on disk, and a specification pin with the same collection id must record that version.
 */

import { readHeldoutDatasetRows } from "#tools/eval-harness/heldout/dataset/manifest"
import { parseCollectionID, type ReleaseRequirementSpec } from "#tools/eval-harness/release/requirements"

/**
 * The collection a report records in its `dataset` field.
 */
export interface ReportedCollection {
	path: string
	datasetID: string
	version: string
}

/**
 * The verified collection a verdict was computed on, and the specification roles that pin it.
 */
export interface VerifiedCollection {
	datasetID: string
	version: string
	rowsSHA256: string
	path: string
	pinnedAs: Array<"identities.dataset" | "evaluations.development" | "evaluations.confirmation">
}

/**
 * Reads a report's `dataset` field, or `null` when the report scored rows drawn
 * from a corpus rather than a frozen collection.
 *
 * @throws When the field is present but malformed.
 */
export function readReportedCollection(report: { dataset?: unknown }, source: string): ReportedCollection | null {
	const dataset = report.dataset

	if (dataset == null) return null

	if (
		typeof dataset !== "object" ||
		typeof (dataset as ReportedCollection).path !== "string" ||
		typeof (dataset as ReportedCollection).datasetID !== "string" ||
		typeof (dataset as ReportedCollection).version !== "string"
	) {
		throw new TypeError(`${source} records a dataset without a path, datasetID and version`)
	}

	return dataset as ReportedCollection
}

/**
 * Verifies the reported collection against its rows on disk and against `spec`'s pins.
 *
 * @throws When the manifest's rows or version don't verify, when the report's recorded version differs
 * from the collection's, or when a pin identifies the collection with another version or rows sha256.
 */
export async function verifyReportedCollection(
	spec: Pick<ReleaseRequirementSpec, "identities" | "evaluations">,
	reported: ReportedCollection
): Promise<VerifiedCollection> {
	const { manifest } = await readHeldoutDatasetRows(reported.path)
	const onDisk = `${manifest.datasetID}@${manifest.version}`

	if (manifest.datasetID !== reported.datasetID || manifest.version !== reported.version) {
		throw new Error(`the report records ${reported.datasetID}@${reported.version}; ${reported.path} holds ${onDisk}`)
	}

	const pins = [
		["identities.dataset", spec.identities.dataset.id],
		["evaluations.development", spec.evaluations.development.id],
		["evaluations.confirmation", spec.evaluations.confirmation.id],
	] as const

	const pinnedAs: VerifiedCollection["pinnedAs"] = []

	for (const [role, id] of pins) {
		const pin = id == null ? null : parseCollectionID(id)

		if (!pin || pin.datasetID !== manifest.datasetID) continue

		if (pin.version !== manifest.version) {
			throw new Error(`the specification pins ${role} as ${id}; the rows at ${reported.path} give ${onDisk}`)
		}

		pinnedAs.push(role)
	}

	const pinnedSHA256 = spec.identities.dataset.sha256

	if (pinnedAs.includes("identities.dataset") && pinnedSHA256 != null && pinnedSHA256 !== manifest.rowsFile.sha256) {
		throw new Error(
			`the specification pins identities.dataset rows sha256 ${pinnedSHA256}; ${reported.path} records ${manifest.rowsFile.sha256}`
		)
	}

	return {
		datasetID: manifest.datasetID,
		version: manifest.version,
		rowsSHA256: manifest.rowsFile.sha256,
		path: reported.path,
		pinnedAs,
	}
}
