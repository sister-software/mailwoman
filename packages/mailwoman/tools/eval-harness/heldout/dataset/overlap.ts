// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   Audits a held-out dataset against the training and development data of the compared models.
 *
 *   The audit assigns each row `known_overlap`, `verified_unseen`, `unseen_by_candidate`
 *   or `unknown` for `heldout/per/country.run.ts --provenance`.
 *   A row is `unseen_by_candidate` when the candidate model card is listed, the audit
 *   reads its corpus and finds no match, and the row isn't `verified_unseen`.
 *
 *   The published model trained on the row or its history is unestablished.
 *   Release minimum checks may read these rows.
 *
 *   DuckDB reads the train and val files from each corpus manifest and projects
 *   only `source`, `source_id` and `base_source_id`.
 *   A training row overlaps a held-out row when their identities (`<source>:<source_id>`) or groups match.
 *
 *   The group is `base_source_id`, when present, or `source_id` read up to the last `#`,
 *   as `heldoutRowGroup` defines it.
 *   Rows derived from the same base row therefore count as overlaps.
 *
 *   The audit lists and skips test files.
 *   It reads a file assigned to a split by an attribute file in full,
 *   then excludes rows that the attribute assigns to `test`.
 *
 *   The audit refuses a partial read: a missing file, a file lacking an id column,
 *   a row count that differs from the manifest's record, an attribute file whose sha256
 *   differs, or a file entry with no split throws, naming the file.
 *   A row is `verified_unseen` only when no corpus read contains it and each model card's
 *   model card's `training.corpus_version` identifies a corpus that was read.
 *
 *   For a model whose card doesn't record its corpus, the caller passes its training config instead.
 *   The config's `data.corpus_dir` must then identify a corpus that was read.
 *
 *   Otherwise a row without overlap is `unknown`, and the audit records why.
 *
 *   Given the dataset's row texts (`rowTexts`), the audit also compares text: a training row whose
 *   folded text ({@linkcode overlapTextFoldSQL}: case, accents and every run of characters that
 *   are neither letters nor digits folded away) equals a held-out row's folded text overlaps it.
 *   A row drawn from a source no corpus reads can only overlap this way.
 *
 *   Limits: without `rowTexts`, overlap is decided by identity and group only, and a
 *   training row holding the same address text under another source or id goes undetected.
 *   With them, a training row that holds the held-out text inside a longer text,
 *   such as the address followed by a country name, still goes undetected.
 *
 *   A model card records the corpus of its final training run only.
 *
 *   A card that records an `init_from`, or a config that sets `train.init_from`,
 *   is refused for `verified_unseen`, because the ancestry's corpora are unrecorded.
 */

import { sha256File, sha256Hex } from "@mailwoman/core/crypto/hash"
import { readLocalJSONFile } from "@mailwoman/core/fs/readers"
import { pathExists } from "@mailwoman/core/fs/readers/stat"
import { canonicalJSON } from "@mailwoman/core/values/json"
import { recordIDOf, recordIDSQL } from "@mailwoman/corpus/adapters/record-id"
import { type DuckDBLimits, escapeSQLString, openDuckDB } from "@mailwoman/corpus/parquet/duckdb"
import { parquetColumnNames } from "@mailwoman/corpus/parquet/readers"
import { baseManifestFiles } from "@mailwoman/corpus/tools/overlay/manifest"
import { readSplitAttribute } from "@mailwoman/corpus/tools/overlay/split/attribute"
import { readTrainingConfig, trainingCorpusVersion, typedTrainingConfig } from "@mailwoman/corpus/training/config/load"
import {
	type AddressKeyedRow,
	type EvaluationGroups,
	GROUP_ADDRESS_KEY_SOURCES,
	groupAddressKeyOf,
} from "@mailwoman/corpus/utils/evaluation-groups"

import type { HeldoutDatasetManifest } from "#tools/eval-harness/heldout/dataset/manifest"
import type { HeldoutProvenance, ProvenanceRecord } from "#tools/eval-harness/heldout/per/country"

