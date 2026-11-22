// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   Builds the fresh-source evaluation set: rows from publications reserved for evaluation
 *   that no committed training manifest reads (`@mailwoman/corpus/evaluation/sources`),
 *   frozen as a held-out dataset (`heldout/dataset/manifest.ts`) for the release check's
 *   comparative objective (`docs/engineering/HOLDOUT_AND_EVALUATION.mdx` section 6.4).
 *
 *   Each record's address is rendered and aligned by `renderHeldoutRow`.
 *   A rendered text that an earlier record of the same source already produced yields no row, because
 *   several charities or school sites can share one address and a repeated text is one observation.
 *
 *   Each country's quota is split across the source's strata (`EvaluationAddressRecord.stratum`):
 *   every stratum takes up to `floor` rows, and the rest of the quota is split in
 *   proportion to the rows each stratum has left, by the largest-remainder method.
 *   Within a stratum, rows are taken in the order of sha256 over the seed and the row's
 *   identity, so a rebuild over the same inputs draws the same rows.
 *
 *   A row from a source no corpus reads can still be a row a model trained on:
 *   a charity's street address can equal a training row's rendered address.
 *   The overlap audit (`heldout/dataset/overlap.run.ts --match-text`) decides that,
 *   by identity, group and folded text.
 */

import { writeLocalJSONFile } from "@mailwoman/core/fs/writers"
import { sha256Hex } from "@mailwoman/core/hash"
import { canonicalJSON } from "@mailwoman/core/json"
import type { EvaluationSource } from "@mailwoman/corpus/evaluation/source"
import { allocate } from "@mailwoman/corpus/recipes/sub/venue"
import type { AddressSourceRegister } from "@mailwoman/corpus/source-register/types"
import { LicenseAction } from "@mailwoman/license/actions"
import type { LicenseDecision } from "@mailwoman/license/decision"
import { evaluateLicense } from "@mailwoman/license/tree"
import { type PathBuilder, resolvePath } from "path-ts"

import { type HeldoutDatasetManifest, writeHeldoutDataset } from "#tools/eval-harness/heldout/dataset/manifest"
import { renderHeldoutRow } from "#tools/eval-harness/heldout/dataset/render"
import { countHeldoutCells, type HeldoutRow, heldoutRowID } from "#tools/eval-harness/heldout/per/country"

/**
 * The dataset id the fresh-source set is frozen under, and the base name of its files.
 */
export const FRESH_SOURCE_SET_ID = "heldout-fresh-sources"

/**
 * What one source contributed.
 */
export interface FreshSourceLineage {
	id: string
	country: string
	publisher: string
	license: string
	attribution: string
	registerSource: string
	vintage: string
	/**
	 * Address records the source's reader yielded, before rendering.
	 */
	records: number
	refused: Record<string, number>
	/**
	 * Rendered rows before the draw, after removing repeated texts.
	 */
	available: number
	repeatedText: number
	strata: Array<{ stratum: string; available: number; drawn: number }>
}

/**
 * A row before the draw, with the stratum it is drawn from.
 */
interface Candidate {
	row: HeldoutRow
	stratum: string
	order: string
}

/**
 * Each stratum's share of `quota`: up to `floor` rows each, then the rest by the
 * largest-remainder method over the rows each stratum has left.
 * The shares sum to `min(quota, total supply)`.
 */
export function stratumQuotas(supply: ReadonlyMap<string, number>, quota: number, floor: number): Map<string, number> {
	const strata = [...supply.keys()].toSorted()
	const total = strata.reduce((n, s) => n + supply.get(s)!, 0)

	if (total <= quota) return new Map(strata.map((s) => [s, supply.get(s)!]))

	const floors = strata.map((s) => Math.min(supply.get(s)!, floor))
	const floorSum = floors.reduce((a, b) => a + b, 0)

	if (floorSum >= quota) {
		// The floors sum past the quota: split the quota over the floors themselves.
		const parts = allocate(quota, floors)

		return new Map(strata.map((s, i) => [s, parts[i]!]))
	}

	const headroom = strata.map((s, i) => supply.get(s)! - floors[i]!)
	const extra = allocate(quota - floorSum, headroom)

	return new Map(strata.map((s, i) => [s, floors[i]! + extra[i]!]))
}

