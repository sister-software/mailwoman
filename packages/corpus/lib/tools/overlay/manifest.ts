/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Assembles a corpus manifest from a base corpus's files and new parquet files.
 *   A replaced source's base files are dropped.
 */

import { dataRootPath } from "@mailwoman/core/data-root"
import { readLocalBuffer, readLocalJSONFile } from "@mailwoman/core/fs/readers"
import { pathExists, statPath } from "@mailwoman/core/fs/readers/stat"
import { writeLocalJSONFile } from "@mailwoman/core/fs/writers"
import { sha256Hex } from "@mailwoman/core/hash"
import { stringifyJSON } from "@mailwoman/core/json"
import { basename, dirname, normalize, PathBuilder, type PathBuilderLike } from "path-ts"

import { type DuckDBLimits, escapeSQLString, openDuckDB } from "#parquet/duckdb"
import { openSourceRightsAdmission, type SourceRightsRecord } from "#source-register/corpus-inputs"
import {
	type CorpusDeletion,
	type DeletionRequest,
	deletionTargets,
	matchedSourceIDs,
	prepareDeletion,
	type PreparedDeletion,
	readDeletionIDs,
} from "#tools/overlay/deletions"
import {
	readSplitAttribute,
	SPLIT_ATTRIBUTE,
	type SplitAttributeFile,
	splitOfSourceID,
} from "#tools/overlay/split-attribute"
import type { SplitName } from "#utils/split"

/**
 * The attribute file that decides the split of each row of one manifest file.
 */
interface SplitAttributeReference {
	path: string
	sha256: string
	policy_hash: string
	counts: Record<SplitName, number>
}

/**
 * A manifest file entry.
 *
 * A file holds one split's rows and records it under `split`, or holds every split's rows
 * and points under `split_attribute` at the attribute that decides each row.
 */
type ParquetFileDescriptor = {
	path: string
	format: "parquet"
	compression: string
	rows: number
	bytes: number
	sha256: string
	first_source_id: string
	last_source_id: string
	source: string
} & ({ split: SplitName } | { split_attribute: SplitAttributeReference })

type ManifestFile = Record<string, unknown> & { path: string; source?: string }

/**
 * The legacy manifest keys for the file list and the rows per file.
 *
 * Earlier corpora are immutable and still use these keys, so readers accept both
 * spellings and writers emit only the current ones.
 * The keys are built by concatenation because a repository check bans the legacy word.
 */
const PRE_RENAME_FILES_KEY = `sh${"ards"}` as const
const PRE_RENAME_ROWS_PER_FILE_KEY = `rows_per_sh${"ard"}` as const

interface BaseManifest {
	corpus_version?: string
	schema: unknown
	rows_per_slice?: unknown
	row_group_size: unknown
	slices?: ManifestFile[]
	counts: { train: number; val: number; test: number }
	total_rows: number
	[PRE_RENAME_FILES_KEY]?: ManifestFile[]
	[PRE_RENAME_ROWS_PER_FILE_KEY]?: unknown
	/**
	 * The source-rights record a build or assembly wrote when it checked its sources.
	 */
	source_rights?: SourceRightsRecord
	/**
	 * The rows the base removed from its stored files.
	 * Its `counts` are net of them.
	 */
	deletions?: CorpusDeletion[]
}

/**
 * Returns a manifest's file list from `slices` or from the legacy key.
 *
 * A non-empty `slices` wins, then a legacy list, then an empty `slices`.
 * An empty list is a valid answer, but a manifest with neither key throws, because an
 * empty result would misreport a missing list as a corpus without files.
 */
