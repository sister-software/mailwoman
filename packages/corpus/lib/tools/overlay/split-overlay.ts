/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Route an already-written overlay parquet through the holdout policy.
 *
 * A parquet row has no `components` map, so each component is read back from `raw` over the `span_starts` /
 * `span_ends` / `span_tags` triple that `alignRow` wrote.
 */

import type { ComponentTag } from "@mailwoman/codex/component"
import { writeLocalJSONFile } from "@mailwoman/core/fs/writers"
import { sha256File } from "@mailwoman/core/hash"
import { basename, type PathBuilderLike, resolvePath } from "path-ts"

import { openCorpusRowStream } from "#parquet/corpus-rows"
import {
	SPLIT_ATTRIBUTE,
	type SplitAttributeFile,
	splitAttributeFilename,
	splitPolicyHash,
} from "#tools/overlay/split-attribute"
import type { CanonicalRow } from "#types"
import { type CountryHoldout, defaultHoldouts, HOLDOUT_COMPONENT_TAGS, type SplitName, splitForRow } from "#utils/split"

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

	for await (const row of openCorpusRowStream(input)) {
		const components = holdoutComponents(row, index, input)
		const split = splitForRow({ source_id: row.source_id, country: row.country, components }, holdouts)
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

	const { policyHash, codeHash } = await splitPolicyHash(holdouts)

	const name = basename(input)

	const attribute: SplitAttributeFile = {
		attribute: SPLIT_ATTRIBUTE,
		policyHash,
		policy: { holdouts, codeHash },
		file: { name, sha256: await sha256File(input), rows: index },
		counts,
		val: decided.idsIn("val"),
		test: decided.idsIn("test"),
	}

	const output = resolvePath(options.outputDir, splitAttributeFilename(name, policyHash))

	await writeLocalJSONFile(attribute, output)

	return { input, rows: index, counts, attribute: output, policyHash }
}
