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
 *   A source listed in {@linkcode GROUP_ADDRESS_KEY_SOURCES} also joins groups by address: the list records the
 *   address key of each frozen row of that source, and a row with one of those keys is frozen with it (#3125).
 *
 *   The list is committed beside the corpus data, derived from the frozen manifests by
 *   `heldout/dataset/evaluation-groups.run.ts`. Its sha256 joins the split policy hash.
 */

import { readLocalJSONFile } from "@mailwoman/core/fs/readers"
import { sha256File } from "@mailwoman/core/hash"
import { resolveModulePath } from "@mailwoman/core/module/resolvers"

import { recordIDOf } from "#adapters/record-id"
import { USGOV_NAD_ADAPTER_ID } from "#us/adapters/usgov/nad/adapter"
import {
	type AddressKeyRow,
	nadAddressBlock,
	nadAddressBlockSQL,
	nadAddressKey,
} from "#us/adapters/usgov/nad/address-key"

/**
 * The attribute name an evaluation-group file declares.
 */
export const EVALUATION_GROUPS_ATTRIBUTE = "evaluation-groups"

/**
 * A source whose records join a group by address as well as by record id.
 *
 * A source that issues an address a new record id on a re-ingest writes one address
 * under two groups, so a frozen address would train under its new id.
 * The key joins them (#3125).
 */
export interface GroupAddressKeySource {
	/**
	 * The row's address key, or null when the row lacks a part of the key.
	 */
	key(row: AddressKeyRow): string | null
	/**
	 * A coarser key every row of one address shares.
	 * A column scan can compute it.
	 */
	block(row: AddressKeyRow): string | null
	/**
	 * {@linkcode GroupAddressKeySource.block} as a DuckDB expression over a corpus file aliased `alias`.
	 */
	blockSQL(alias: string): string
}

/**
 * The sources whose group identity includes an address key, by corpus `source`.
 *
 * Every other source groups by record id only.
 */
export const GROUP_ADDRESS_KEY_SOURCES: Readonly<Record<string, GroupAddressKeySource>> = {
	[USGOV_NAD_ADAPTER_ID]: { key: nadAddressKey, block: nadAddressBlock, blockSQL: nadAddressBlockSQL },
}

/**
 * A row as {@linkcode groupAddressKeyOf} reads it.
 */
export type AddressKeyedRow = AddressKeyRow & { source: string }

/**
 * The address key of a row whose source {@linkcode GROUP_ADDRESS_KEY_SOURCES} lists,
 * prefixed by the source, or null for any other row and for a row that lacks a part of the key.
 */
export function groupAddressKeyOf(row: AddressKeyedRow): string | null {
	const keyed = GROUP_ADDRESS_KEY_SOURCES[row.source]
	const key = keyed?.key(row)

	return key ? `${row.source}:${key}` : null
}

/**
 * Whether a row's address key is one a frozen set holds, so the row joins that frozen group.
 *
 * A caller that holds no address row matches by record id only.
 */
export function frozenByAddress(
	row: AddressKeyedRow | null | undefined,
	frozen: { addressKeys?: ReadonlySet<string> }
): boolean {
	if (!row || !frozen.addressKeys?.size) return false

	const key = groupAddressKeyOf(row)

	return key != null && frozen.addressKeys.has(key)
}

/**
 * The frozen side of the evaluation-group policy as a split reads it: the groups,
 * and the address keys when the list holds any.
 */
export type FrozenGroups = Pick<EvaluationGroups, "groups"> & { addressKeys?: ReadonlySet<string> }

/**
 * Whether a row belongs to a frozen group: by its group, or by its address
 * key ({@linkcode frozenByAddress}).
 */
export function isFrozenRow(group: string, address: AddressKeyedRow | null | undefined, frozen: FrozenGroups): boolean {
	return frozen.groups.has(group) || frozenByAddress(address, frozen)
}

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
	/**
	 * The {@linkcode groupAddressKeyOf} key of every frozen row whose source has one, sorted.
	 *
	 * A list written before #3125 has none.
	 */
	addressKeys?: string[]
}

/**
 * The lookup a split applies, with the identity its policy hash records.
 */
export interface EvaluationGroups {
	path: string
	sha256: string
	datasets: readonly EvaluationGroupDataset[]
	groups: ReadonlySet<string>
	addressKeys: ReadonlySet<string>
}

/**
 * What a split policy hash and a split record state about the group list applied.
 */
export interface EvaluationGroupsIdentity {
	sha256: string
	datasets: Array<Pick<EvaluationGroupDataset, "datasetID" | "version">>
	groups: number
	/**
	 * Recorded only when the list holds address keys, so the identity of a list without them is unchanged.
	 */
	addressKeys?: number
}

/**
 * The identity of a group list: its file's sha256, the frozen sets it names,
 * its group count and its address-key count.
 */
export function evaluationGroupsIdentity(
	groups: Pick<EvaluationGroups, "sha256" | "datasets" | "groups"> & { addressKeys?: ReadonlySet<string> }
): EvaluationGroupsIdentity {
	return {
		sha256: groups.sha256,
		datasets: groups.datasets.map(({ datasetID, version }) => ({ datasetID, version })),
		groups: groups.groups.size,
		...(groups.addressKeys?.size ? { addressKeys: groups.addressKeys.size } : {}),
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
	/**
	 * The frozen rows whose address keys the list records, read with {@linkcode groupAddressKeyOf}.
	 */
	keyedRows?: Iterable<AddressKeyedRow>
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

	const addressKeys = new Set<string>()

	for (const row of input.keyedRows ?? []) {
		const key = groupAddressKeyOf(row)

		if (key) {
			addressKeys.add(key)
		}
	}

	return {
		attribute: EVALUATION_GROUPS_ATTRIBUTE,
		datasets,
		groups: [...all].toSorted(),
		...(addressKeys.size ? { addressKeys: [...addressKeys].toSorted() } : {}),
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

	if (file.addressKeys != null && !Array.isArray(file.addressKeys)) {
		throw new Error(`${path} records addressKeys that are not a list`)
	}

	return {
		path,
		sha256: await sha256File(path),
		datasets: file.datasets,
		groups: new Set(file.groups),
		addressKeys: new Set(file.addressKeys),
	}
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