/**
 * The columns the audit reads from every training file.
 */
export const OVERLAP_ID_COLUMNS = ["source", "source_id", "base_source_id"] as const

/**
 * The DuckDB expression that folds a text column for the text comparison: lower case, accents stripped,
 * each run of characters other than letters and digits replaced by one space, then trimmed.
 *
 * Both sides of the comparison are folded by this one expression.
 */
export function overlapTextFoldSQL(column: string): string {
	return `trim(regexp_replace(lower(strip_accents(${column})), '[^\\p{L}\\p{N}]+', ' ', 'g'))`
}

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
	 * Rows the split attribute assigned to `test` and the audit therefore didn't count as training data.
	 */
	excludedTestRows?: number
	/**
	 * Rows the previewed evaluation-group list sends to `test` by group or address key,
	 * and which the audit therefore didn't count as training data.
	 */
	excludedPreviewRows?: number
	/**
	 * The file has no `base_source_id` column, so its rows were grouped by their own `source_id`.
	 */
	baseSourceIDAbsent?: boolean
	matches: number
}

export interface OverlapCorpusRecord {
	manifest: string
	sha256: string
	corpusVersion: string | null
	files: OverlapFileRecord[]
}

/**
 * Where an audit read a compared model's training corpus.
 */
export const OverlapModelSource = {
	/**
	 * The model card's `training.corpus_version` and `training.init_from`.
	 */
	ModelCard: "model-card",
	/**
	 * The training config's `data.corpus_dir` and `train.init_from`, for a model
	 * whose card doesn't record its corpus.
	 */
	TrainingConfig: "training-config",
} as const

export type OverlapModelSource = (typeof OverlapModelSource)[keyof typeof OverlapModelSource]

export interface OverlapModelCardRecord {
	/**
	 * The model card or training config read.
	 */
	path: string
	source: OverlapModelSource
	corpusVersion: string | null
	matched: boolean
	problem: string | null
}

export interface OverlapAudit {
	dataset: { datasetID: string; version: string; rowsSHA256: string }
	corpora: OverlapCorpusRecord[]
	modelCards: OverlapModelCardRecord[]
	verifiedUnseenAdmitted: boolean
	/**
	 * Whether training rows were also compared by folded text, beside identity and group.
	 */
	textCompared: boolean
	/**
	 * Present when training rows of a keyed source were also compared by address key.
	 */
	addressCompared?: true
	/**
	 * Present when the audit previewed a re-split.
	 *
	 * The audit left out every training row the listed evaluation-group list sends
	 * to `test`, by group or by address key.
	 * It describes the corpora as that re-split would write them.
	 */
	preview?: { evaluationGroups: string; sha256: string }
	reasons: string[]
	counts: Record<HeldoutProvenance, number>
	/**
	 * Rows a training row matched, per kind of match.
	 *
	 * A row matched in several ways counts under each, where its evidence cites the first match only.
	 */
	overlapRows: Record<OverlapKind, number>
}

/**
 * How a training row matched a held-out row.
 */
export const OverlapKind = {
	/**
	 * The same `<source>:<source_id>`.
	 */
	Identity: "identity",
	/**
	 * The same record group, so a variant of the held-out row.
	 */
	Group: "group",
	/**
	 * The same folded text under another record.
	 */
	Text: "text",
	/**
	 * The same address key under another record of a keyed source (`GROUP_ADDRESS_KEY_SOURCES`),
	 * such as a NAD address re-ingested under a new UUID.
	 */
	Address: "address",
} as const

export type OverlapKind = (typeof OverlapKind)[keyof typeof OverlapKind]

/**
 * Rows per kind of match, from each overlapping row's kinds.
 */
function countOverlapKinds(rows: Iterable<ReadonlySet<OverlapKind>>): Record<OverlapKind, number> {
	const counts: Record<OverlapKind, number> = { identity: 0, group: 0, text: 0, address: 0 }

	for (const kinds of rows) {
		for (const kind of kinds) {
			counts[kind]++
		}
	}

	return counts
}