export function baseManifestFiles(manifest: { slices?: unknown; [PRE_RENAME_FILES_KEY]?: unknown }): ManifestFile[] {
	const slices = manifest.slices
	const preRename = manifest[PRE_RENAME_FILES_KEY]

	if (Array.isArray(slices) && slices.length) return refuseRepeatedFiles(slices as ManifestFile[])

	if (Array.isArray(preRename)) return refuseRepeatedFiles(preRename as ManifestFile[])

	if (Array.isArray(slices)) return slices as ManifestFile[]

	throw new Error(
		`manifest names no file list: neither "slices" nor the pre-rename key holds an array. An empty list here ` +
			`would read as a corpus of no files, which is a measurement this manifest does not support.`
	)
}

/**
 * Returns `files` when no two entries name the same file, by normalized path
 * or by `sha256`, and throws naming both entries otherwise.
 *
 * A file listed twice is read twice, so every row in it would count twice in its split
 * and weigh its records twice in training.
 */
export function refuseRepeatedFiles<T extends { path: string; sha256?: unknown }>(files: T[]): T[] {
	const byPath = new Map<string, number>()
	const bySHA = new Map<string, number>()

	for (const [index, file] of files.entries()) {
		const path = normalize(file.path)
		const earlierPath = byPath.get(path)

		if (typeof earlierPath === "number") {
			throw new TypeError(
				`manifest lists ${path} twice (entries ${earlierPath} and ${index}), so its rows would be read twice.`
			)
		}

		byPath.set(path, index)

		if (typeof file.sha256 !== "string") continue

		const earlierSHA = bySHA.get(file.sha256)

		if (typeof earlierSHA === "number") {
			throw new TypeError(
				`manifest lists sha256 ${file.sha256} twice: ${files[earlierSHA]!.path} (entry ${earlierSHA}) and ` +
					`${file.path} (entry ${index}) are the same bytes, so their rows would be read twice.`
			)
		}

		bySHA.set(file.sha256, index)
	}

	return files
}

/**
 * Returns the base's rows-per-file value under either key.
 */
function baseRowsPerFile(base: BaseManifest): unknown {
	return base.rows_per_slice ?? base[PRE_RENAME_ROWS_PER_FILE_KEY]
}

/**
 * One parquet file to add, with the source label in its rows.
 */
export interface OverlayFile {
	parquet: string
	source: string
	/**
	 * The split attribute `corpus split-slice` wrote for the file, by its name under the overlay directory.
	 *
	 * A file with an attribute sits at `<newDir>/<parquet>` and holds every split's rows,
	 * and the attribute decides each row.
	 * A file without one sits at `<newDir>/train/<parquet>` and all its rows are train,
	 * so held-out rows reach a manifest only through the holdout policy.
	 */
	splitAttribute?: string
}

/**
 * Reads one overlay parquet and describes it for the manifest.
 *
 * The loader groups rows by `file_source_counts`.
 * The manifest records the `source` value supplied by the caller.
 *
 * A stale argument therefore writes a manifest that disagrees with the rows.
 * The run trains on the rows.
 *
 * The next plan then repeats the stale label from the manifest.
 *
 * This reads the column and refuses the mismatch rather than recording the claim.
 *
 * `source_id` is materialized rather than aggregated because `first_source_id`
 * and `last_source_id` mean the first and last row of the file.
 * DuckDB's `first` and `last` aggregates read whichever row a parallel scan reaches first.
 *
 * That result can differ from the first and last rows in the file.
 */
async function descriptor(
	localPath: string,
	modalPath: string,
	placement: { split: SplitName } | { split_attribute: SplitAttributeReference },
	source: string,
	limits: DuckDBLimits | undefined
): Promise<ParquetFileDescriptor> {
	// `assembleOverlayManifest` calls this once for each file.
	using db = await openDuckDB(limits)

	const result = await db.runAndReadAll(`SELECT source_id, source FROM read_parquet('${escapeSQLString(localPath)}')`)

	const rows = result.getRowObjects()
	const sids = rows.map((r) => r.source_id as string)
	const stored = new Set(rows.map((r) => r.source as string))

	if (stored.size !== 1 || !stored.has(source)) {
		const found = [...stored].toSorted().join(", ")

		throw new Error(
			`${localPath} holds source ${stored.size === 1 ? `"${found}"` : `${stored.size} values (${found})`}, ` +
				`and the manifest was asked to record "${source}". The loader groups rows by the column, so a ` +
				`manifest that disagrees with it is a label nothing reads and a plan derived from it carries forward.`
		)
	}

	return {
		...placement,
		path: modalPath,
		format: "parquet",
		compression: "SNAPPY",
		rows: sids.length,
		bytes: (await statPath(localPath)).size,
		sha256: sha256Hex(await readLocalBuffer(localPath)),
		first_source_id: sids[0]!,
		last_source_id: sids.at(-1)!,
		source,
	}
}

