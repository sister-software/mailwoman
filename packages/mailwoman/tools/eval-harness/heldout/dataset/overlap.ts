/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Audits a held-out dataset for overlap with the training and development data of the models it compares,
 *   and classes each row `known_overlap`, `verified_unseen`, `unseen_by_candidate` or `unknown` for
 *   `heldout/per/country.run.ts --provenance`. A row is `unseen_by_candidate` when the candidate's card is named,
 *   its corpus was read and holds no match, and the row is not `verified_unseen` (the published model trained on
 *   it, or its history is not established); release minimum checks may read such rows.
 *
 *   Every named corpus manifest's train and val files are read through DuckDB, projecting only `source`,
 *   `source_id` and `base_source_id`. A row overlaps when a training row carries its identity
 *   (`<source>:<source_id>`) or its group (`base_source_id`, else `source_id`, as `heldoutRowGroup` keys it),
 *   so a training row derived from the same base row counts. Test files are listed and skipped. A file whose
 *   split an attribute file decides is read whole and its rows that the attribute assigns to `test` are
 *   dropped.
 *
 *   The audit refuses a partial read: a missing file, a file lacking an id column, a row count that differs
 *   from the manifest's record, an attribute file whose sha256 differs, or a file entry with no split throws,
 *   naming the file. A row is `verified_unseen` only when it is absent from every corpus read and every named
 *   model card's `training.corpus_version` identifies a corpus that was read. Otherwise a row without overlap is
 *   `unknown`, and the audit records why.
 *
 *   Limits: overlap is decided by identity and group alone, and text is never compared. A training row holding
 *   the same address text under another source or id goes undetected. A model card records the corpus of its
 *   final training run only. A card that records an `init_from` is refused for `verified_unseen`, because the
 *   ancestry's corpora are unrecorded.
 */

import { readLocalJSONFile } from "@mailwoman/core/fs/readers"
import { pathExists } from "@mailwoman/core/fs/readers/stat"
import { sha256File, sha256Hex } from "@mailwoman/core/hash"
import { canonicalJSON } from "@mailwoman/core/json"
import { escapeSQLString, openDuckDB } from "@mailwoman/corpus/parquet/duckdb"
import { parquetColumnNames } from "@mailwoman/corpus/parquet/readers"
import { baseManifestFiles } from "@mailwoman/corpus/tools/overlay/manifest"
import { readSplitAttribute } from "@mailwoman/corpus/tools/overlay/split-attribute"

import type { HeldoutDatasetManifest } from "#tools/eval-harness/heldout/dataset/manifest"
import type { HeldoutProvenance, ProvenanceRecord } from "#tools/eval-harness/heldout/per/country"

/**
 * The columns the audit reads from every training file.
 */
export const OVERLAP_ID_COLUMNS = ["source", "source_id", "base_source_id"] as const

export interface OverlapFileRecord {
	path: string
	split: string
	/**
	 * Whether the file's rows were read.
	 * A test-split file is listed and skipped.
	 */
	read: boolean
	rows: number
	/**
	 * The sha256 the corpus manifest records, recomputed only when `sha256Verified`.
	 */
	sha256: string | null
	sha256Verified: boolean
	/**
	 * Rows the split attribute assigned to `test` and the audit therefore did not count as training data.
	 */
	excludedTestRows?: number
	matches: number
}

export interface OverlapCorpusRecord {
	manifest: string
	sha256: string
	corpusVersion: string | null
	files: OverlapFileRecord[]
}

export interface OverlapModelCardRecord {
	path: string
	corpusVersion: string | null
	matched: boolean
	problem: string | null
}

export interface OverlapAudit {
	dataset: { datasetID: string; version: string; rowsSHA256: string }
	corpora: OverlapCorpusRecord[]
	modelCards: OverlapModelCardRecord[]
	verifiedUnseenAdmitted: boolean
	reasons: string[]
	counts: Record<HeldoutProvenance, number>
}

/**
 * The `--provenance` file `heldout/per/country.run.ts` reads, with the audit that produced it.
 *
 * `rows` names only rows with a recorded class; `unknown` lists the rest so the absence is explicit.
 */