/**
 * Every reason `source` can't give unseen evaluation rows: a decision that withholds
 * fetching, extracting or transforming it, a register row with no reservation for
 * evaluation in force, or a training manifest that read the row.
 *
 * `trained` maps each register source to the training manifests that read it
 * (`trainedRegisterSources` in `@mailwoman/corpus/source-register/reservations`).
 */
export function evaluationSourceProblems(
	source: Pick<EvaluationSource, "id" | "registerSource">,
	register: {
		sources: readonly Pick<AddressSourceRegister["sources"][number], "sourceID" | "license" | "reservation">[]
		licenses: readonly LicenseDecision[]
	},
	trained: ReadonlyMap<string, ReadonlySet<string>>
): string[] {
	const row = register.sources.find((entry) => entry.sourceID === source.registerSource)

	if (!row) return [`${source.id}: register source ${source.registerSource} is not declared`]

	const [answer] = evaluateLicense(
		{
			action: LicenseAction.EvaluateOnly,
			offering: null,
			sources: [{ source: row.sourceID, licenseID: row.license }],
		},
		register
	).sources

	const problems = [...answer!.problems]

	if (!row.reservation) {
		problems.push(`register source ${row.sourceID} is not reserved for evaluation`)
	} else if (row.reservation.lifted) {
		problems.push(`register source ${row.sourceID}'s reservation was lifted on ${row.reservation.lifted.at}`)
	}

	const readers = trained.get(row.sourceID)

	if (readers?.size) {
		problems.push(`training manifest(s) ${[...readers].toSorted().join(", ")} read register source ${row.sourceID}`)
	}

	return problems.map((problem) => `${source.id}: ${problem}`)
}

/**
 * Reads one source, renders its records and returns its candidates and lineage.
 */
async function readSourceCandidates(
	source: EvaluationSource,
	sourcesRoot: PathBuilder,
	seed: number
): Promise<{ candidates: Candidate[]; lineage: Omit<FreshSourceLineage, "strata"> }> {
	const read = await source.read(sourcesRoot(source.id))
	const seen = new Set<string>()
	const candidates: Candidate[] = []
	let records = 0
	let repeatedText = 0

	for await (const record of read.records) {
		records++

		const sourceID = `${source.id}-${record.id}`

		const rendered = renderHeldoutRow(record.components, {
			country: source.country,
			source: source.id,
			sourceID,
			group: sourceID,
			license: source.license,
		})

		if ("refused" in rendered) {
			read.refused[`row:${rendered.refused}`] = (read.refused[`row:${rendered.refused}`] ?? 0) + 1

			continue
		}

		if (seen.has(rendered.row.raw)) {
			repeatedText++

			continue
		}

		seen.add(rendered.row.raw)

		candidates.push({
			row: rendered.row,
			stratum: record.stratum,
			order: sha256Hex(`${seed}:${heldoutRowID(rendered.row)}`),
		})
	}

	if (!records) throw new Error(`${source.id} yielded no record from ${sourcesRoot(source.id)}`)

	return {
		candidates,
		lineage: {
			id: source.id,
			country: source.country,
			publisher: source.publisher,
			license: source.license,
			attribution: source.attribution,
			registerSource: source.registerSource,
			vintage: read.vintage,
			records,
			refused: Object.fromEntries(Object.entries(read.refused).toSorted(([a], [b]) => a.localeCompare(b))),
			available: candidates.length,
			repeatedText,
		},
	}
}