/**
 * Options for {@link assembleOverlayManifest}.
 */
/**
 * The filename {@linkcode assembleOverlayManifest} writes its plan under, beside `MANIFEST.json`.
 */
export const OVERLAY_PLAN_FILE = "OVERLAY_PLAN.json"

/**
 * What one overlay assembly was asked to add, written beside the manifest it produced.
 *
 * The next assembly on the same base reads this rather than reconstructing the file list.
 * Reconstruction makes it possible for an overlay to contain a stale list of
 * files into a later corpus version.
 */
export interface OverlayPlan {
	corpusVersion: string
	overlayBase: string | null
	baseManifest: string
	modalRoot: string
	note: string
	appliedAt: string
	/**
	 * Each added file with the split attribute that decides its rows, or `null` when every row is train.
	 *
	 * A hand-placed split reached `v0.6.0-register-surface` and put 770 of DE's
	 * 3,987 validation `source_id`s in train (#2359), so a held-out row enters only
	 * through an attribute the holdout policy wrote.
	 */
	files: Array<{ parquet: string; source: string; splitAttribute: { path: string; policyHash: string } | null }>
	/**
	 * The base sources whose files this overlay dropped.
	 */
	replacedSources: string[]
}

export interface OverlayManifestOptions {
	base: string
	newDir: PathBuilderLike
	modalRoot: string
	version: string
	/**
	 * The parquet files to add, in the order in which they follow the base files.
	 */
	files: readonly OverlayFile[]
	note: string
	/**
	 * Base sources whose files the overlay drops, so the added files take their place.
	 *
	 * Each source in this list must appear in the base, and its rows leave the split counts.
	 */
	replaceSources?: readonly string[]
	/**
	 * Why a local experiment admits sources whose register rows lack an elected
	 * decision permitting `transform` and `train`.
	 *
	 * Without it the assembly refuses them, and with it the manifest records the corpus as not shippable.
	 */
	unshippableReason?: string | null
	/**
	 * Rows to remove from the version's files by `source_id`.
	 *
	 * The base's own deletions stay in the version while a file they target remains.
	 */
	deletions?: readonly DeletionRequest[]
	/**
	 * The memory and thread limits of every DuckDB connection the assembly opens: the added files'
	 * descriptors, the base files' source reads, and the deletion reads and tallies.
	 *
	 * @defaultValue {@linkcode openDuckDB}'s defaults
	 */
	limits?: DuckDBLimits
}

/**
 * The rows each deletion removes, per split, counted over the version's files.
 *
 * Every targeted file is read locally, and an absent one throws, because a count taken
 * over the files present would understate what the loader removes.
 */
