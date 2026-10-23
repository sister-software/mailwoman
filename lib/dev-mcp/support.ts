/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `mwdev_support`: what the training corpus held for each row's expected components, read from the
 *   support index written beside the corpus manifest.
 *
 *   An absent index is reported as unread with the command that writes it.
 *   A zero here is a count over the indexed train split rather than a guess.
 */

import {
	querySupport,
	readSupportIndexRecord,
	type SupportIndexRecord,
	type SupportQueryRow,
	type SupportRowReading,
	supportIndexDirectoryFor,
} from "@mailwoman/corpus/tools/support-index"
import { newestManifest } from "mailwoman/tools/coverage/census"

import { type InputSetRef, type ResolvedInput, resolveInputSet } from "#dev-mcp/input-sets"
import { inputSetProvenance, type Provenance } from "#dev-mcp/tool-kit"

/**
 * The most zero-support row ids the summary lists before counting the rest.
 */
const ZERO_ID_CAP = 50

/**
 * The command that writes an index, quoted in every unread report.
 */
function supportIndexBuildCommand(manifestPath: string): string {
	return `node packages/mailwoman/tools/dev-tools/corpus/support-index.run.ts --manifest ${manifestPath}`
}

export interface SupportReport {
	manifest: string | null
	index: SupportIndexRecord | null
	/**
	 * Why no row was read, or `null` when the index answered.
	 */
	unavailable_reason: string | null
	input_set: Provenance["input_set"]
	summary: string
	n_requested: number
	n_probed: number
	n_without_components: number
	/**
	 * Rows whose country held no train row with their tag set.
	 */
	zero_shape: { n: number; row_ids: string[]; row_ids_omitted: number }
	/**
	 * Rows with a closed-class component whose folded value the country held under no tag at all.
	 */
	absent_component: { n: number; row_ids: string[]; row_ids_omitted: number }
	rows: SupportRowReading[]
	rows_omitted: number
	elapsed_ms: number
}

/**
 * The expected components a row states, from its board seed or its corpus expectation.
 */
function expectedComponents(item: ResolvedInput): Record<string, string> | null {
	return item.seed?.expectComponents ?? item.expectComponents ?? null
}

function idList(rows: readonly SupportRowReading[]): { n: number; row_ids: string[]; row_ids_omitted: number } {
	return {
		n: rows.length,
		row_ids: rows.slice(0, ZERO_ID_CAP).map((row) => row.id),
		row_ids_omitted: Math.max(0, rows.length - ZERO_ID_CAP),
	}
}

/**
 * Read each row's corpus support from the newest corpus's index, or from the manifest
 * or index directory the caller passes.
 */
export async function runSupport(args: Record<string, unknown>): Promise<SupportReport> {
	const startedAt = Date.now()
	const ref = (args["inputs"] as InputSetRef | null) ?? { kind: "board" }
	const manifestArg = args["manifest"] as string | undefined
	const indexDirArg = args["index_dir"] as string | undefined
	const limit = args["limit"] as number | undefined
	const rowsCap = args["rows_cap"] as number | undefined

	const set = await resolveInputSet(ref)
	const selected = limit ? set.inputs.slice(0, limit) : set.inputs
	const manifest = manifestArg ?? (indexDirArg ? "" : await newestManifest())

	const empty = (reason: string, index: SupportIndexRecord | null = null): SupportReport => ({
		manifest: manifest || null,
		index,
		unavailable_reason: reason,
		input_set: inputSetProvenance(set),
		summary: `Support UNREAD for ${selected.length} row(s): ${reason}`,
		n_requested: selected.length,
		n_probed: 0,
		n_without_components: 0,
		zero_shape: { n: 0, row_ids: [], row_ids_omitted: 0 },
		absent_component: { n: 0, row_ids: [], row_ids_omitted: 0 },
		rows: [],
		rows_omitted: 0,
		elapsed_ms: Date.now() - startedAt,
	})

	if (!manifest && !indexDirArg) {
		return empty(
			"No corpus manifest was found under the data root's corpus/versioned directory, and neither `manifest` " +
				"nor `index_dir` was passed."
		)
	}

	const indexDir = indexDirArg ?? supportIndexDirectoryFor(manifest)
	const index = await readSupportIndexRecord(indexDir)

	if (!index) {
		return empty(
			`${indexDir} holds no finished support index. Build it with ` +
				`\`${supportIndexBuildCommand(manifest || "<MANIFEST.json>")}\`; a 700 M-row corpus takes one DuckDB pass ` +
				"per manifest file."
		)
	}

	const probes: SupportQueryRow[] = []
	let withoutComponents = 0

	for (const item of selected) {
		const components = expectedComponents(item)

		if (!components || !Object.keys(components).length) {
			withoutComponents++

			continue
		}

		probes.push({ id: item.id, country: item.country, components })
	}

	const rows = await querySupport(indexDir, probes)
	const zeroShape = rows.filter((row) => row.shape_rows === 0)

	const absentComponent = rows.filter((row) =>
		row.components.some((component) => component.kind === "closed" && !Object.keys(component.under_tags).length)
	)

	const emitted = [...zeroShape, ...rows.filter((row) => row.shape_rows !== 0)]

	const summary = [
		`Read ${rows.length} row(s) against corpus ${index.corpus_version ?? "(unversioned)"} ` +
			`(${index.files_read} of ${index.files_listed} manifest files, ${index.train_rows} train rows, indexed ${index.taken_at}).`,
		withoutComponents ? `${withoutComponents} row(s) state no expected components and were left unprobed.` : "",
		`${zeroShape.length} row(s) have a tag set no train row of their country holds` +
			(zeroShape.length
				? `: ${zeroShape
						.slice(0, ZERO_ID_CAP)
						.map((row) => row.id)
						.join(", ")}${zeroShape.length > ZERO_ID_CAP ? ` and ${zeroShape.length - ZERO_ID_CAP} more` : ""}.`
				: "."),
		`${absentComponent.length} row(s) expect a closed-class value their country holds under no tag.`,
		"A count is over the indexed train split; a surface is folded by the index's own SQL fold, and an " +
			"open-class value is read by its first and last word.",
	]
		.filter((sentence) => sentence.length)
		.join(" ")

	return {
		manifest: index.manifest,
		index,
		unavailable_reason: null,
		input_set: inputSetProvenance(set),
		summary,
		n_requested: selected.length,
		n_probed: rows.length,
		n_without_components: withoutComponents,
		zero_shape: idList(zeroShape),
		absent_component: idList(absentComponent),
		rows: rowsCap ? emitted.slice(0, rowsCap) : emitted,
		rows_omitted: rowsCap ? Math.max(0, emitted.length - rowsCap) : 0,
		elapsed_ms: Date.now() - startedAt,
	}
}
