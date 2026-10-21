/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   A versioned evaluation dataset: a held-out sample frozen into a manifest that can be committed, beside a
 *   rows file whose sha256 the manifest records.
 *
 *   The manifest records the corpus manifest the sample was drawn from (path, sha256, corpus version), the
 *   sampling rule and seed, the source set, the available and sampled counts per country and row kind, and one
 *   entry per row: identity, country, source, kind, group, a hash of its expected spans, and its annotation
 *   provenance. The rows file holds the text and spans the grader parses.
 *
 *   The dataset version is derived from what decides membership: the drawn-from corpus manifest's sha256, the
 *   sampling rule and the source set. A changed rule or source set therefore yields a new version, and two
 *   manifests with one version hold the same rows unless a corpus manifest was rewritten in place, which the
 *   rows hash then exposes. {@linkcode compareHeldoutDatasets} reports what changed between two versions.
 */

import { readLocalJSONFile, readLocalTextFile } from "@mailwoman/core/fs/readers"
import { writeLocalJSONFile, writeLocalTextFile } from "@mailwoman/core/fs/writers"
import { sha256Hex } from "@mailwoman/core/hash"
import { canonicalJSON, stringifyJSON } from "@mailwoman/core/json"
import { basename, dirname, type PathBuilderLike, resolvePath } from "path-ts"
import { JSONSpliterator } from "spliterator"

import {
	type HeldoutCellCount,
	type HeldoutRow,
	heldoutRowID,
	heldoutRowKind,
	type HeldoutRowKind,
	type HeldoutSamplingRule,
} from "#tools/eval-harness/heldout/per/country"

/**
 * The manifest format version this module reads and writes.
 */
export const HELDOUT_DATASET_SCHEMA_VERSION = 1

/**
 * One row's entry in a dataset manifest.
 */
export interface HeldoutDatasetEntry {
	rowID: string
	country: string
	source: string
	kind: HeldoutRowKind
	group: string
	/**
	 * Sha256 over the row's text and its annotated span triple, computed by {@linkcode expectedSpansSHA256}.
	 */
	spansSHA256: string
	/**
	 * Where the expected spans came from: `corpus-alignment:<corpus version>:<source>` for
	 * a row whose spans the corpus build aligned from the publisher's components.
	 */
	annotation: string
}

export interface HeldoutDatasetManifest {
	schemaVersion: typeof HELDOUT_DATASET_SCHEMA_VERSION
	/**
	 * The collection's name, such as `heldout-v0.8.0-test`.
	 */
	datasetID: string
	/**
	 * Derived from `drawnFrom.sha256`, `sampling` and `sources`; see {@linkcode heldoutDatasetVersion}.
	 */
	version: string
	createdAt: string
	drawnFrom: {
		/**
		 * The corpus MANIFEST.json path as given to the freezer.
		 */
		manifest: string
		sha256: string
		corpusVersion: string | null
		/**
		 * The test files read, as resolved under the path root.
		 */
		files: string[]
	}
	sampling: HeldoutSamplingRule & {
		/**
		 * The DuckDB version whose `hash` ordered the sample.
		 * Another version may order rows differently.
		 */
		engine: string
	}
	/**
	 * The sources present among the sampled rows, sorted.
	 */
	sources: string[]
	groupingAssumption: string
	annotationProvenance: string
	cells: HeldoutCellCount[]
	rowsFile: { path: string; sha256: string; rows: number }
	rows: HeldoutDatasetEntry[]
}

/**
 * The grouping assumption a dataset manifest records, stating what `heldoutRowGroup`
 * in `heldout/per/country` keys on.
 */
export const HELDOUT_GROUPING_ASSUMPTION =
	"A row's group is its base_source_id when it was derived from a base row, else its own source_id, so a base " +
	"row and its augmentations resample together. Distinct rows describing one address from different publishers, " +
	"and addresses sharing a street or small place, remain separate groups; ids are not source-prefixed, so equal " +
	"id strings in unrelated sources merge, which widens rather than narrows an interval."

/**
 * Sha256 over a row's text and annotated span triple, in a fixed serialization.
 */
export function expectedSpansSHA256(row: Pick<HeldoutRow, "raw" | "span_starts" | "span_ends" | "span_tags">): string {
	return sha256Hex(
		canonicalJSON({
			raw: row.raw,
			starts: row.span_starts,
			ends: row.span_ends,
			tags: row.span_tags,
		})
	)
}

/**
 * The version of a dataset: the first 16 hex digits of a sha256 over the inputs that decide its membership.
 */
export function heldoutDatasetVersion(input: {
	drawnFromSHA256: string
	sampling: HeldoutDatasetManifest["sampling"]
	sources: readonly string[]
}): string {
	return sha256Hex(
		canonicalJSON({
			drawnFrom: input.drawnFromSHA256,
			sampling: input.sampling,
			sources: [...input.sources].toSorted(),
		})
	).slice(0, 16)
}

