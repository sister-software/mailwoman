// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   Ties a held-out report to the frozen collections it scored and to the
 *   collections a release specification pins.
 *
 *   The report records each collection it read (`heldout/per/country.run.ts --dataset`)
 *   by path, id and version.
 *   Each collection is read again from that path, so its version is recomputed from the rows
 *   on disk, and a specification pin with the same collection id must record that version.
 *
 *   A verdict reads one evaluation role: the report must score exactly the collections that role pins.
 */

import { readHeldoutDatasetRows } from "#tools/eval-harness/heldout/dataset/manifest"
import {
	EVALUATION_ROLES,
	type EvaluationRole,
	parseCollectionID,
	type ReleaseRequirementSpec,
} from "#tools/eval-harness/release/requirements"

/**
 * One collection a report records in its `dataset` field.
 */
export interface ReportedCollection {
	path: string
	datasetID: string
	version: string
}

/**
 * Where a specification pins a collection.
 */
export type CollectionPin = "identities.dataset" | `evaluations.${EvaluationRole}`

/**
 * A verified collection a verdict was computed on, and the specification pins that name it.
 */
export interface VerifiedCollection {
	datasetID: string
	version: string
	rowsSHA256: string
	path: string
	pinnedAs: CollectionPin[]
}

/**
 * The collections a report scored, verified, and the evaluation role they make up.
 */
export interface VerifiedCollections {
	collections: VerifiedCollection[]
	/**
	 * The role whose pinned collections the report scored, every one and no other, or `null`.
	 */
	role: EvaluationRole | null
	/**
	 * Why the collections make up no role, empty when `role` is set.
	 */
	reasons: string[]
}

function readOne(dataset: unknown, source: string): ReportedCollection {
	if (
		typeof dataset !== "object" ||
		dataset == null ||
		typeof (dataset as ReportedCollection).path !== "string" ||
		typeof (dataset as ReportedCollection).datasetID !== "string" ||
		typeof (dataset as ReportedCollection).version !== "string"
	) {
		throw new TypeError(`${source} records a dataset without a path, datasetID and version`)
	}

	return dataset as ReportedCollection
}

/**
 * Reads a report's `dataset` field as a list, or `null` when the report scored rows
 * drawn from a corpus rather than frozen collections.
 *
 * A report written before collections were listed records one object, read as a list of one.
 *
 * @throws When the field is present but malformed or empty.
 */
export function readReportedCollections(report: { dataset?: unknown }, source: string): ReportedCollection[] | null {
	const dataset = report.dataset

	if (dataset == null) return null

	if (!Array.isArray(dataset)) return [readOne(dataset, source)]

	if (!dataset.length) throw new Error(`${source} records an empty dataset list`)

	return dataset.map((entry) => readOne(entry, source))
}

/**
 * The parts of a release specification that pin collections: the dataset identities
 * and the evaluation roles.
 */
export interface CollectionPinSource {
	identities: Pick<ReleaseRequirementSpec["identities"], "dataset">
	evaluations: ReleaseRequirementSpec["evaluations"]
}

/**
 * Every pin a specification declares, with where it is declared.
 */
function specPins(spec: CollectionPinSource): Array<{ pin: CollectionPin; id: string; sha256: string | null }> {
	return [
		...spec.identities.dataset.map((entry) => ({
			pin: "identities.dataset" as const,
			id: entry.id,
			sha256: entry.sha256,
		})),
		...EVALUATION_ROLES.flatMap((role) =>
			spec.evaluations[role].ids.map((id) => ({ pin: `evaluations.${role}` as const, id, sha256: null }))
		),
	]
}

/**
 * Verifies one reported collection against its rows on disk and against `spec`'s pins.
 *
 * @throws When the manifest's rows or version don't verify, when the report's recorded version differs
 * from the collection's, or when a pin identifies the collection with another version or rows sha256.
 */
export async function verifyReportedCollection(
	spec: CollectionPinSource,
	reported: ReportedCollection
): Promise<VerifiedCollection> {
	const { manifest } = await readHeldoutDatasetRows(reported.path)
	const onDisk = `${manifest.datasetID}@${manifest.version}`

	if (manifest.datasetID !== reported.datasetID || manifest.version !== reported.version) {
		throw new Error(`the report records ${reported.datasetID}@${reported.version}; ${reported.path} holds ${onDisk}`)
	}

	const pinnedAs: CollectionPin[] = []

	for (const { pin, id, sha256 } of specPins(spec)) {
		const parsed = parseCollectionID(id)

		if (!parsed || parsed.datasetID !== manifest.datasetID) continue

		if (parsed.version !== manifest.version) {
			throw new Error(`the specification pins ${pin} as ${id}; the rows at ${reported.path} give ${onDisk}`)
		}

		if (sha256 != null && sha256 !== manifest.rowsFile.sha256) {
			throw new Error(
				`the specification pins ${pin} rows sha256 ${sha256}; ${reported.path} records ${manifest.rowsFile.sha256}`
			)
		}

		if (!pinnedAs.includes(pin)) {
			pinnedAs.push(pin)
		}
	}

	return {
		datasetID: manifest.datasetID,
		version: manifest.version,
		rowsSHA256: manifest.rowsFile.sha256,
		path: reported.path,
		pinnedAs,
	}
}

/**
 * Verifies every reported collection and returns the evaluation role they make up.
 *
 * The role is the one whose pinned collections the report scored, each one and no other.
 * Anything else is recorded as a reason.
 * A reason makes a verdict insufficient.
 *
 * @throws As {@linkcode verifyReportedCollection} does for any one collection,
 * and when the report lists one dataset id twice.
 */
export async function verifyReportedCollections(
	spec: CollectionPinSource,
	reported: readonly ReportedCollection[]
): Promise<VerifiedCollections> {
	const seen = new Set<string>()

	for (const entry of reported) {
		if (seen.has(entry.datasetID)) throw new Error(`the report lists ${entry.datasetID} twice`)

		seen.add(entry.datasetID)
	}

	const collections: VerifiedCollection[] = []

	for (const entry of reported) {
		collections.push(await verifyReportedCollection(spec, entry))
	}

	const scored = new Set(collections.map((c) => `${c.datasetID}@${c.version}`))

	const role =
		EVALUATION_ROLES.find(
			(candidate) =>
				spec.evaluations[candidate].ids.length === scored.size &&
				spec.evaluations[candidate].ids.every((id) => scored.has(id))
		) ?? null

	if (role) return { collections, role, reasons: [] }

	const reasons = EVALUATION_ROLES.map((candidate) => {
		const pinned = spec.evaluations[candidate].ids
		const missing = pinned.filter((id) => !scored.has(id))
		const extra = [...scored].filter((id) => !pinned.includes(id))

		return (
			`the report doesn't score the ${candidate} collections exactly` +
			(missing.length ? `; it lacks ${missing.join(", ")}` : "") +
			(extra.length ? `; it adds ${extra.join(", ")}` : "")
		)
	})

	return { collections, role: null, reasons }
}
