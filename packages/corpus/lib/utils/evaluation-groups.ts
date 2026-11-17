// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 * @file The groups the frozen evaluation sets drew from.
 *   A split under them keeps those groups out of train.
 *
 *   Under the evaluation-group policy (HOLDOUT_AND_EVALUATION section 4.6) the rows of these groups go to
 *   `test`, a small fixed sample of the holdout policy's places goes to `val`, and every other row trains.
 *   A group is `recordIDOf(base_source_id ?? source_id)`, the key the held-out freeze writes on each dataset
 *   entry and the overlap audit compares against training rows, so a base row, its augmentations and the
 *   other rendered rows of its record stay out of train together.
 *
 *   The list is committed beside the corpus data, derived from the frozen manifests by
 *   `heldout/dataset/evaluation-groups.run.ts`. Its sha256 joins the split policy hash.
 */

import { readLocalJSONFile } from "@mailwoman/core/fs/readers"
import { sha256File } from "@mailwoman/core/hash"
import { resolveModulePath } from "@mailwoman/core/module/resolvers"

import { recordIDOf } from "#adapters/record-id"

/**
 * The attribute name an evaluation-group file declares.
 */
export const EVALUATION_GROUPS_ATTRIBUTE = "evaluation-groups"

/**
 * One frozen set the group list was derived from.
 */
export interface EvaluationGroupDataset {
	datasetID: string
	version: string
	/**
	 * What the set was drawn from: a corpus manifest, or the lineage of a probe render no corpus holds.
	 */
	drawnFrom: EvaluationGroupSource
	/**
	 * The sha256 of the dataset manifest read.
	 */
	manifestSHA256: string
	rows: number
	groups: number
}

/**
 * The corpus manifest or render lineage a frozen set records as `drawnFrom`.
 */
export interface EvaluationGroupSource {
	corpusVersion: string | null
	sha256: string
}

/**
 * The committed file: every frozen group, sorted.
 *
 * Each set records its own `drawnFrom`, so one list can join sets drawn from a corpus
 * with capability-probe sets rendered outside every corpus.
 * `evaluation-groups.v0.8.18.json` predates that field and records one top-level
 * `drawnFrom` for its two sets.
 *
 * It stays as written, because corpus v0.8.19's split policy hash records its sha256.
 */
export interface EvaluationGroupsFile {
	attribute: typeof EVALUATION_GROUPS_ATTRIBUTE
	datasets: EvaluationGroupDataset[]
	groups: string[]
}

/**
 * The lookup a split applies, with the identity its policy hash records.
 */
export interface EvaluationGroups {
	path: string
	sha256: string
	datasets: readonly EvaluationGroupDataset[]
	groups: ReadonlySet<string>
}

/**
 * What a split policy hash and a split record state about the group list applied.
 */
export interface EvaluationGroupsIdentity {
	sha256: string
	datasets: Array<Pick<EvaluationGroupDataset, "datasetID" | "version">>
	groups: number
}

/**
 * The identity of a group list: its file's sha256, the frozen sets it names and its group count.
 */
export function evaluationGroupsIdentity(
	groups: Pick<EvaluationGroups, "sha256" | "datasets" | "groups">
): EvaluationGroupsIdentity {
	return {
		sha256: groups.sha256,
		datasets: groups.datasets.map(({ datasetID, version }) => ({ datasetID, version })),
		groups: groups.groups.size,
	}
}

/**
 * The group of one corpus row: its `base_source_id` when it was derived from a base row,
 * else its own `source_id`, read up to the last `#`.
 *
 * The held-out freeze (`heldoutRowGroup`) and the overlap audit key on the same value.
 */
export function evaluationGroupOf(row: { source_id: string; base_source_id?: string | null }): string {
	// `??` as the audit's `coalesce(base_source_id, source_id)`.
	return recordIDOf(row.base_source_id ?? row.source_id)
}

/**
 * Builds the committed file from each frozen set's groups.
 */
export function buildEvaluationGroupsFile(input: {
	datasets: ReadonlyArray<Omit<EvaluationGroupDataset, "groups"> & { groups: Iterable<string> }>
}): EvaluationGroupsFile {
	const all = new Set<string>()
	const datasets: EvaluationGroupDataset[] = []

	for (const { groups, ...dataset } of input.datasets) {
		const unique = new Set(groups)

		for (const group of unique) {
			all.add(group)
		}

		datasets.push({ ...dataset, groups: unique.size })
	}

	return {
		attribute: EVALUATION_GROUPS_ATTRIBUTE,
		datasets,
		groups: [...all].toSorted(),
	}
}

/**
 * Reads an evaluation-group file into the lookup a split applies.
 *
 * @throws When the file declares another attribute, names no frozen set or lists no group.
 */
export async function readEvaluationGroups(path: string): Promise<EvaluationGroups> {
	const file = await readLocalJSONFile<EvaluationGroupsFile>(path)

	if (file.attribute !== EVALUATION_GROUPS_ATTRIBUTE || !Array.isArray(file.groups)) {
		throw new Error(`${path} is not an evaluation-group file`)
	}

	if (!Array.isArray(file.datasets) || !file.datasets.length) throw new Error(`${path} names no frozen set`)

	if (!file.groups.length) throw new Error(`${path} lists no group`)

	return { path, sha256: await sha256File(path), datasets: file.datasets, groups: new Set(file.groups) }
}

/**
 * The committed group list of the v0.8.18 frozen sets (`heldout-dev-v0.8.18` and `heldout-confirm-v0.8.18`).
 */
export function evaluationGroupsV0818Path(): string {
	return resolveModulePath("@mailwoman/corpus/data/holdout/evaluation-groups.v0.8.18.json")
}

/**
 * The committed group list of the v0.8.18 frozen sets and the v0.8.19 capability-probe
 * sets (`heldout-dev-v0.8.19-probes-r2` and `heldout-confirm-v0.8.19-probes-r2`).
 */
export function evaluationGroupsV0819Path(): string {
	return resolveModulePath("@mailwoman/corpus/data/holdout/evaluation-groups.v0.8.19.json")
}
