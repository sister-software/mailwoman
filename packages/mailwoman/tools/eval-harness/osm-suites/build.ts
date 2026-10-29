/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Builds the OpenStreetMap evaluation suites, one per address shape, from the per-country extracts.
 *
 *   1. Collect. The extract files are fanned out with `parallelMap` at a concurrency of 2 to 3, each read by
 *      one sequential `JSONSpliterator.fromAsync`. Every rendered row is classified by shape, and each shape
 *      keeps, per country, the rows with the lowest `sha256(<seed>:<row id>)`, one per record.
 *   2. Filter by training overlap. Each shape's sample is audited with the held-out overlap audit against the
 *      corpora and model cards of the compared models, and only `verified_unseen` rows stay: rows that neither
 *      compared model trained on by identity or by record. When the audit cannot establish a model's training
 *      corpus, the audit classes every row `unknown`, the suite holds zero rows, and its lineage records why.
 *   3. Freeze each suite as a held-out dataset (`heldout/dataset/manifest.ts`), which `heldout/per/country.run.ts`
 *      grades, with a lineage file beside it: each extract's digest, the PBF digest its receipt records, the
 *      extraction parameters its stats sidecar states, the country's OpenStreetMap extraction policy and
 *      version where `@mailwoman/osm` has one, the shape filter, the sampling rule, and a summary of the audit: each
 *      compared model's training corpus and where it was read (a model card, or the training config of a model
 *      whose card does not record it), and each corpus manifest's digest and rows read. The full audit lists every
 *      training file. It is written once as `osm-suites.audit.json`, and each lineage cites it by digest.
 *
 *   The builder reads the extracts and writes only under the output directory it is given.
 */

import { writeLocalJSONFile } from "@mailwoman/core/fs/writers"
import { sha256File, sha256Hex } from "@mailwoman/core/hash"
import { canonicalJSON } from "@mailwoman/core/json"
import { resolvePath } from "path-ts"
import { parallelMap } from "spliterator"

import { writeHeldoutDataset, type HeldoutDatasetManifest } from "#tools/eval-harness/heldout/dataset/manifest"
import { auditHeldoutOverlap, type OverlapAudit } from "#tools/eval-harness/heldout/dataset/overlap"
import { countHeldoutCells, type HeldoutProvenance, heldoutRowID } from "#tools/eval-harness/heldout/per/country"
import {
	extractCountryOf,
	type OSMExtractLineage,
	type OSMExtractTally,
	type OSMSuiteRow,
	readExtractLineage,
	readOSMExtractRows,
} from "#tools/eval-harness/osm-suites/extract"
import { OSM_SUITE_SHAPE_FILTERS, OSMSuiteShape, suiteShapesOf } from "#tools/eval-harness/osm-suites/shapes"

/**
 * The file fan-out the build uses.
 *
 * Spliterator measures `parallelMap` file fan-out peaking at 2 to 3.
 */
export const OSM_SUITE_FILE_CONCURRENCY = 3

/**
 * What one extract contributed.
 */
export interface CollectedExtract {
	country: string
	lineage: OSMExtractLineage
	tally: OSMExtractTally
	/**
	 * Rows of each shape the extract held, before sampling.
	 */
	available: Partial<Record<OSMSuiteShape, number>>
	/**
	 * The sampled rows of each shape, lowest hash first.
	 */
	sampled: Partial<Record<OSMSuiteShape, OSMSuiteRow[]>>
}

/**
 * Options for {@link collectOSMSuiteRows}.
 */
export interface CollectOptions {
	files: readonly string[]
	/**
	 * Rows kept per country and shape.
	 */
	perCountry: number
	seed: number
	concurrency?: number
	onFile?: (collected: CollectedExtract) => void
}

function orderKey(seed: number, row: OSMSuiteRow): string {
	return sha256Hex(`${seed}:${heldoutRowID(row)}`)
}

/**
 * A bounded set of the `size` rows with the lowest order keys.
 */
class LowestKeys {
	readonly #size: number
	readonly #rows = new Map<string, { key: string; row: OSMSuiteRow }>()
	#highest: string | null = null

	constructor(size: number) {
		this.#size = size
	}

