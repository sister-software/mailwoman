// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 * @file Route an already-written overlay parquet through the holdout policy.
 *
 * A parquet row has no `components` map, so each component is read back from `raw` over the `span_starts` /
 * `span_ends` / `span_tags` triple that `alignRow` wrote.
 */

import type { ComponentTag } from "@mailwoman/codex/component"
import { sha256File } from "@mailwoman/core/crypto/hash"
import { writeLocalJSONFile } from "@mailwoman/core/fs/writers"
import { basename, type PathBuilderLike, resolvePath } from "path-ts"

import { openCorpusRowStream } from "#parquet/corpus-rows"
import type { DuckDBLimits } from "#parquet/duckdb"
import { parquetColumnNames } from "#parquet/readers"
import type { ParquetRow } from "#parquet/schema"
import {
	SPLIT_ATTRIBUTE,
	type SplitAttributeFile,
	splitAttributeFilename,
	splitPolicyHash,
} from "#tools/overlay/split/attribute"
import type { CanonicalRow } from "#types"
import { evaluationGroupOf, frozenByAddress } from "#utils/evaluation-groups"
import type { SplitRetention } from "#utils/retention"
import { type CountryHoldout, defaultHoldouts, HOLDOUT_COMPONENT_TAGS, type SplitName, splitForRow } from "#utils/split"
import { type EvaluationGroupPolicy, evaluationGroupPolicyIdentity } from "#utils/validation-groups"

/**
 * The fields {@linkcode holdoutComponents} reads, with the span triple optional
 * so the absent-triple refusal is reachable from a test rather than only from a corrupt file.
 */
export interface SpannedRow {
	raw: string
	source_id: string
	span_starts?: readonly number[]
	span_ends?: readonly number[]
	span_tags?: readonly string[]
}

/**
 * Read the components a holdout decision needs back out of one labeled row.
 *
 * Raises on an absent or non-parallel span triple, because treating an unreadable row
 * as one with no held-out component would put it in the train split.
 */
export function holdoutComponents(row: SpannedRow, index: number, input: string): CanonicalRow["components"] {
	const { raw, span_starts: starts, span_ends: ends, span_tags: tags } = row

	if (!starts || !ends || !tags) {
		throw new Error(
			`${input} row ${index} (${row.source_id}) carries no span triple, so its components cannot be read. ` +
				`Re-emit the file through \`alignRow\` before splitting it.`
		)
	}

	if (starts.length !== ends.length || starts.length !== tags.length) {
		throw new Error(
			`${input} row ${index} (${row.source_id}) has a span triple of ${starts.length}/${ends.length}/${tags.length}; ` +
				`the three are parallel arrays and must agree in length.`
		)
	}

	const components: Record<string, string> = {}

	for (const [span, tag] of tags.entries()) {
		if (!HOLDOUT_COMPONENT_TAGS.has(tag) || components[tag]) continue

		components[tag] = raw.slice(starts[span]!, ends[span]!)
	}

	return components as Partial<Record<ComponentTag, string>>
}

export interface SplitSliceOptions {
	/**
	 * The parquet to route.
	 * Its rows are read once, and the file is left unchanged.
	 */
	input: PathBuilderLike
	/**
	 * Where the attribute file is written.
	 */
	outputDir: PathBuilderLike
	/**
	 * @defaultValue `defaultHoldouts()`, which is the policy the base build applies.
	 */
	holdouts?: Record<string, CountryHoldout>
	/**
	 * The retention table applied to every row, when one was registered (HOLDOUT_AND_EVALUATION section 5.1).
	 * Covered by the policy hash.
	 */
	retention?: SplitRetention
	/**
	 * The frozen and validation group lists.
	 *
	 * A caller that passes them selects the evaluation-group policy
	 * (HOLDOUT_AND_EVALUATION section 4.6): the frozen groups' rows go to test,
	 * the validation groups' rows go to val, and every other row trains.
	 * Both lists' identities and the quota join the policy hash.
	 */
	evaluationGroups?: EvaluationGroupPolicy
	/**
	 * The DuckDB instance's threads and memory, for a caller that splits several files at once.
	 * @defaultValue the shares `openDuckDB` gives an instance whose caller names none.
	 */
	limits?: DuckDBLimits
}

/**
 * The columns a split decision reads: the span triple over `raw`, the id the attribute
 * is keyed by, and the country the holdout and retention tables are keyed by.
 *
 * The projection leaves out the token and label lists.
 * Those lists dominate the cost of turning a row into a JavaScript object.
 */
const SPLIT_COLUMNS = ["raw", "source_id", "country", "span_starts", "span_ends", "span_tags"] as const

/**
 * A corpus row read through {@linkcode SPLIT_COLUMNS}, with `base_source_id` when the file has the column.
 *
 * The evaluation-group policy keys on it.
 * A file without the column records no derivation, so each row is its own group,
 * as the overlap audit reads it.
 */
type SplitColumnRow = Pick<ParquetRow, (typeof SPLIT_COLUMNS)[number]> & {
	base_source_id?: string | null
	/**
	 * Read when the frozen list holds address keys, so a keyed source's rows can be matched by address.
	 */
	source?: string
}

export interface SplitSliceResult {
	input: string
	rows: number
	counts: Record<SplitName, number>
	/**
	 * The attribute file written, `<stem>.split.<policy hash>.json`.
	 */
	attribute: string
	policyHash: string
}