/**
 * The kinds in `refuse` under which the audit found an overlapping row, with each kind's row count.
 */
export function refusedOverlaps(audit: Pick<OverlapAudit, "overlapRows">, refuse: Iterable<OverlapKind>) {
	return [...new Set(refuse)].map((kind) => ({ kind, rows: audit.overlapRows[kind] })).filter((entry) => entry.rows > 0)
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

/**
 * The span triple the address key reads beside `raw`.
 */
const SPAN_COLUMNS = ["span_starts", "span_ends", "span_tags"] as const

/**
 * A DuckDB list value's items, or the array itself.
 */
function listItems(value: unknown): unknown[] {
	if (Array.isArray(value)) return value

	const items = (value as { items?: unknown } | null)?.items

	if (!Array.isArray(items)) throw new TypeError(`expected a list, read ${String(value)}`)

	return items
}

/**
 * The address-key input of one training row read with its span triple.
 */
function addressKeyedRowOf(row: Record<string, unknown>): AddressKeyedRow | null {
	if (row.raw == null || row.source == null || row.span_tags == null) return null

	return {
		source: String(row.source),
		raw: String(row.raw),
		span_starts: listItems(row.span_starts).map(Number),
		span_ends: listItems(row.span_ends).map(Number),
		span_tags: listItems(row.span_tags).map((tag) => String(tag)),
	}
}

/**
 * The dataset's row identities under each address key, and the source-prefixed
 * blocks the column scan filters by.
 *
 * @throws When a dataset row has no entry in `addressRows`.
 */
function indexAddressRows(
	dataset: HeldoutDatasetManifest,
	addressRows: ReadonlyMap<string, AddressKeyedRow> | undefined
): { byAddress: Map<string, string[]>; addressBlocks: Set<string> } {
	const byAddress = new Map<string, string[]>()
	const addressBlocks = new Set<string>()

	for (const entry of addressRows ? dataset.rows : []) {
		const row = addressRows!.get(entry.rowID)

		if (!row) throw new Error(`row ${entry.rowID} has no spans for the address-key comparison`)

		const key = groupAddressKeyOf(row)
		const block = GROUP_ADDRESS_KEY_SOURCES[row.source]?.block(row)

		if (!key || !block) continue

		byAddress.set(key, [...(byAddress.get(key) ?? []), entry.rowID])
		addressBlocks.add(`${row.source}|${block}`)
	}

	return { byAddress, addressBlocks }
}

/**
 * The keyed sources' block filter over a training file aliased `t`, matched against `eval_address_blocks`.
 */
function addressBlockFilterSQL(): string {
	return Object.entries(GROUP_ADDRESS_KEY_SOURCES)
		.map(
			([source, keyed]) =>
				`(t.source = '${escapeSQLString(source)}' AND ('${escapeSQLString(source)}|' || ${keyed.blockSQL("t")}) ` +
				`IN (SELECT k FROM eval_address_blocks))`
		)
		.join(" OR ")
}

/**
 * The columns a training file must hold: the identity columns, `raw` for the text comparison,
 * and the span triple for the address key and the preview.
 */
function requiredColumns(matchText: boolean, readSpans: boolean): string[] {
	return [
		...new Set([
			...OVERLAP_ID_COLUMNS.filter((column) => column !== "base_source_id"),
			...(matchText ? ["raw"] : []),
			...(readSpans ? ["raw", ...SPAN_COLUMNS] : []),
		]),
	]
}

/**
 * The `test` row ids of a file's split attribute, after its sha256 is checked against the manifest.
 */
async function readAttributeTestIDs(
	descriptor: FileDescriptor,
	manifestPath: string,
	pathRoot: string
): Promise<ReadonlySet<string>> {
	const reference = descriptor.split_attribute!

	if (typeof reference.path !== "string" || typeof reference.sha256 !== "string") {
		throw new TypeError(`${manifestPath} file ${String(descriptor.path)} names an incomplete split attribute`)
	}

	const attributePath = reference.path.replace(/^\/data/u, pathRoot)
	const digest = await sha256File(attributePath)

	if (digest !== reference.sha256) {
		throw new Error(`${attributePath} has sha256 ${digest}; ${manifestPath} records ${reference.sha256}`)
	}

	return new Set((await readSplitAttribute(attributePath)).test)
}

/**
 * One training row's group and, when its spans were read, its address key.
 */
function trainingRowKeys(
	row: Record<string, unknown>,
	sourceID: string | null,
	readSpans: boolean
): { group: string | null; addressKey: string | null } {
	const groupID = row.base_source_id == null ? sourceID : String(row.base_source_id)
	const keyedRow = readSpans ? addressKeyedRowOf(row) : null

	return {
		group: groupID == null ? null : recordIDOf(groupID),
		addressKey: keyedRow ? groupAddressKeyOf(keyedRow) : null,
	}
}

/**
 * Whether a previewed list sends a training row to `test`, by its group or its address key.
 */
function previewHolds(preview: EvaluationGroups, group: string | null, addressKey: string | null): boolean {
	return (group != null && preview.groups.has(group)) || (addressKey != null && preview.addressKeys.has(addressKey))
}

/**
 * The comparisons an audit made, as its evidence states them.
 */
function comparedPhrase(matchText: boolean, matchAddress: boolean): string {
	const kinds = ["identity", "group", ...(matchText ? ["folded text"] : []), ...(matchAddress ? ["address key"] : [])]

	return `by ${kinds.slice(0, -1).join(", ")} and ${kinds.at(-1)!}`
}

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
 * Loads each row's folded text into the `eval_texts` table and returns the row
 * identities under each folded text.
 *
 * DuckDB folds the held-out side too, so both sides of the comparison share one fold.
 *
 * @throws When a dataset row has no text in `rowTexts`.
 */
async function loadTextKeys(
	db: Awaited<ReturnType<typeof openDuckDB>>,
	dataset: HeldoutDatasetManifest,
	rowTexts: ReadonlyMap<string, string>
): Promise<Map<string, string[]>> {
	await db.run(`CREATE TEMP TABLE eval_raw (row_id VARCHAR, raw VARCHAR)`)

	const pairs = dataset.rows.map((entry) => {
		const raw = rowTexts.get(entry.rowID)

		if (raw == null) throw new Error(`row ${entry.rowID} has no text for the folded-text comparison`)

		return `('${escapeSQLString(entry.rowID)}', '${escapeSQLString(raw)}')`
	})

	for (let i = 0; i < pairs.length; i += INSERT_CHUNK) {
		await db.run(`INSERT INTO eval_raw VALUES ${pairs.slice(i, i + INSERT_CHUNK).join(", ")}`)
	}

	await db.run(`CREATE TEMP TABLE eval_texts AS SELECT DISTINCT ${overlapTextFoldSQL("raw")} AS k FROM eval_raw`)

	const byText = new Map<string, string[]>()
	const folded = await db.runAndReadAll(`SELECT row_id, ${overlapTextFoldSQL("raw")} AS k FROM eval_raw`)

	for (const row of folded.getRowObjects()) {
		const members = byText.get(String(row.k)) ?? []

		members.push(String(row.row_id))
		byText.set(String(row.k), members)
	}

	return byText
}

/**
 * The corpus read whose `corpus_version` a model's recorded corpus names, or `null`.
 *
 * A card or config identifies its corpus as `v<version>` (the training-manifest key)
 * while a MANIFEST.json records `<version>`.
 */
function corpusReadAs(corpusVersion: string, corporaRead: ReadonlySet<string>): string | null {
	const bare = (version: string) => version.replace(/^v(?=\d)/u, "")

	return [...corporaRead].find((read) => bare(read) === bare(corpusVersion)) ?? null
}

/**
 * Matches a model's recorded training corpus against the corpora the audit read.
 */
function matchTrainingCorpus(
	path: string,
	source: OverlapModelSource,
	corpusVersion: string,
	corporaRead: ReadonlySet<string>
): OverlapModelCardRecord {
	if (corpusReadAs(corpusVersion, corporaRead) == null) {
		return {
			path,
			source,
			corpusVersion,
			matched: false,
			problem: `${corpusVersion} is not among the corpora read`,
		}
	}

	return { path, source, corpusVersion, matched: true, problem: null }
}

/**
 * Reads one model card's training corpus identity.
 */
async function readModelCard(path: string, corporaRead: ReadonlySet<string>): Promise<OverlapModelCardRecord> {
	const source = OverlapModelSource.ModelCard

	const card = await readLocalJSONFile<{
		training?: { corpus_version?: unknown; init_from?: unknown }
	}>(path)

	const corpusVersion = card.training?.corpus_version

	if (typeof corpusVersion !== "string" || !corpusVersion) {
		return {
			path,
			source,
			corpusVersion: null,
			matched: false,
			problem: "the card records no training.corpus_version",
		}
	}

	if (card.training?.init_from != null) {
		return {
			path,
			source,
			corpusVersion,
			matched: false,
			problem: "the card records an init_from whose training corpora are not named",
		}
	}

	return matchTrainingCorpus(path, source, corpusVersion, corporaRead)
}

/**
 * Reads one training config's corpus identity: `data.corpus_dir`'s version and
 * whether `train.init_from` is set.
 *
 * @throws {TrainingConfigError} When the config doesn't load as the trainer loads it.
 */
async function readTrainingConfigCorpus(
	path: string,
	corporaRead: ReadonlySet<string>
): Promise<OverlapModelCardRecord> {
	const source = OverlapModelSource.TrainingConfig
	const config = typedTrainingConfig(await readTrainingConfig(path), path)
	const corpusVersion = trainingCorpusVersion(config)

	if (config.train.init_from) {
		return {
			path,
			source,
			corpusVersion,
			matched: false,
			problem: `the config's train.init_from ${config.train.init_from} names a checkpoint whose training corpora are not named`,
		}
	}

	return matchTrainingCorpus(path, source, corpusVersion, corporaRead)
}

/**
 * Reads every compared model's training corpus and the reasons, if any, that refuse `verified_unseen`.
 */
async function readComparedModels(
	cardPaths: readonly string[],
	configPaths: readonly string[],
	corpora: readonly OverlapCorpusRecord[],
	corporaRead: ReadonlySet<string>
): Promise<{ modelCards: OverlapModelCardRecord[]; reasons: string[] }> {
	const modelCards = [
		...(await Promise.all(cardPaths.map((path) => readModelCard(path, corporaRead)))),
		...(await Promise.all(configPaths.map((path) => readTrainingConfigCorpus(path, corporaRead)))),
	]

	const reasons: string[] = []

	if (!modelCards.length) {
		reasons.push("no model card was named, so the training corpora of the compared models are unestablished")
	}

	for (const card of modelCards) {
		if (!card.matched) {
			const what = card.source === OverlapModelSource.TrainingConfig ? "training config" : "model card"

			reasons.push(`${what} ${card.path}: ${card.problem}`)
		}
	}

	for (const record of corpora) {
		if (!record.corpusVersion) {
			reasons.push(`corpus manifest ${record.manifest} records no corpus_version`)
		}
	}

	return { modelCards, reasons }
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
	 * Training configs of compared models whose cards do not record their training corpus.
	 *
	 * Each is read for `data.corpus_dir` and `train.init_from` and is held to the rules a model card is.
	 */
	trainingConfigs?: readonly string[]
	/**
	 * Which of `modelCards` or `trainingConfigs` is the candidate's.
	 *
	 * When this source is selected and its corpus was read, a row absent from that corpus
	 * is at least `unseen_by_candidate`, whatever the published model's history.
	 */
	candidateModelCard?: string
	pathRoot: string
	verifyFileSHA256?: boolean
	/**
	 * Each row's text, keyed by row identity, for the folded-text comparison.
	 * Without it the audit compares identities and groups only.
	 *
	 * @throws When a dataset row has no text here.
	 */
	rowTexts?: ReadonlyMap<string, string>
	/**
	 * Each row's source, text and spans, keyed by row identity, for the address-key comparison.
	 *
	 * Rows of a source `GROUP_ADDRESS_KEY_SOURCES` lists are compared with that
	 * source's training rows by address key.
	 * Without it the audit compares no address.
	 */
	addressRows?: ReadonlyMap<string, AddressKeyedRow>
	/**
	 * An evaluation-group list to preview: a training row whose group or address key it
	 * holds is left out, as a re-split under it would send the row to `test`.
	 */
	previewEvaluationGroups?: EvaluationGroups
	/**
	 * The DuckDB connection's memory and thread limits; `openDuckDB`'s shares of the host when omitted.
	 */
	duckDBLimits?: DuckDBLimits
}): Promise<OverlapProvenanceFile> {
	const { dataset } = input

	if (!input.corpora.length) throw new Error("the overlap audit names no training corpus")

	const trainingConfigs = input.trainingConfigs ?? []

	if (
		input.candidateModelCard != null &&
		!input.modelCards.includes(input.candidateModelCard) &&
		!trainingConfigs.includes(input.candidateModelCard)
	) {
		throw new Error(
			`the candidate model card ${input.candidateModelCard} is not among the model cards or training configs named`
		)
	}

	const byID = new Set(dataset.rows.map((entry) => entry.rowID))
	const byGroup = Map.groupBy(dataset.rows, (entry) => entry.group)
	const evidence = new Map<string, string>()
	/**
	 * The corpora (by `corpus_version`, else manifest path) each overlapping row was found in.
	 */
	const overlapCorpora = new Map<string, Set<string>>()
	const corpora: OverlapCorpusRecord[] = []

	/**
	 * The kinds of match each overlapping row was found by.
	 */
	const overlapKinds = new Map<string, Set<OverlapKind>>()

	const recordOverlap = (rowID: string, label: string, kind: OverlapKind, detail: string) => {
		if (!evidence.has(rowID)) {
			evidence.set(rowID, detail)
		}

		overlapKinds.set(rowID, (overlapKinds.get(rowID) ?? new Set<OverlapKind>()).add(kind))

		const found = overlapCorpora.get(rowID) ?? new Set<string>()

		found.add(label)
		overlapCorpora.set(rowID, found)
	}

	using db = await openDuckDB(input.duckDBLimits)

	await loadKeys(db, "eval_ids", byID)
	await loadKeys(db, "eval_groups", byGroup.keys())

	const matchText = input.rowTexts != null
	const byText = input.rowTexts ? await loadTextKeys(db, dataset, input.rowTexts) : new Map<string, string[]>()
	const matchAddress = input.addressRows != null
	const preview = input.previewEvaluationGroups
	const { byAddress, addressBlocks } = indexAddressRows(dataset, input.addressRows)

	await loadKeys(db, "eval_address_blocks", addressBlocks)

	const readSpans = matchAddress || preview != null
	const addressFilter = matchAddress && addressBlocks.size ? ` OR ${addressBlockFilterSQL()}` : ""

	for (const manifestPath of input.corpora) {
		const manifest = await readLocalJSONFile<{
			corpus_version?: unknown
			files?: unknown
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
			// A file with no base_source_id column records no derivation, so each row
			// is its own group, as a NULL base_source_id is.
			// The file record's baseSourceIDAbsent field records this distinction.
			// The identity columns stay required.
			const baseSourceIDAbsent = !columns.includes("base_source_id")

			const missing = requiredColumns(matchText, readSpans).filter((column) => !columns.includes(column))
			const baseColumn = baseSourceIDAbsent ? "CAST(NULL AS VARCHAR)" : "t.base_source_id"

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

			const testIDs: ReadonlySet<string> =
				split === "attribute" ? await readAttributeTestIDs(descriptor, manifestPath, input.pathRoot) : new Set()

			const textColumn = matchText ? overlapTextFoldSQL("t.raw") : "CAST(NULL AS VARCHAR)"
			const spanSelect = readSpans ? `, t.raw AS raw, ${SPAN_COLUMNS.map((c) => `t.${c} AS ${c}`).join(", ")}` : ""

			const reader = await db.runAndReadAll(
				`SELECT t.source AS source, t.source_id AS source_id, ${baseColumn} AS base_source_id, ` +
					`${textColumn} AS folded${spanSelect} FROM ${quoted} t ` +
					`WHERE (t.source || ':' || t.source_id) IN (SELECT k FROM eval_ids) ` +
					`OR ${recordIDSQL(`coalesce(${baseColumn}, t.source_id)`)} IN (SELECT k FROM eval_groups)` +
					(matchText ? ` OR ${textColumn} IN (SELECT k FROM eval_texts)` : "") +
					addressFilter
			)

			let matches = 0
			let excludedTestRows = 0
			let excludedPreviewRows = 0

			for (const row of reader.getRowObjects()) {
				const sourceID = row.source_id == null ? null : String(row.source_id)

				if (sourceID != null && testIDs.has(sourceID)) {
					excludedTestRows++

					continue
				}

				const { group, addressKey } = trainingRowKeys(row, sourceID, readSpans)

				if (preview && previewHolds(preview, group, addressKey)) {
					excludedPreviewRows++

					continue
				}

				matches++

				const trainingID = `${String(row.source)}:${String(sourceID)}`
				const where = `in ${label} ${split} file ${descriptor.path}`

				if (byID.has(trainingID)) {
					recordOverlap(trainingID, label, OverlapKind.Identity, `identity ${trainingID} ${where}`)
				}

				for (const member of (matchAddress && addressKey != null && byAddress.get(addressKey)) || []) {
					recordOverlap(
						member,
						label,
						OverlapKind.Address,
						`address key "${addressKey}" (training row ${trainingID}) ${where}`
					)
				}

				for (const member of (group != null && byGroup.get(group)) || []) {
					recordOverlap(member.rowID, label, OverlapKind.Group, `group ${group} (training row ${trainingID}) ${where}`)
				}

				const folded = row.folded == null ? null : String(row.folded)

				for (const member of (folded != null && byText.get(folded)) || []) {
					recordOverlap(
						member,
						label,
						OverlapKind.Text,
						`folded text "${folded}" (training row ${trainingID}) ${where}`
					)
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
				...(preview ? { excludedPreviewRows } : {}),
				...(baseSourceIDAbsent ? { baseSourceIDAbsent } : {}),
				matches,
			})
		}

		corpora.push(record)
	}

	const corporaRead = new Set(corpora.flatMap((record) => (record.corpusVersion ? [record.corpusVersion] : [])))
	const { modelCards, reasons } = await readComparedModels(input.modelCards, trainingConfigs, corpora, corporaRead)
	const verifiedUnseenAdmitted = reasons.length === 0

	const candidateCard =
		input.candidateModelCard == null ? null : modelCards.find((card) => card.path === input.candidateModelCard)!

	// The candidate's own history is established when its card records a corpus
	// that was read and no init_from.
	// Overlap is labeled by the manifest's corpus_version.
	// That value may lack the card's `v` prefix.
	const candidateCorpus =
		candidateCard?.matched && candidateCard.corpusVersion != null
			? corpusReadAs(candidateCard.corpusVersion, corporaRead)
			: null

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
		textCompared: matchText,
		...(matchAddress ? { addressCompared: true as const } : {}),
		...(preview ? { preview: { evaluationGroups: preview.path, sha256: preview.sha256 } } : {}),
		reasons,
		counts,
		overlapRows: countOverlapKinds(overlapKinds.values()),
	}

	const auditSHA256 = sha256Hex(canonicalJSON(audit))
	const cite = `overlap audit ${auditSHA256.slice(0, 16)} of ${dataset.datasetID}@${dataset.version}`

	const unseenEvidence =
		`${cite}: absent ${comparedPhrase(matchText, matchAddress)} from ${[...corporaRead].toSorted().join(", ")}` +
		`${preview ? `, as a re-split under ${preview.path} (${preview.sha256.slice(0, 16)}) would write them` : ""}` +
		", every train and val file read"

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
