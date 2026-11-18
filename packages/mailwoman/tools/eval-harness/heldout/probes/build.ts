// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   Builds the capability-probe extension: rows of the three probe recipes, rendered with a
 *   seed no corpus build uses and kept only when no training corpus holds their group or their
 *   folded text, frozen as a development and a confirmation set (`heldout/dataset/manifest.ts`).
 *
 *   Under the evaluation-group policy (HOLDOUT_AND_EVALUATION section 4.6) every probe row outside the
 *   frozen groups trains, so a corpus's test split no longer holds probe rows beyond the frozen ones.
 *   New probe rows therefore come from a render that no training source emits.
 *
 *   The rows keep the recipes' own source names, so the release capabilities select
 *   them as they select the corpus's probe rows.
 *   A later render of the same components gets the same `source_id`, hence the same group,
 *   and the evaluation-group list keeps that group out of training.
 *
 *   Each probe leg (a source in one country) takes a fixed quota per set.
 *   Within a leg the quota is split across the rendered forms (the row's `template`)
 *   by {@linkcode stratumQuotas}, and each form's rows are taken in the order of
 *   sha256 over the set's seed and the row's identity.
 *
 *   The confirmation set draws from what the development set left, so the two are disjoint by group.
 */

import { readLocalJSONFile } from "@mailwoman/core/fs/readers"
import { writeLocalJSONFile } from "@mailwoman/core/fs/writers"
import { sha256File, sha256Hex } from "@mailwoman/core/hash"
import { canonicalJSON } from "@mailwoman/core/json"
import { recordIDSQL } from "@mailwoman/corpus/adapters/record-id"
import { type DisposableDuckDB, type DuckDBLimits, escapeSQLString, openDuckDB } from "@mailwoman/corpus/parquet/duckdb"
import { baseManifestFiles } from "@mailwoman/corpus/tools/overlay/manifest"
import { resolvePath } from "path-ts"

import {
	type HeldoutDatasetManifest,
	readHeldoutDatasetRows,
	writeHeldoutDataset,
} from "#tools/eval-harness/heldout/dataset/manifest"
import { overlapTextFoldSQL } from "#tools/eval-harness/heldout/dataset/overlap"
import { stratumQuotas } from "#tools/eval-harness/heldout/fresh/build"
import { countHeldoutCells, type HeldoutRow, heldoutRowID } from "#tools/eval-harness/heldout/per/country"

/**
 * A probe source in one country, the unit a set's quota is stated for.
 */
export interface ProbeLeg {
	source: string
	country: string
	/**
	 * Rows each set takes from the leg.
	 */
	quota: number
}

/**
 * A rendered probe row with the form it was rendered in.
 */
export interface ProbeCandidate {
	row: HeldoutRow
	/**
	 * The recipe's `template`: the rendered form, and for the guideline recipes the cited rule.
	 */
	template: string
}

/**
 * What the draw left out of one leg, and what it took.
 */
export interface ProbeLegLineage {
	source: string
	country: string
	quota: number
	rendered: number
	/**
	 * Rendered rows whose group or folded text a training corpus or an earlier frozen set holds.
	 */
	excluded: number
	available: number
	drawn: Record<"development" | "confirmation", number>
	templates: Array<{ template: string; available: number; development: number; confirmation: number }>
}

/**
 * Takes each leg's quota from `candidates`, split across templates,
 * in the order of `sha256("<seed>:<row id>")`.
 *
 * @throws When a leg holds fewer candidates than its quota, rather than drawing fewer.
 */
export function drawProbeSet(
	candidates: readonly ProbeCandidate[],
	legs: readonly ProbeLeg[],
	seed: number,
	floor: number
): ProbeCandidate[] {
	const drawn: ProbeCandidate[] = []

	for (const leg of legs) {
		const members = candidates.filter((c) => c.row.source === leg.source && c.row.country === leg.country)

		if (members.length < leg.quota) {
			throw new Error(`${leg.source} ${leg.country} holds ${members.length} candidates; the quota is ${leg.quota}`)
		}

		const byTemplate = Map.groupBy(members, (c) => c.template)

		const quotas = stratumQuotas(
			new Map([...byTemplate].map(([template, rows]) => [template, rows.length])),
			leg.quota,
			floor
		)

		for (const template of [...byTemplate.keys()].toSorted()) {
			const ordered = byTemplate
				.get(template)!
				.map((c) => ({ c, order: sha256Hex(`${seed}:${heldoutRowID(c.row)}`) }))
				.toSorted((a, b) => a.order.localeCompare(b.order))

			drawn.push(...ordered.slice(0, quotas.get(template) ?? 0).map(({ c }) => c))
		}
	}

	return drawn
}

/**
 * The groups and folded texts of every row of the probe sources' files in `corpora`,
 * in every split: a train or val row trained, and a test row belongs to an earlier frozen set.
 *
 * `datasets` adds every row of earlier frozen probe sets.
 * Those rows sit in no corpus split.
 *
 * A later render of the same components takes the same group, and a grading already read it.
 */
export async function readProbeExclusions(input: {
	corpora: readonly string[]
	datasets?: readonly string[]
	sources: readonly string[]
	pathRoot: string
	limits?: DuckDBLimits
}): Promise<{
	groups: Set<string>
	texts: Set<string>
	files: Array<{ corpus: string; corpusSHA256: string; path: string; rows: number }>
	datasets: Array<{ datasetID: string; version: string; rows: number }>
}> {
	const groups = new Set<string>()
	const texts = new Set<string>()
	const files: Array<{ corpus: string; corpusSHA256: string; path: string; rows: number }> = []
	const datasets: Array<{ datasetID: string; version: string; rows: number }> = []
	const quote = (value: string) => `'${escapeSQLString(value)}'`

	using db = await openDuckDB(input.limits ?? {})

	for (const path of input.datasets ?? []) {
		const { manifest, rows } = await readHeldoutDatasetRows(path)

		for (const row of rows) {
			groups.add(row.group)
		}

		for (const text of (
			await foldTexts(
				db,
				rows.map((row) => row.raw)
			)
		).values()) {
			texts.add(text)
		}

		datasets.push({ datasetID: manifest.datasetID, version: manifest.version, rows: rows.length })
	}

	for (const corpus of input.corpora) {
		const manifest = await readLocalJSONFile<object>(corpus)
		const corpusSHA256 = await sha256File(corpus)

		const entries = baseManifestFiles<{ path: string; source?: string }>(manifest).filter(
			(entry) => typeof entry.source === "string" && input.sources.includes(entry.source)
		)

		const missing = input.sources.filter((source) => !entries.some((entry) => entry.source === source))

		if (missing.length) throw new Error(`${corpus} lists no file of ${missing.join(", ")}`)

		for (const entry of entries) {
			const path = entry.path.replace(/^\/data/u, input.pathRoot)

			const reader = await db.runAndReadAll(
				`SELECT DISTINCT ${recordIDSQL("coalesce(CAST(base_source_id AS VARCHAR), CAST(source_id AS VARCHAR))")} AS g, ` +
					`${overlapTextFoldSQL("raw")} AS t FROM read_parquet(${quote(path)})`
			)

			let rows = 0

			for (const row of reader.getRowObjects()) {
				if (typeof row.g !== "string" || typeof row.t !== "string") {
					throw new TypeError(`${path} holds a row without a group or a text`)
				}

				groups.add(row.g)
				texts.add(row.t)

				rows++
			}

			files.push({ corpus, corpusSHA256, path, rows })
		}
	}

	return { groups, texts, files, datasets }
}

/**
 * Each text's fold under the overlap audit's SQL, keyed by its index in `raws`.
 */
async function foldTexts(db: DisposableDuckDB, raws: readonly string[]): Promise<Map<number, string>> {
	await db.run(`CREATE OR REPLACE TEMP TABLE fold_raw (i INTEGER, raw VARCHAR)`)

	for (let start = 0; start < raws.length; start += 2000) {
		const values = raws.slice(start, start + 2000).map((raw, i) => `(${start + i}, '${escapeSQLString(raw)}')`)

		await db.run(`INSERT INTO fold_raw VALUES ${values.join(", ")}`)
	}

	const reader = await db.runAndReadAll(`SELECT i, ${overlapTextFoldSQL("raw")} AS t FROM fold_raw`)

	return new Map(reader.getRowObjects().map((row) => [Number(row.i), String(row.t)]))
}

/**
 * Each candidate's folded text, under the overlap audit's fold.
 */
export async function foldProbeTexts(
	candidates: readonly ProbeCandidate[],
	limits: DuckDBLimits = {}
): Promise<Map<string, string>> {
	using db = await openDuckDB(limits)

	const folded = await foldTexts(
		db,
		candidates.map((c) => c.row.raw)
	)

	return new Map(candidates.map((c, i) => [heldoutRowID(c.row), folded.get(i)!]))
}

export interface ProbeSetNames {
	development: string
	confirmation: string
}

export interface BuiltProbeSets {
	development: { path: string; manifest: HeldoutDatasetManifest }
	confirmation: { path: string; manifest: HeldoutDatasetManifest }
	lineagePath: string
	legs: ProbeLegLineage[]
}

/**
 * Removes the excluded and repeated candidates, draws both sets and writes them
 * with their lineage under `outDirectory`.
 */
export async function buildProbeSets(input: {
	names: ProbeSetNames
	candidates: readonly ProbeCandidate[]
	folded: ReadonlyMap<string, string>
	exclusions: { groups: ReadonlySet<string>; texts: ReadonlySet<string> }
	legs: readonly ProbeLeg[]
	seeds: { development: number; confirmation: number }
	floor: number
	render: Record<string, unknown>
	excludedBy: unknown
	outDirectory: string
	createdAt: string
}): Promise<BuiltProbeSets> {
	const seenGroups = new Set<string>()
	const seenTexts = new Set<string>()
	const kept: ProbeCandidate[] = []
	const excluded = new Map<string, number>()
	const rendered = new Map<string, number>()
	const legKey = (row: HeldoutRow) => `${row.source}\u0000${row.country}`

	for (const candidate of input.candidates) {
		const key = legKey(candidate.row)
		const text = input.folded.get(heldoutRowID(candidate.row))

		if (text == null) throw new Error(`no folded text for ${heldoutRowID(candidate.row)}`)

		rendered.set(key, (rendered.get(key) ?? 0) + 1)

		if (
			input.exclusions.groups.has(candidate.row.group) ||
			input.exclusions.texts.has(text) ||
			seenGroups.has(candidate.row.group) ||
			seenTexts.has(text)
		) {
			excluded.set(key, (excluded.get(key) ?? 0) + 1)

			continue
		}

		seenGroups.add(candidate.row.group)
		seenTexts.add(text)
		kept.push(candidate)
	}

	const development = drawProbeSet(kept, input.legs, input.seeds.development, input.floor)
	const developmentGroups = new Set(development.map((c) => c.row.group))
	const remaining = kept.filter((c) => !developmentGroups.has(c.row.group))
	const confirmation = drawProbeSet(remaining, input.legs, input.seeds.confirmation, input.floor)

	const legs: ProbeLegLineage[] = input.legs.map((leg) => {
		const of = (set: readonly ProbeCandidate[]) =>
			set.filter((c) => c.row.source === leg.source && c.row.country === leg.country)

		const available = of(kept)

		return {
			...leg,
			rendered: rendered.get(`${leg.source}\u0000${leg.country}`) ?? 0,
			excluded: excluded.get(`${leg.source}\u0000${leg.country}`) ?? 0,
			available: available.length,
			drawn: { development: of(development).length, confirmation: of(confirmation).length },
			templates: [...new Set(available.map((c) => c.template))].toSorted().map((template) => ({
				template,
				available: available.filter((c) => c.template === template).length,
				development: of(development).filter((c) => c.template === template).length,
				confirmation: of(confirmation).filter((c) => c.template === template).length,
			})),
		}
	})

	const lineagePath = resolvePath(input.outDirectory, `${input.names.development}.lineage.json`).toString()
	const lineage = { render: input.render, excludedBy: input.excludedBy, floor: input.floor, legs }
	const lineageSHA256 = sha256Hex(canonicalJSON(lineage))

	const write = async (
		name: string,
		set: readonly ProbeCandidate[],
		seed: number,
		excludes: { datasetID: string; version: string } | null
	) => {
		const path = resolvePath(input.outDirectory, `${name}.json`).toString()

		const available = [...Map.groupBy(kept, (c) => c.row.country!)].map(([country, rows]) => ({
			country,
			kind: "address" as const,
			available: rows.length,
		}))

		const manifest = await writeHeldoutDataset(path, {
			datasetID: name,
			createdAt: input.createdAt,
			drawnFrom: {
				manifest: `${input.names.development}.lineage.json`,
				sha256: lineageSHA256,
				corpusVersion: null,
				files: lineage.legs.map((leg) => `${leg.source}@${leg.country}`),
			},
			sampling: {
				method: "per-stratum-hash-order",
				perCountry: Math.max(...input.legs.map((leg) => leg.quota)),
				seed,
				order:
					`per probe leg (source and country), its quota split across rendered templates: up to ${input.floor} rows ` +
					`each, the rest by largest remainder; within a template, sha256("<seed>:<row identity>") ascending`,
				...(excludes ? { excludes } : {}),
				engine: "mailwoman heldout-probes",
			},
			cells: countHeldoutCells(
				available,
				set.map((c) => c.row)
			),
			rows: set.map((c) => c.row),
		})

		return { path, manifest }
	}

	const dev = await write(input.names.development, development, input.seeds.development, null)

	const confirm = await write(input.names.confirmation, confirmation, input.seeds.confirmation, {
		datasetID: dev.manifest.datasetID,
		version: dev.manifest.version,
	})

	// The manifests record the sha256 of the lineage without this field.
	await writeLocalJSONFile({ ...lineage, sha256: lineageSHA256 }, lineagePath)

	return { development: dev, confirmation: confirm, lineagePath, legs }
}