export interface BuiltFreshSourceSet {
	manifestPath: string
	lineagePath: string
	manifest: HeldoutDatasetManifest
	sources: FreshSourceLineage[]
}

/**
 * Builds the set from `sources` and writes its manifest, rows and lineage under `outDirectory`.
 *
 * @throws When no source is given, a source's input cannot be read, or two sources share a country.
 */
export async function buildFreshSourceSet(input: {
	sources: readonly EvaluationSource[]
	register: AddressSourceRegister
	/**
	 * Each register source a training manifest read, with the manifests that read it.
	 */
	trained: ReadonlyMap<string, ReadonlySet<string>>
	sourcesRoot: PathBuilder
	outDirectory: string
	perCountry: number
	floor: number
	seed: number
	createdAt: string
}): Promise<BuiltFreshSourceSet> {
	if (!input.sources.length) throw new Error("no evaluation source is registered, so the set would be empty")

	const problems = input.sources.flatMap((source) => evaluationSourceProblems(source, input.register, input.trained))

	if (problems.length) throw new Error(`refusing to build the evaluation set:\n  ${problems.join("\n  ")}`)

	const countries = input.sources.map((source) => source.country)

	if (new Set(countries).size !== countries.length) {
		throw new Error(`two evaluation sources share a country (${countries.join(", ")}); each country's quota reads one`)
	}

	const rows: HeldoutRow[] = []
	const lineage: FreshSourceLineage[] = []
	const available: Array<{ country: string; kind: "address"; available: number }> = []

	for (const source of input.sources) {
		const { candidates, lineage: read } = await readSourceCandidates(source, input.sourcesRoot, input.seed)
		const byStratum = new Map<string, Candidate[]>()

		for (const candidate of candidates) {
			const members = byStratum.get(candidate.stratum) ?? []

			members.push(candidate)
			byStratum.set(candidate.stratum, members)
		}

		const quotas = stratumQuotas(
			new Map([...byStratum].map(([stratum, members]) => [stratum, members.length])),
			input.perCountry,
			input.floor
		)

		const strata: FreshSourceLineage["strata"] = []

		for (const stratum of [...byStratum.keys()].toSorted()) {
			const members = byStratum.get(stratum)!.toSorted((a, b) => a.order.localeCompare(b.order))
			const drawn = members.slice(0, quotas.get(stratum) ?? 0)

			rows.push(...drawn.map((candidate) => candidate.row))
			strata.push({ stratum, available: members.length, drawn: drawn.length })
		}

		available.push({ country: source.country, kind: "address", available: candidates.length })
		lineage.push({ ...read, strata })
	}

	const manifestPath = resolvePath(input.outDirectory, `${FRESH_SOURCE_SET_ID}.json`).toString()
	const lineagePath = resolvePath(input.outDirectory, `${FRESH_SOURCE_SET_ID}.lineage.json`).toString()
	const lineageBase = { sources: lineage }

	const manifest = await writeHeldoutDataset(manifestPath, {
		datasetID: FRESH_SOURCE_SET_ID,
		createdAt: input.createdAt,
		drawnFrom: {
			manifest: `${FRESH_SOURCE_SET_ID}.lineage.json`,
			sha256: sha256Hex(canonicalJSON(lineageBase)),
			corpusVersion: null,
			files: lineage.map((source) => `${source.id}@${source.vintage}`),
		},
		sampling: {
			method: "per-stratum-hash-order",
			perCountry: input.perCountry,
			seed: input.seed,
			order: `per stratum: up to ${input.floor} rows each, the rest of the quota by largest remainder over each stratum's remaining rows; within a stratum, sha256("<seed>:<row identity>") ascending`,
			engine: "mailwoman heldout-fresh-sources",
		},
		cells: countHeldoutCells(available, rows),
		rows,
	})

	await writeLocalJSONFile({ ...lineageBase, rows: rows.length }, lineagePath)

	return { manifestPath, lineagePath, manifest, sources: lineage }
}