/**
 * Serializes rows as JSONL, one row per line with a trailing newline.
 */
export function heldoutRowsText(rows: readonly HeldoutRow[]): string {
	return rows.map((row) => `${stringifyJSON(row)}\n`).join("")
}

/**
 * Builds a manifest for a sample.
 * Refuses rows that share an identity or lack a group.
 */
export function buildHeldoutDatasetManifest(input: {
	datasetID: string
	createdAt: string
	drawnFrom: HeldoutDatasetManifest["drawnFrom"]
	sampling: HeldoutDatasetManifest["sampling"]
	cells: HeldoutCellCount[]
	rows: readonly HeldoutRow[]
	rowsFilePath: string
}): HeldoutDatasetManifest {
	const seen = new Set<string>()
	const corpus = input.drawnFrom.corpusVersion ?? "unversioned"

	const entries = input.rows.map((row): HeldoutDatasetEntry => {
		const rowID = heldoutRowID(row)

		if (seen.has(rowID)) throw new Error(`two sampled rows share the identity ${rowID}`)

		seen.add(rowID)

		if (typeof row.group !== "string" || !row.group) throw new Error(`sampled row ${rowID} carries no group`)

		return {
			rowID,
			country: row.country ?? "ZZ",
			source: row.source,
			kind: heldoutRowKind(row.source),
			group: row.group,
			spansSHA256: expectedSpansSHA256(row),
			annotation: `corpus-alignment:${corpus}:${row.source}`,
		}
	})

	const sources = [...new Set(entries.map((entry) => entry.source))].toSorted()
	const text = heldoutRowsText(input.rows)

	return {
		schemaVersion: HELDOUT_DATASET_SCHEMA_VERSION,
		datasetID: input.datasetID,
		version: heldoutDatasetVersion({
			drawnFromSHA256: input.drawnFrom.sha256,
			sampling: input.sampling,
			sources,
		}),
		createdAt: input.createdAt,
		drawnFrom: input.drawnFrom,
		sampling: input.sampling,
		sources,
		groupingAssumption: HELDOUT_GROUPING_ASSUMPTION,
		annotationProvenance:
			"Expected spans are the corpus build's alignment of each publisher's address components onto the row text; " +
			"no row was annotated by hand.",
		cells: input.cells,
		rowsFile: {
			path: input.rowsFilePath,
			sha256: sha256Hex(text),
			rows: input.rows.length,
		},
		rows: entries,
	}
}

/**
 * Writes the rows file and the manifest beside it.
 * The manifest records the rows file by its basename.
 */
export async function writeHeldoutDataset(
	manifestPath: PathBuilderLike,
	input: Omit<Parameters<typeof buildHeldoutDatasetManifest>[0], "rowsFilePath">
): Promise<HeldoutDatasetManifest> {
	const rowsName = `${basename(manifestPath.toString()).replace(/\.json$/u, "")}.rows.jsonl`

	const manifest = buildHeldoutDatasetManifest({
		...input,
		rowsFilePath: rowsName,
	})

	await writeLocalTextFile(heldoutRowsText(input.rows), resolvePath(dirname(manifestPath.toString()), rowsName))
	await writeLocalJSONFile(manifest, manifestPath)

	return manifest
}

/**
 * Reads a dataset manifest, refusing one with a missing field.
 */
export async function readHeldoutDatasetManifest(path: PathBuilderLike): Promise<HeldoutDatasetManifest> {
	const manifest = await readLocalJSONFile<HeldoutDatasetManifest>(path)

	if (manifest.schemaVersion !== HELDOUT_DATASET_SCHEMA_VERSION) {
		throw new Error(`${path.toString()} is not a version ${HELDOUT_DATASET_SCHEMA_VERSION} held-out dataset manifest`)
	}

	for (const key of [
		"datasetID",
		"version",
		"drawnFrom",
		"sampling",
		"sources",
		"cells",
		"rowsFile",
		"rows",
	] as const) {
		if (manifest[key] == null) throw new Error(`${path.toString()} holds no ${key}`)
	}

	return manifest
}

/**
 * Reads a dataset's rows file, refusing it when its sha256, row count, identities
 * or groups differ from the manifest's record.
 */
export async function readHeldoutDatasetRows(
	manifestPath: PathBuilderLike
): Promise<{ manifest: HeldoutDatasetManifest; rows: HeldoutRow[] }> {
	const manifest = await readHeldoutDatasetManifest(manifestPath)
	const rowsPath = resolvePath(dirname(manifestPath.toString()), manifest.rowsFile.path)
	const text = await readLocalTextFile(rowsPath)
	const digest = sha256Hex(text)

	if (digest !== manifest.rowsFile.sha256) {
		throw new Error(`${rowsPath.toString()} has sha256 ${digest}; the manifest records ${manifest.rowsFile.sha256}`)
	}

	// The file was hashed above as text.
	// JSONSpliterator re-reads it, line by line, for the rows.
	const rows = await Array.fromAsync(JSONSpliterator.fromAsync<HeldoutRow>(rowsPath))

	if (rows.length !== manifest.rows.length) {
		throw new Error(`${rowsPath.toString()} holds ${rows.length} rows; the manifest lists ${manifest.rows.length}`)
	}

	for (const [i, row] of rows.entries()) {
		const entry = manifest.rows[i]!
		const rowID = heldoutRowID(row)

		if (rowID !== entry.rowID || row.group !== entry.group) {
			throw new Error(`rows file line ${i + 1} is ${rowID} in group ${row.group}; the manifest lists ${entry.rowID}`)
		}
	}

	return { manifest, rows }
}