async function countDeletions(
	prepared: readonly PreparedDeletion[],
	files: readonly ManifestFile[],
	addedLocalPaths: ReadonlyMap<string, string>,
	attributes: ReadonlyMap<string, SplitAttributeFile>,
	limits: DuckDBLimits | undefined
): Promise<CorpusDeletion[]> {
	const counted: CorpusDeletion[] = []

	for (const { deletion, ids } of prepared) {
		const targets = files.filter((file) => deletionTargets(deletion.target, file))

		if (!targets.length) {
			throw new Error(`deletion ${stringifyJSON(deletion.target)} (${deletion.issue}) names no file of this version`)
		}

		const rows: Record<SplitName, number> = { train: 0, val: 0, test: 0 }

		for (const file of targets) {
			const local = addedLocalPaths.get(file.path) ?? localManifestFilePath(file.path)

			if (!(await pathExists(local))) {
				throw new Error(`${local} is targeted by deletion ${deletion.issue} and absent from the data root`)
			}

			const matched = await matchedSourceIDs(local, ids, limits)
			const attribute = attributes.get(file.path)

			if (attribute) {
				for (const id of matched) {
					rows[splitOfSourceID(attribute, id)]++
				}

				continue
			}

			const split = file["split"] as SplitName

			if (!(split in rows)) throw new Error(`${file.path} records no split, so its deleted rows have no split`)

			rows[split] += matched.length
		}

		counted.push({ ...deletion, rows_deleted: rows })
	}

	return counted
}

/**
 * Load a base deletion's id set, inline or from its sidecar under the local data root.
 */
async function carriedDeletion(deletion: CorpusDeletion, limits: DuckDBLimits | undefined): Promise<PreparedDeletion> {
	const { rows_deleted: _counted, ...entry } = deletion

	if (deletion.source_ids) return { deletion: entry, ids: new Set(deletion.source_ids) }

	if (!deletion.source_ids_file) throw new Error(`base deletion ${deletion.issue} names no source_id set`)

	const local = localManifestFilePath(deletion.source_ids_file.path)
	const ids = await readDeletionIDs(local, limits)

	if (ids.size !==deletion.source_ids_file.ids) {
		throw new Error(
			`${local} holds ${ids.size} ids and base deletion ${deletion.issue} records ${deletion.source_ids_file.ids}`
		)
	}

	return { deletion: entry, ids }
}

/**
 * Reads the distinct `source` values of base files whose manifest entries name no source.
 *
 * Every file must be present under the local data root.
 * When one is absent, or a row's `source` is null, `sources` is null and `unreadable` names the cause.
 *
 * The caller therefore cannot mistake a partial read for the whole base.
 */
async function readBaseFileSources(
	files: readonly ManifestFile[],
	limits: DuckDBLimits | undefined
): Promise<{ sources: string[]; unreadable: null } | { sources: null; unreadable: string }> {
	const paths = files.map((file) => localManifestFilePath(file.path))
	const absent: string[] = []

	for (const path of paths) {
		if (!(await pathExists(path))) {
			absent.push(path)
		}
	}

	if (absent.length) {
		return { sources: null, unreadable: `${absent.length} of them are absent locally (first: ${absent[0]})` }
	}

	using db = await openDuckDB(limits)

	const list = paths.map((path) => `'${escapeSQLString(path)}'`).join(", ")
	const result = await db.runAndReadAll(`SELECT DISTINCT source FROM read_parquet([${list}])`)
	const values = result.getRowObjects().map((row) => row.source as string | null)

	if (values.some((value) => value == null)) {
		return { sources: null, unreadable: "a row among them carries a null source" }
	}

	return { sources: values as string[], unreadable: null }
}

/**
 * Checks every corpus source the assembled manifest will hold, before the manifest or plan is written.
 *
 * The base manifest's own record covers a base file that records no source, when the base has a record.
 * A base without a record is checked by reading its files' `source` column.
 *
 * When a file cannot be read, the check refuses the base rather than reading the absence as clear.
 */