export interface OverlapProvenanceFile {
	audit: OverlapAudit
	/**
	 * Sha256 over the canonical JSON of `audit`, cited in every row's evidence.
	 */
	auditSHA256: string
	rows: Record<string, ProvenanceRecord>
	unknown: string[]
}

interface FileDescriptor {
	path?: unknown
	rows?: unknown
	sha256?: unknown
	split?: unknown
	split_attribute?: { path?: unknown; sha256?: unknown }
}

const INSERT_CHUNK = 1000

async function loadKeys(db: Awaited<ReturnType<typeof openDuckDB>>, table: string, keys: Iterable<string>) {
	await db.run(`CREATE TEMP TABLE ${table} (k VARCHAR PRIMARY KEY)`)

	const all = [...new Set(keys)]

	for (let i = 0; i < all.length; i += INSERT_CHUNK) {
		const values = all
			.slice(i, i + INSERT_CHUNK)
			.map((key) => `('${escapeSQLString(key)}')`)
			.join(", ")

		await db.run(`INSERT INTO ${table} VALUES ${values}`)
	}
}

/**
 * Reads one model card's training corpus identity.
 */
async function readModelCard(path: string, corporaRead: ReadonlySet<string>): Promise<OverlapModelCardRecord> {
	const card = await readLocalJSONFile<{
		training?: { corpus_version?: unknown; init_from?: unknown }
	}>(path)

	const corpusVersion = card.training?.corpus_version

	if (typeof corpusVersion !== "string" || !corpusVersion) {
		return {
			path,
			corpusVersion: null,
			matched: false,
			problem: "the card records no training.corpus_version",
		}
	}

	if (card.training?.init_from != null) {
		return {
			path,
			corpusVersion,
			matched: false,
			problem: "the card records an init_from whose training corpora are not named",
		}
	}

	if (!corporaRead.has(corpusVersion)) {
		return {
			path,
			corpusVersion,
			matched: false,
			problem: `${corpusVersion} is not among the corpora read`,
		}
	}

	return { path, corpusVersion, matched: true, problem: null }
}

/**
 * Audits a dataset against training corpora and model cards.
 *
 * @param pathRoot The local directory that stands for a manifest's `/data` prefix.
 */