/**
 * Per-country row counts in one dataset version, keyed `<country>/<kind>`.
 */
function cellRows(manifest: HeldoutDatasetManifest): Map<string, number> {
	const counts = new Map<string, number>()

	for (const entry of manifest.rows) {
		const key = `${entry.country}/${entry.kind}`

		counts.set(key, (counts.get(key) ?? 0) + 1)
	}

	return counts
}

function sourceRows(manifest: HeldoutDatasetManifest): Map<string, number> {
	const counts = new Map<string, number>()

	for (const entry of manifest.rows) {
		counts.set(entry.source, (counts.get(entry.source) ?? 0) + 1)
	}

	return counts
}

export interface HeldoutDatasetComparison {
	from: { datasetID: string; version: string }
	to: { datasetID: string; version: string }
	sameVersion: boolean
	drawnFromChanged: boolean
	samplingChanged: boolean
	countries: { added: string[]; removed: string[] }
	sources: {
		added: string[]
		removed: string[]
		changed: Array<{ source: string; from: number; to: number }>
	}
	cells: Array<{ cell: string; from: number; to: number }>
	rows: {
		added: number
		removed: number
		annotationChanged: string[]
		groupChanged: string[]
	}
}

/**
 * Reports what changed between two dataset versions: countries added and removed,
 * sources added, removed and re-counted, per-country row counts, and rows whose
 * annotations or groups changed under one identity.
 */
export function compareHeldoutDatasets(
	from: HeldoutDatasetManifest,
	to: HeldoutDatasetManifest
): HeldoutDatasetComparison {
	const countries = (m: HeldoutDatasetManifest) => new Set(m.rows.map((entry) => entry.country))
	const fromCountries = countries(from)
	const toCountries = countries(to)
	const fromSources = sourceRows(from)
	const toSources = sourceRows(to)
	const fromCells = cellRows(from)
	const toCells = cellRows(to)

	const changedSources = [...new Set([...fromSources.keys(), ...toSources.keys()])]
		.filter((source) => fromSources.has(source) && toSources.has(source))
		.filter((source) => fromSources.get(source) !== toSources.get(source))
		.toSorted()
		.map((source) => ({
			source,
			from: fromSources.get(source)!,
			to: toSources.get(source)!,
		}))

	const cells = [...new Set([...fromCells.keys(), ...toCells.keys()])]
		.filter((cell) => (fromCells.get(cell) ?? 0) !== (toCells.get(cell) ?? 0))
		.toSorted()
		.map((cell) => ({
			cell,
			from: fromCells.get(cell) ?? 0,
			to: toCells.get(cell) ?? 0,
		}))

	const fromRows = new Map(from.rows.map((entry) => [entry.rowID, entry]))
	const toRows = new Map(to.rows.map((entry) => [entry.rowID, entry]))
	const annotationChanged: string[] = []
	const groupChanged: string[] = []

	for (const [rowID, entry] of toRows) {
		const before = fromRows.get(rowID)

		if (!before) continue

		if (before.spansSHA256 !== entry.spansSHA256 || before.annotation !== entry.annotation) {
			annotationChanged.push(rowID)
		}

		if (before.group !== entry.group) {
			groupChanged.push(rowID)
		}
	}

	return {
		from: { datasetID: from.datasetID, version: from.version },
		to: { datasetID: to.datasetID, version: to.version },
		sameVersion: from.version === to.version,
		drawnFromChanged: from.drawnFrom.sha256 !== to.drawnFrom.sha256,
		samplingChanged: canonicalJSON(from.sampling) !== canonicalJSON(to.sampling),
		countries: {
			added: [...toCountries].filter((c) => !fromCountries.has(c)).toSorted(),
			removed: [...fromCountries].filter((c) => !toCountries.has(c)).toSorted(),
		},
		sources: {
			added: [...toSources.keys()].filter((s) => !fromSources.has(s)).toSorted(),
			removed: [...fromSources.keys()].filter((s) => !toSources.has(s)).toSorted(),
			changed: changedSources,
		},
		cells,
		rows: {
			added: [...toRows.keys()].filter((id) => !fromRows.has(id)).length,
			removed: [...fromRows.keys()].filter((id) => !toRows.has(id)).length,
			annotationChanged: annotationChanged.toSorted(),
			groupChanged: groupChanged.toSorted(),
		},
	}
}