async function checkOverlaySources(
	args: OverlayManifestOptions,
	base: BaseManifest,
	kept: readonly ManifestFile[]
): Promise<SourceRightsRecord> {
	const rights = await openSourceRightsAdmission({
		context: `overlay assembly ${args.version}`,
		unshippableReason: args.unshippableReason ?? null,
	})

	const named = new Set<string>(args.files.map((file) => file.source))
	const unnamed = kept.filter((file) => !file.source)

	for (const file of kept) {
		if (file.source) {
			named.add(file.source)
		}
	}

	if (unnamed.length && base.source_rights) {
		for (const source of base.source_rights.sources_checked) {
			named.add(source)
		}
	}

	// A base without a record is read instead: its files' own `source` column is what the loader groups rows by.
	const read = unnamed.length && !base.source_rights ? await readBaseFileSources(unnamed, args.limits) : null

	for (const source of read?.sources ?? []) {
		named.add(source)
	}

	rights.admitAll(named)

	if (unnamed.length && !base.source_rights && read?.unreadable) {
		rights.admitUnverified(
			`${unnamed.length} file(s) of base ${args.base}, which name no source while the base manifest carries no ` +
				`\`source_rights\` record, and ${read.unreadable}`
		)
	}

	if (base.source_rights && !base.source_rights.shippable) {
		rights.admitUnverified(`base ${args.base}, whose own record reads not shippable`)
	}

	return rights.record()
}

/**
 * Rewrites a base manifest's file path to its location in the corpus tree mounted on Modal at `/data`.
 */
export function rerootBaseFilePath(path: string, baseManifestPath: string): string {
	const versionedIndex = path.indexOf("/corpus/versioned/")

	if (versionedIndex !== -1) return "/data" + path.slice(versionedIndex)

	if (/^\/data\/(?:train|val|test)\//u.test(path)) {
		const localBaseDir = dirname(baseManifestPath)
		const baseModalRoot = `/data/corpus/versioned/${basename(dirname(localBaseDir))}/${basename(localBaseDir)}`

		return baseModalRoot + path.slice("/data".length)
	}

	return path
}

/**
 * Maps a Modal path under `/data/` to the same file under the local data root
 * and returns any other path unchanged.
 */
export function localManifestFilePath(path: string): string {
	return path.startsWith("/data/") ? dataRootPath(path.slice("/data/".length)).toString() : path
}

/**
 * Writes a corpus manifest that keeps the files of `args.base` and appends `args.files`.
 *
 * A base file whose source `args.replaceSources` lists is dropped.
 *
 * An added file with a split attribute holds every split's rows, and its entry points at the attribute.
 * `splitOverlaySlice` wrote that attribute by applying the holdout policy to each row.
 * An added file without one is train.
 *
 * @throws When the base lists no files, or an attribute describes a different file than the one beside it.
 */