	offer(key: string, row: OSMSuiteRow): void {
		const id = heldoutRowID(row)

		if (this.#rows.has(id)) return

		if (this.#rows.size < this.#size) {
			this.#rows.set(id, { key, row })
			this.#highest = null

			return
		}

		const highest = (this.#highest ??= this.#maxKey())

		if (key >= highest) return

		for (const [candidate, entry] of this.#rows) {
			if (entry.key === highest) {
				this.#rows.delete(candidate)

				break
			}
		}

		this.#rows.set(id, { key, row })
		this.#highest = null
	}

	#maxKey(): string {
		let max = ""

		for (const { key } of this.#rows.values()) {
			if (key > max) {
				max = key
			}
		}

		return max
	}

	rows(): OSMSuiteRow[] {
		return [...this.#rows.values()].toSorted((a, b) => (a.key < b.key ? -1 : 1)).map((entry) => entry.row)
	}
}

async function collectExtract(path: string, options: CollectOptions): Promise<CollectedExtract> {
	const country = extractCountryOf(path)!
	const tally: OSMExtractTally = {}
	const available: Partial<Record<OSMSuiteShape, number>> = {}
	const kept = new Map<OSMSuiteShape, LowestKeys>()

	for await (const row of readOSMExtractRows(path, tally)) {
		const shapes = suiteShapesOf(row)

		if (!shapes.length) continue

		const key = orderKey(options.seed, row)

		for (const shape of shapes) {
			available[shape] = (available[shape] ?? 0) + 1

			let set = kept.get(shape)

			if (!set) {
				set = new LowestKeys(options.perCountry)
				kept.set(shape, set)
			}

			set.offer(key, row)
		}
	}

	const sampled: CollectedExtract["sampled"] = {}

	for (const [shape, set] of kept) {
		sampled[shape] = set.rows()
	}

	return { country, lineage: await readExtractLineage(path), tally, available, sampled }
}

/**
 * Read every extract and sample each shape's rows per country.
 *
 * @throws When a file's name states no country or its lineage cannot be read.
 */
export async function collectOSMSuiteRows(options: CollectOptions): Promise<CollectedExtract[]> {
	for (const file of options.files) {
		if (!extractCountryOf(file)) throw new Error(`${file} is not named osm-<cc>-<yymmdd>.corpus.jsonl`)
	}

	const concurrency = Math.min(Math.max(options.concurrency ?? OSM_SUITE_FILE_CONCURRENCY, 2), 3)

	return parallelMap(
		options.files,
		async (file) => {
			const collected = await collectExtract(file, options)

			options.onFile?.(collected)

			return collected
		},
		// Input order, so a suite's rows and lineage list the extracts in file order whatever finishes first.
		{ concurrency, ordered: true }
	).toArray()
}

/**
 * The overlap audit's inputs: the training corpora and model cards of the models the suite compares.
 */
export interface SuiteOverlapInputs {
	corpora: readonly string[]
	modelCards: readonly string[]
	/**
	 * Training configs of compared models whose cards do not record their corpus.
	 */
	trainingConfigs?: readonly string[]
	/**
	 * The local directory that stands for a corpus manifest's `/data` prefix.
	 */
	pathRoot: string
}

/**
 * The extraction policy `@mailwoman/osm` states for a country, or `null` when it states none.
 */
export type PolicyLookup = (country: string) => { name: string; version: number } | null

/**
 * One frozen suite.
 */
export interface FrozenOSMSuite {
	shape: OSMSuiteShape
	manifestPath: string
	lineagePath: string
	sampled: number
	kept: number
	/**
	 * The suite's sampled rows by overlap class.
	 */
	counts: Record<HeldoutProvenance, number>
	/**
	 * The one audit every suite's rows were classed by.
	 */
	audit: OverlapAudit
}

/**
 * Audit, filter and freeze one suite per shape under `outDirectory`.
 *
 * Every shape's sample is audited in one pass, as one dataset holding each sampled row once,
 * because the audit reads every training file of every corpus it is given.
 */
export async function freezeOSMSuites(input: {
	collected: readonly CollectedExtract[]
	perCountry: number
	seed: number
	overlap: SuiteOverlapInputs
	outDirectory: string
	createdAt: string
	policyFor: PolicyLookup
}): Promise<FrozenOSMSuite[]> {
	const frozen: FrozenOSMSuite[] = []
	const extracts = input.collected.map((collected) => collected.lineage)

	const sampling = {
		method: "per-record-id-country-kind-hash-order" as const,
		perCountry: input.perCountry,
		seed: input.seed,
		order: "sha256(`<seed>:<row id>`) ascending, one row per record, per country and shape",
		engine: "mailwoman osm-suites",
	}

	const policies = Object.fromEntries(
		input.collected.map((collected) => [collected.country, input.policyFor(collected.country)])
	)

	const files = extracts.map((lineage) => lineage.extract.path)
	const sampledByShape = new Map<OSMSuiteShape, OSMSuiteRow[]>()
	const union = new Map<string, OSMSuiteRow>()
	/**
	 * Rows dropped per shape because an earlier country's extract held the same identity.
	 *
	 * The adapter's `source_id` digests the rendered components and not the country, so one address
	 * rendered alike from two overlapping extracts is one row, kept from the first file read.
	 */
	const crossCountryDuplicates: Partial<Record<OSMSuiteShape, number>> = {}

	for (const shape of Object.values(OSMSuiteShape)) {
		const seen = new Set<string>()
		const sampled: OSMSuiteRow[] = []

		for (const row of input.collected.flatMap((collected) => collected.sampled[shape] ?? [])) {
			const id = heldoutRowID(row)

			if (seen.has(id)) {
				crossCountryDuplicates[shape] = (crossCountryDuplicates[shape] ?? 0) + 1

				continue
			}

			seen.add(id)
			sampled.push(row)

			if (!union.has(id)) {
				union.set(id, row)
			}
		}

		sampledByShape.set(shape, sampled)
	}

	const unionRows = [...union.values()]
	const unionBase = { shapes: Object.values(OSMSuiteShape), sampling, extracts, policies }

	const unionAvailable = input.collected.map((collected) => ({
		country: collected.country,
		kind: "address" as const,
		available: unionRows.filter((row) => row.country === collected.country).length,
	}))

	const sample = await writeHeldoutDataset(resolvePath(input.outDirectory, "osm-suites.sample.json"), {
		datasetID: "osm-suites-sample",
		createdAt: input.createdAt,
		drawnFrom: {
			manifest: "osm-suites.sample.json",
			sha256: sha256Hex(canonicalJSON(unionBase)),
			corpusVersion: null,
			files,
		},
		sampling,
		cells: countHeldoutCells(unionAvailable, unionRows),
		rows: unionRows,
	})

	const provenance = unionRows.length
		? await auditHeldoutOverlap({
				dataset: sample as HeldoutDatasetManifest,
				corpora: input.overlap.corpora,
				modelCards: input.overlap.modelCards,
				trainingConfigs: input.overlap.trainingConfigs ?? [],
				pathRoot: input.overlap.pathRoot,
			})
		: null

	const audit: OverlapAudit = provenance?.audit ?? {
		dataset: { datasetID: sample.datasetID, version: sample.version, rowsSHA256: sample.rowsFile.sha256 },
		corpora: [],
		modelCards: [],
		verifiedUnseenAdmitted: false,
		reasons: ["the sample holds no row, so no audit ran"],
		counts: { verified_unseen: 0, unseen_by_candidate: 0, known_overlap: 0, unknown: 0 },
	}

	const classOf = (row: OSMSuiteRow): HeldoutProvenance => provenance?.rows[heldoutRowID(row)]?.provenance ?? "unknown"

	// The audit lists every training file of every corpus, so it is written once beside
	// the suites, and each lineage cites it by digest with a per-corpus summary.
	const auditPath = resolvePath(input.outDirectory, "osm-suites.audit.json")

	await writeLocalJSONFile(provenance ?? { audit, auditSHA256: null, rows: {}, unknown: [] }, auditPath)

	const auditSummary = {
		path: "osm-suites.audit.json",
		sha256: await sha256File(auditPath),
		auditSHA256: provenance?.auditSHA256 ?? null,
		dataset: audit.dataset,
		models: audit.modelCards,
		corpora: audit.corpora.map((corpus) => ({
			manifest: corpus.manifest,
			sha256: corpus.sha256,
			corpusVersion: corpus.corpusVersion,
			filesRead: corpus.files.filter((file) => file.read).length,
			rowsRead: corpus.files.reduce((sum, file) => sum + (file.read ? file.rows : 0), 0),
			testFilesSkipped: corpus.files.filter((file) => !file.read).length,
			matches: corpus.files.reduce((sum, file) => sum + file.matches, 0),
		})),
		verifiedUnseenAdmitted: audit.verifiedUnseenAdmitted,
		reasons: audit.reasons,
		counts: audit.counts,
	}

	for (const shape of Object.values(OSMSuiteShape)) {
		const sampled = sampledByShape.get(shape)!
		const datasetID = `osm-suite-${shape}`

		const counts: Record<HeldoutProvenance, number> = {
			verified_unseen: 0,
			unseen_by_candidate: 0,
			known_overlap: 0,
			unknown: 0,
		}

		for (const row of sampled) {
			counts[classOf(row)]++
		}

		const kept = sampled.filter((row) => classOf(row) === "verified_unseen")
		const lineageBase = { shape, filter: OSM_SUITE_SHAPE_FILTERS[shape], sampling, extracts, policies }

		const available = input.collected
			.filter((collected) => collected.available[shape])
			.map((collected) => ({
				country: collected.country,
				kind: "address" as const,
				available: collected.available[shape]!,
			}))

		const manifestPath = resolvePath(input.outDirectory, `${datasetID}.json`)
		const lineagePath = resolvePath(input.outDirectory, `${datasetID}.lineage.json`)

		await writeHeldoutDataset(manifestPath, {
			datasetID,
			createdAt: input.createdAt,
			drawnFrom: {
				manifest: `${datasetID}.lineage.json`,
				sha256: sha256Hex(canonicalJSON(lineageBase)),
				corpusVersion: null,
				files,
			},
			sampling,
			cells: countHeldoutCells(available, kept),
			rows: kept,
		})

		await writeLocalJSONFile(
			{
				...lineageBase,
				overlap: {
					rule: "keep only rows the overlap audit classes verified_unseen",
					auditSHA256: provenance?.auditSHA256 ?? null,
					counts,
					audit: auditSummary,
				},
				sampled: sampled.length,
				crossCountryDuplicates: crossCountryDuplicates[shape] ?? 0,
				kept: kept.length,
			},
			lineagePath
		)

		frozen.push({ shape, manifestPath, lineagePath, sampled: sampled.length, kept: kept.length, counts, audit })
	}

	return frozen
}