export async function auditHeldoutOverlap(input: {
	dataset: HeldoutDatasetManifest
	corpora: readonly string[]
	modelCards: readonly string[]
	/**
	 * Which of `modelCards` is the candidate's.
	 *
	 * When named and its corpus was read, a row absent from that corpus is at least
	 * `unseen_by_candidate`, whatever the published model's history.
	 */
	candidateModelCard?: string
	pathRoot: string
	verifyFileSHA256?: boolean
}): Promise<OverlapProvenanceFile> {
	const { dataset } = input

	if (!input.corpora.length) throw new Error("the overlap audit names no training corpus")

	if (input.candidateModelCard != null && !input.modelCards.includes(input.candidateModelCard)) {
		throw new Error(`the candidate model card ${input.candidateModelCard} is not among the model cards named`)
	}

	const byID = new Set(dataset.rows.map((entry) => entry.rowID))
	const byGroup = new Map<string, string[]>()

	for (const entry of dataset.rows) {
		const members = byGroup.get(entry.group) ?? []

		members.push(entry.rowID)
		byGroup.set(entry.group, members)
	}

	const evidence = new Map<string, string>()
	/**
	 * The corpora (by `corpus_version`, else manifest path) each overlapping row was found in.
	 */
	const overlapCorpora = new Map<string, Set<string>>()
	const corpora: OverlapCorpusRecord[] = []

	const recordOverlap = (rowID: string, label: string, detail: string) => {
		if (!evidence.has(rowID)) {
			evidence.set(rowID, detail)
		}

		const found = overlapCorpora.get(rowID) ?? new Set<string>()

		found.add(label)
		overlapCorpora.set(rowID, found)
	}

	using db = await openDuckDB()

	await loadKeys(db, "eval_ids", byID)
	await loadKeys(db, "eval_groups", byGroup.keys())

	for (const manifestPath of input.corpora) {
		const manifest = await readLocalJSONFile<{
			corpus_version?: unknown
			slices?: unknown
		}>(manifestPath)

		const corpusVersion = typeof manifest.corpus_version === "string" ? manifest.corpus_version : null
		const descriptors = baseManifestFiles(manifest) as FileDescriptor[]

		if (!descriptors.length) throw new Error(`${manifestPath} lists no files; refusing a partial read`)

		const record: OverlapCorpusRecord = {
			manifest: manifestPath,
			sha256: await sha256File(manifestPath),
			corpusVersion,
			files: [],
		}

		const label = corpusVersion ?? manifestPath

		for (const descriptor of descriptors) {
			if (typeof descriptor.path !== "string") throw new Error(`${manifestPath} lists a file with no path`)

			const file = descriptor.path.replace(/^\/data/u, input.pathRoot)

			const split =
				typeof descriptor.split === "string" ? descriptor.split : descriptor.split_attribute ? "attribute" : null

			if (!split) throw new Error(`${manifestPath} file ${descriptor.path} records no split; refusing a partial read`)

			const recordedRows = typeof descriptor.rows === "number" ? descriptor.rows : null
			const recordedSHA = typeof descriptor.sha256 === "string" ? descriptor.sha256 : null

			if (split === "test") {
				record.files.push({
					path: file,
					split,
					read: false,
					rows: recordedRows ?? 0,
					sha256: recordedSHA,
					sha256Verified: false,
					matches: 0,
				})

				continue
			}

			if (!(await pathExists(file)))
				throw new Error(`${file} (listed by ${manifestPath}) is missing; refusing a partial read`)

			const columns = await parquetColumnNames(file)
			const missing = OVERLAP_ID_COLUMNS.filter((column) => !columns.includes(column))

			if (missing.length) throw new Error(`${file} lacks ${missing.join(", ")}; refusing a partial read`)

			const quoted = `read_parquet('${escapeSQLString(file)}')`
			const counted = Number((await db.runAndReadAll(`SELECT count(*) AS n FROM ${quoted}`)).getRowObjects()[0]!.n)

			if (recordedRows == null || counted !== recordedRows) {
				throw new Error(
					`${file} holds ${counted} rows; ${manifestPath} records ${String(recordedRows)}; refusing a partial read`
				)
			}

			let sha256Verified = false

			if (input.verifyFileSHA256) {
				const digest = await sha256File(file)

				if (digest !== recordedSHA)
					throw new Error(`${file} has sha256 ${digest}; ${manifestPath} records ${String(recordedSHA)}`)

				sha256Verified = true
			}

			let testIDs: ReadonlySet<string> = new Set()

			if (split === "attribute") {
				const reference = descriptor.split_attribute!

				if (typeof reference.path !== "string" || typeof reference.sha256 !== "string") {
					throw new TypeError(`${manifestPath} file ${descriptor.path} names an incomplete split attribute`)
				}

				const attributePath = reference.path.replace(/^\/data/u, input.pathRoot)
				const digest = await sha256File(attributePath)

				if (digest !== reference.sha256) {
					throw new Error(`${attributePath} has sha256 ${digest}; ${manifestPath} records ${reference.sha256}`)
				}

				testIDs = new Set((await readSplitAttribute(attributePath)).test)
			}

			const reader = await db.runAndReadAll(
				`SELECT t.source AS source, t.source_id AS source_id, t.base_source_id AS base_source_id FROM ${quoted} t ` +
					`WHERE (t.source || ':' || t.source_id) IN (SELECT k FROM eval_ids) ` +
					`OR coalesce(t.base_source_id, t.source_id) IN (SELECT k FROM eval_groups)`
			)

			let matches = 0
			let excludedTestRows = 0

			for (const row of reader.getRowObjects()) {
				const sourceID = row.source_id == null ? null : String(row.source_id)

				if (sourceID != null && testIDs.has(sourceID)) {
					excludedTestRows++

					continue
				}

				matches++

				const trainingID = `${String(row.source)}:${String(sourceID)}`
				const where = `in ${label} ${split} file ${descriptor.path}`

				if (byID.has(trainingID)) {
					recordOverlap(trainingID, label, `identity ${trainingID} ${where}`)
				}

				const group = row.base_source_id == null ? sourceID : String(row.base_source_id)

				for (const member of (group != null && byGroup.get(group)) || []) {
					recordOverlap(member, label, `group ${group} (training row ${trainingID}) ${where}`)
				}
			}

			record.files.push({
				path: file,
				split,
				read: true,
				rows: counted,
				sha256: recordedSHA,
				sha256Verified,
				...(split === "attribute" ? { excludedTestRows } : {}),
				matches,
			})
		}

		corpora.push(record)
	}

	const corporaRead = new Set(corpora.flatMap((record) => (record.corpusVersion ? [record.corpusVersion] : [])))
	const modelCards = await Promise.all(input.modelCards.map((path) => readModelCard(path, corporaRead)))
	const reasons: string[] = []

	if (!modelCards.length) {
		reasons.push("no model card was named, so the training corpora of the compared models are unestablished")
	}

	for (const card of modelCards) {
		if (!card.matched) {
			reasons.push(`model card ${card.path}: ${card.problem}`)
		}
	}

	for (const record of corpora) {
		if (!record.corpusVersion) {
			reasons.push(`corpus manifest ${record.manifest} records no corpus_version`)
		}
	}

	const verifiedUnseenAdmitted = reasons.length === 0

	const candidateCard =
		input.candidateModelCard == null ? null : modelCards.find((card) => card.path === input.candidateModelCard)!

	// The candidate's own history is established when its card records a corpus that was read and no init_from.
	const candidateCorpus = candidateCard?.matched ? candidateCard.corpusVersion : null

	const counts: Record<HeldoutProvenance, number> = {
		verified_unseen: 0,
		unseen_by_candidate: 0,
		known_overlap: 0,
		unknown: 0,
	}

	const classes = new Map<string, HeldoutProvenance>()

	for (const entry of dataset.rows) {
		const overlapped = evidence.has(entry.rowID)
		const unseenByCandidate = candidateCorpus != null && !overlapCorpora.get(entry.rowID)?.has(candidateCorpus)

		const cls: HeldoutProvenance =
			!overlapped && verifiedUnseenAdmitted
				? "verified_unseen"
				: unseenByCandidate
					? "unseen_by_candidate"
					: overlapped
						? "known_overlap"
						: "unknown"

		classes.set(entry.rowID, cls)

		counts[cls]++
	}

	const audit: OverlapAudit = {
		dataset: {
			datasetID: dataset.datasetID,
			version: dataset.version,
			rowsSHA256: dataset.rowsFile.sha256,
		},
		corpora,
		modelCards,
		verifiedUnseenAdmitted,
		reasons,
		counts,
	}

	const auditSHA256 = sha256Hex(canonicalJSON(audit))
	const cite = `overlap audit ${auditSHA256.slice(0, 16)} of ${dataset.datasetID}@${dataset.version}`
	const unseenEvidence = `${cite}: absent from ${[...corporaRead].toSorted().join(", ")}, every train and val file read`
	const rows: Record<string, ProvenanceRecord> = {}
	const unknown: string[] = []

	for (const entry of dataset.rows) {
		const cls = classes.get(entry.rowID)!

		if (cls === "known_overlap") {
			rows[entry.rowID] = {
				provenance: cls,
				evidence: `${cite}: ${evidence.get(entry.rowID)!}`,
			}
		} else if (cls === "verified_unseen") {
			rows[entry.rowID] = { provenance: cls, evidence: unseenEvidence }
		} else if (cls === "unseen_by_candidate") {
			const published = evidence.get(entry.rowID) ?? "the published model's history is not established"

			rows[entry.rowID] = {
				provenance: cls,
				evidence: `${cite}: absent from the candidate's ${candidateCorpus!}, every train and val file read; ${published}`,
			}
		} else {
			unknown.push(entry.rowID)
		}
	}

	return { audit, auditSHA256, rows, unknown }
}