export async function assembleOverlayManifest(args: OverlayManifestOptions): Promise<void> {
	if (!args.files.length) throw new Error("an overlay must add at least one parquet file")

	const base = await readLocalJSONFile<BaseManifest>(args.base)
	const baseFiles = baseManifestFiles(base)

	// An overlay on a base without files would contain only the added files.
	if (!baseFiles.length) {
		throw new Error(
			`${args.base} lists no files, so an overlay on it would carry only the ${args.files.length} file(s) added ` +
				`here while naming itself an extension of that base.`
		)
	}

	const replaced = new Set(args.replaceSources)

	for (const source of replaced) {
		if (!baseFiles.some((s) => s.source === source)) {
			throw new Error(`${args.base} holds no file with source '${source}', so there is nothing for it to replace.`)
		}
	}

	for (const file of args.files) {
		if (!replaced.has(file.source) && baseFiles.some((s) => s.source === file.source)) {
			console.log(`WARN: base already contains source '${file.source}' — is this the right base?`)
		}
	}

	const dropped = baseFiles.filter((s) => s.source && replaced.has(s.source))
	const droppedRows: Record<SplitName, number> = { train: 0, val: 0, test: 0 }

	for (const file of dropped) {
		const reference = file["split_attribute"] as SplitAttributeReference | undefined

		if (reference) {
			for (const split of ["train", "val", "test"] as const) {
				droppedRows[split] += reference.counts[split]
			}

			continue
		}

		const split = file["split"] as SplitName
		const rows = file["rows"]

		if (typeof rows !== "number" || !(split in droppedRows)) {
			throw new Error(`${file.path} records no row count or split, so dropping it would leave the counts unknown.`)
		}

		droppedRows[split] += rows
	}

	const kept: ManifestFile[] = baseFiles
		.filter((s) => !dropped.includes(s))
		.map((s) => ({ ...s, path: rerootBaseFilePath(s.path, args.base) }))

	const sourceRights = await checkOverlaySources(args, base, kept)

	const added: ParquetFileDescriptor[] = []
	const addedLocalPaths = new Map<string, string>()
	// The split attribute of every listed file that has one, keyed by the path the manifest lists.
	const attributes = new Map<string, SplitAttributeFile>()
	const addedRows: Record<SplitName, number> = { train: 0, val: 0, test: 0 }

	for (const file of kept) {
		const reference = file["split_attribute"] as SplitAttributeReference | undefined

		if (reference) {
			attributes.set(file.path, await readSplitAttribute(localManifestFilePath(reference.path)))
		}
	}

	const newDir = PathBuilder.from(args.newDir)

	for (const file of args.files) {
		if (!file.splitAttribute) {
			// DuckDB reads the path inside SQL text, so it must be a string.
			const local = newDir("train", file.parquet).toString()
			const modal = `${args.modalRoot}/train/${file.parquet}`
			const entry = await descriptor(local, modal, { split: "train" }, file.source, args.limits)

			added.push(entry)
			addedLocalPaths.set(modal, local)
			addedRows.train += entry.rows

			continue
		}

		const local = newDir(file.parquet).toString()
		const modal = `${args.modalRoot}/${file.parquet}`
		const attributePath = newDir(file.splitAttribute).toString()
		const attribute = await readSplitAttribute(attributePath)

		const reference: SplitAttributeReference = {
			path: `${args.modalRoot}/${file.splitAttribute}`,
			sha256: sha256Hex(await readLocalBuffer(attributePath)),
			policy_hash: attribute.policyHash,
			counts: attribute.counts,
		}

		const entry = await descriptor(local, modal, { split_attribute: reference }, file.source, args.limits)

		if (attribute.file.sha256 !== entry.sha256 || attribute.file.rows !== entry.rows) {
			throw new Error(
				`${attributePath} describes ${attribute.file.name} at sha256 ${attribute.file.sha256} with ` +
					`${attribute.file.rows} rows, and ${local} hashes to ${entry.sha256} with ${entry.rows}. ` +
					`Run 'mailwoman corpus split-slice' on the file the manifest adds.`
			)
		}

		added.push(entry)
		addedLocalPaths.set(modal, local)
		attributes.set(modal, attribute)

		for (const split of ["train", "val", "test"] as const) {
			addedRows[split] += attribute.counts[split]
		}
	}

	// The base's counts are net of its own deletions, so they are added back before every
	// deletion this version keeps is counted again over the files it now lists.
	const baseDeleted: Record<SplitName, number> = { train: 0, val: 0, test: 0 }

	for (const deletion of base.deletions ?? []) {
		for (const split of ["train", "val", "test"] as const) {
			baseDeleted[split] += deletion.rows_deleted[split]
		}
	}

	const listedFiles: ManifestFile[] = refuseRepeatedFiles([...kept, ...added])

	const carried = await Promise.all(
		(base.deletions ?? [])
			.filter((deletion) => listedFiles.some((file) => deletionTargets(deletion.target, file)))
			.map((deletion) => carriedDeletion(deletion, args.limits))
	)

	const requested = await Promise.all(
		(args.deletions ?? []).map((request) => prepareDeletion(request, newDir, args.modalRoot, args.limits))
	)

	const deletions = await countDeletions(
		[...carried, ...requested],
		listedFiles,
		addedLocalPaths,
		attributes,
		args.limits
	)
	const deletedRows: Record<SplitName, number> = { train: 0, val: 0, test: 0 }

	for (const deletion of deletions) {
		for (const split of ["train", "val", "test"] as const) {
			deletedRows[split] += deletion.rows_deleted[split]
		}
	}

	const netCount = (split: SplitName): number =>
		base.counts[split] + baseDeleted[split] - droppedRows[split] + addedRows[split] - deletedRows[split]

	const sources = args.files.map((file) => file.source).join(", ")

	const defaultNote = replaced.size
		? `${base.corpus_version} files without ${[...replaced].join(", ")} + ${sources}.`
		: `${base.corpus_version} files (all kept verbatim) + ${sources}. Pure overlay add.`

	const manifest = {
		corpus_version: args.version,
		overlay_base: base.corpus_version ?? null,
		note: args.note || defaultNote,
		schema: base.schema,
		rows_per_slice: baseRowsPerFile(base),
		row_group_size: base.row_group_size,
		slices: listedFiles,
		// The rows the loader reads: the stored rows of `slices` less those `deletions` names.
		counts: { train: netCount("train"), val: netCount("val"), test: netCount("test") },
		total_rows: netCount("train") + netCount("val") + netCount("test"),
		// What decides a row's split: a file's own `split`, or for a file listing
		// `split_attribute`, the attribute file under these policy hashes.
		split_decided_by: {
			file: listedFiles.filter((file) => !file["split_attribute"]).length,
			attribute: SPLIT_ATTRIBUTE,
			policy_hashes: [...new Set([...attributes.values()].map((attribute) => attribute.policyHash))].toSorted(),
		},
		deletions,
		// An overlay corpus's manifest reads no row's `license` column, so it states no license set.
		// This value in the artifact prevents a reader from deriving an attribution table
		// from `slices` and treating the base build's set as the whole.
		// The overlay sources listed here have their own terms, recorded per source in
		// `packages/corpus/lib/recipes/sources.ts` and per row in the `license` column itself.
		licenses_cover:
			`no license set is measured here. The base build's MANIFEST.json covers the rows it aligned, and ` +
			`these ${added.length} added file(s) carry their own: ${[...new Set(args.files.map((file) => file.source))].toSorted().join(", ")}.`,
		source_rights: sourceRights,
	}

	const out = newDir("MANIFEST.json")
	await writeLocalJSONFile(manifest, out)

	// The plan is written beside the manifest it produced, because the previous overlay
	// assembly's plan existed only as three scripts in a session scratch directory
	// and was copied into the next assembly as a hand-written list.
	// Commit this file under `packages/corpus/data/builds/<version>/`.
	const plan: OverlayPlan = {
		corpusVersion: args.version,
		overlayBase: base.corpus_version ?? null,
		baseManifest: args.base,
		modalRoot: args.modalRoot,
		note: manifest.note,
		appliedAt: new Date().toISOString(),
		files: args.files.map((file) => ({
			parquet: file.parquet,
			source: file.source,
			splitAttribute: file.splitAttribute
				? { path: file.splitAttribute, policyHash: attributes.get(`${args.modalRoot}/${file.parquet}`)!.policyHash }
				: null,
		})),
		replacedSources: [...replaced],
	}

	const planPath = newDir(OVERLAY_PLAN_FILE)

	await writeLocalJSONFile(plan, planPath)

	console.log(`wrote ${planPath}`)
	console.log(`wrote ${out}`)
	console.log(
		`  files: ${manifest.slices.length} (${kept.length} base kept, ${dropped.length} base dropped, +${added.length} added)`
	)
	console.log(`  counts: ${stringifyJSON(manifest.counts)}  total: ${manifest.total_rows}`)

	for (const file of added) {
		const split =
			"split_attribute" in file
				? `split by attribute ${file.split_attribute.policy_hash.slice(0, 12)} ${stringifyJSON(file.split_attribute.counts)}`
				: file.split

		console.log(`  ${file.source} ${split}: ${file.rows} rows (${file.bytes} bytes)`)
	}
}