/**
 * This constant sets the map count for split decisions from one overlay Parquet file.
 *
 * A V8 `Map` holds at most 2^24 entries, and one overlay file can contain more distinct
 * `source_id` values than that (`wof-admin` writes over 50 million rows).
 */
const DECISION_MAP_COUNT = 64

/**
 * Split decisions keyed by `source_id`, spread across {@linkcode DECISION_MAP_COUNT} maps by a string hash.
 */
class SplitDecisions {
	readonly maps = Array.from({ length: DECISION_MAP_COUNT }, () => new Map<string, SplitName>())

	#mapFor(id: string): Map<string, SplitName> {
		let hash = 0

		for (let i = 0; i < id.length; i++) {
			hash = (Math.imul(hash, 31) + id.charCodeAt(i)) | 0
		}

		return this.maps[(hash >>> 0) % DECISION_MAP_COUNT]!
	}

	get(id: string): SplitName | undefined {
		return this.#mapFor(id).get(id)
	}

	set(id: string, split: SplitName): void {
		this.#mapFor(id).set(id, split)
	}

	idsIn(split: SplitName): string[] {
		const ids: string[] = []

		for (const map of this.maps) {
			for (const [id, value] of map) {
				if (value === split) {
					ids.push(id)
				}
			}
		}

		return ids.toSorted()
	}
}

/**
 * Decide the split of every row of one overlay parquet by the policy the base build applies,
 * and write the decision as an attribute file keyed by the policy's hash.
 *
 * @throws When one `source_id` appears on two rows that the policy sends to different splits,
 * since an attribute keyed by `source_id` could state only one of them.
 */
export async function splitOverlaySlice(options: SplitSliceOptions): Promise<SplitSliceResult> {
	const input = options.input.toString()
	const holdouts = options.holdouts ?? defaultHoldouts()
	const decided = new SplitDecisions()
	const counts: Record<SplitName, number> = { train: 0, val: 0, test: 0 }
	let index = 0
	const { evaluationGroups } = options
	const fileColumns = evaluationGroups ? await parquetColumnNames(input) : []
	const keyed = Boolean(evaluationGroups?.frozen.addressKeys.size) && fileColumns.includes("source")

	const columns = [
		...SPLIT_COLUMNS,
		...(fileColumns.includes("base_source_id") ? ["base_source_id"] : []),
		...(keyed ? ["source"] : []),
	]

	/**
	 * The groups a row joined by its address key, so the group's other rows follow it to test.
	 */
	const addressFrozenGroups = new Set<string>()

	for await (const row of openCorpusRowStream<SplitColumnRow>(input, {
		columns,
		...(options.limits ? { limits: options.limits } : {}),
	})) {
		const components = holdoutComponents(row, index, input)

		const splitRow = {
			source_id: row.source_id,
			base_source_id: row.base_source_id ?? null,
			country: row.country,
			components,
			span_tags: row.span_tags,
			address:
				keyed && row.source && row.span_starts && row.span_ends && row.span_tags
					? {
							source: row.source,
							raw: row.raw,
							span_starts: row.span_starts,
							span_ends: row.span_ends,
							span_tags: row.span_tags,
						}
					: null,
		}

		const split = splitForRow(splitRow, holdouts, undefined, options.retention, evaluationGroups)

		if (keyed && frozenByAddress(splitRow.address, evaluationGroups!.frozen)) {
			addressFrozenGroups.add(evaluationGroupOf(splitRow))
		}

		const earlier = decided.get(row.source_id)

		if (earlier && earlier !== split) {
			throw new Error(
				`${input} row ${index} (${row.source_id}) falls in ${split} and an earlier row with the same source_id in ` +
					`${earlier}, so no attribute keyed by source_id can state both. ` +
					`Give each row its own id with \`distinctRowIDs\` from #tools/overlay/distinct-row-ids, then split that file.`
			)
		}

		decided.set(row.source_id, split)

		counts[split]++

		index++
	}

	// A row whose own key a rendering changed, or which has no key, still follows its group to test.
	if (addressFrozenGroups.size) {
		for await (const row of openCorpusRowStream<SplitColumnRow>(input, {
			columns: ["source_id", ...(fileColumns.includes("base_source_id") ? ["base_source_id"] : [])],
			...(options.limits ? { limits: options.limits } : {}),
		})) {
			const earlier = decided.get(row.source_id)

			if (earlier === "test" || !addressFrozenGroups.has(evaluationGroupOf(row))) continue

			decided.set(row.source_id, "test")

			counts[earlier!]--

			counts.test++
		}
	}

	const groupsIdentity = evaluationGroups ? evaluationGroupPolicyIdentity(evaluationGroups) : undefined
	const { policyHash, codeHash } = await splitPolicyHash(holdouts, options.retention, groupsIdentity)

	const name = basename(input)

	const attribute: SplitAttributeFile = {
		attribute: SPLIT_ATTRIBUTE,
		policyHash,
		policy: { holdouts, codeHash, ...(groupsIdentity ? { evaluationGroups: groupsIdentity } : {}) },
		file: { name, sha256: await sha256File(input), rows: index },
		counts,
		val: decided.idsIn("val"),
		test: decided.idsIn("test"),
		...(options.retention
			? { retention: { floor: options.retention.floor, protectedShapes: options.retention.protectedShapes.size } }
			: {}),
	}

	const output = resolvePath(options.outputDir, splitAttributeFilename(name, policyHash))

	await writeLocalJSONFile(attribute, output)

	return { input, rows: index, counts, attribute: output, policyHash }
}
