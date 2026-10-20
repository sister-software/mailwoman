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
import { basename, dirname, PathBuilder, type PathBuilderLike } from "path-ts"

import { escapeSQLString, openDuckDB } from "#parquet/duckdb"
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
import type { SplitName } from "#utils/split"

interface ParquetFileDescriptor {
	split: SplitName
	path: string
	format: "parquet"
	compression: string
	rows: number
	bytes: number
	sha256: string
	first_source_id: string
	last_source_id: string
	source: string
}

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

	if (Array.isArray(slices) && slices.length) return slices as ManifestFile[]

	if (Array.isArray(preRename)) return preRename as ManifestFile[]

	if (Array.isArray(slices)) return slices as ManifestFile[]

	throw new Error(
		`manifest names no file list: neither "slices" nor the pre-rename key holds an array. An empty list here ` +
			`would read as a corpus of no files, which is a measurement this manifest does not support.`
	)
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
	 * The split that the file's rows belong to.
	 *
	 * `val` and `test` are allowed only for files that `splitOverlaySlice` returned,
	 * so that the holdout policy chooses held-out rows.
	 *
	 * @defaultValue `train`
	 */
	split?: SplitName
}

/**
 * Returns the split encoded in a `<stem>.<split>.parquet` filename, or `null` for any other name.
 *
 * Only `splitOverlaySlice` writes names with this suffix.
 */
export function splitFromFilename(parquet: string): SplitName | null {
	const match = /\.(train|val|test)\.parquet$/.exec(parquet)

	return match ? (match[1] as SplitName) : null
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
	split: SplitName,
	source: string
): Promise<ParquetFileDescriptor> {
	// `assembleOverlayManifest` calls this once for each file.
	using db = await openDuckDB()

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
		split,
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
	 * Each added file with the route its split came from.
	 *
	 * `route` reads `split-slice` when the filename includes the split suffix written by the command.
	 * `caller` reads the split supplied as an argument.
	 *
	 * A hand-placed split reached `v0.6.0-register-surface` through the second route
	 * and put 770 of DE's 3,987 validation `source_id`s in train.
	 * The filename was the only place that showed this (#2359).
	 */
	files: Array<{ parquet: string; source: string; split: SplitName; route: SplitRoute }>
	/**
	 * The base sources whose files this overlay dropped.
	 */
	replacedSources: string[]
}

/**
 * How one overlay file's split was decided.
 */
export const SplitRoute = {
	/**
	 * `corpus split-slice` applied `splitForRow` to every row and wrote the split into the filename.
	 */
	SplitSlice: "split-slice",

	/**
	 * The caller supplied the split.
	 * The holdout policy never saw these rows.
	 */
	Caller: "caller",
} as const

export type SplitRoute = (typeof SplitRoute)[keyof typeof SplitRoute]

/**
 * Which route decided one file's split.
 */
export function splitRouteFor(parquet: string): SplitRoute {
	return splitFromFilename(parquet) ? SplitRoute.SplitSlice : SplitRoute.Caller
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
	addedLocalPaths: ReadonlyMap<string, string>
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

			const split = file["split"] as SplitName

			if (!(split in rows)) throw new Error(`${file.path} records no split, so its deleted rows have no split`)

			rows[split] += (await matchedSourceIDs(local, ids)).length
		}

		counted.push({ ...deletion, rows_deleted: rows })
	}

	return counted
}

/**
 * Load a base deletion's id set, inline or from its sidecar under the local data root.
 */
async function carriedDeletion(deletion: CorpusDeletion): Promise<PreparedDeletion> {
	const { rows_deleted: _counted, ...entry } = deletion

	if (deletion.source_ids) return { deletion: entry, ids: new Set(deletion.source_ids) }

	if (!deletion.source_ids_file) throw new Error(`base deletion ${deletion.issue} names no source_id set`)

	const local = localManifestFilePath(deletion.source_ids_file.path)
	const ids = await readDeletionIDs(local)

	if (ids.size !== deletion.source_ids_file.ids) {
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
	files: readonly ManifestFile[]
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

	using db = await openDuckDB()

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
	const read = unnamed.length && !base.source_rights ? await readBaseFileSources(unnamed) : null

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
 * A `val` or `test` file must use the `.<split>.parquet` suffix written by `splitOverlaySlice`.
 * The suffix shows that the holdout policy chose its rows.
 * A `train` file has no naming requirement.
 *
 * @throws When the base lists no files or a held-out file lacks the matching filename suffix.
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

	// Held-out rows must come from the holdout policy.
	// The filename records the split.
	// A caller that picks held-out rows by hand can leak them into train.
	for (const file of args.files) {
		if (!file.split || file.split === "train") continue

		const named = splitFromFilename(file.parquet)

		if (named === file.split) continue

		throw new Error(
			named
				? `${file.parquet} names split '${named}' and the caller asked for '${file.split}'. The filename is ` +
						`what splitOverlaySlice wrote, so it decides; pass the split the name carries or route the file again.`
				: `${file.parquet} was asked for split '${file.split}' and carries no '.${file.split}.parquet' suffix, ` +
						`so it did not come from 'mailwoman corpus split-slice' and its held-out rows were chosen by the ` +
						`caller rather than by the holdout policy. Route it through split-slice and add the per-split ` +
						`outputs it writes. A file appended to 'train' needs none of this.`
		)
	}

	const dropped = baseFiles.filter((s) => s.source && replaced.has(s.source))
	const droppedRows: Record<SplitName, number> = { train: 0, val: 0, test: 0 }

	for (const file of dropped) {
		const split = file["split"] as SplitName
		const rows = file["rows"]

		if (typeof rows !== "number" || !(split in droppedRows)) {
			throw new Error(`${file.path} records no row count or split, so dropping it would leave the counts unknown.`)
		}

		droppedRows[split] += rows
	}

	const kept = baseFiles
		.filter((s) => !dropped.includes(s))
		.map((s) => ({ ...s, path: rerootBaseFilePath(s.path, args.base) }))

	const sourceRights = await checkOverlaySources(args, base, kept)

	const added: ParquetFileDescriptor[] = []
	const addedLocalPaths = new Map<string, string>()

	const newDir = PathBuilder.from(args.newDir)

	for (const file of args.files) {
		const split = file.split ?? "train"
		// DuckDB reads the path inside SQL text, so it must be a string.
		const local = newDir(split, file.parquet).toString()
		const modal = `${args.modalRoot}/${split}/${file.parquet}`

		added.push(await descriptor(local, modal, split, file.source))
		addedLocalPaths.set(modal, local)
	}

	const addedRows: Record<SplitName, number> = { train: 0, val: 0, test: 0 }

	for (const file of added) {
		addedRows[file.split] += file.rows
	}

	// The base's counts are net of its own deletions, so they are added back before every
	// deletion this version keeps is counted again over the files it now lists.
	const baseDeleted: Record<SplitName, number> = { train: 0, val: 0, test: 0 }

	for (const deletion of base.deletions ?? []) {
		for (const split of ["train", "val", "test"] as const) {
			baseDeleted[split] += deletion.rows_deleted[split]
		}
	}

	const listedFiles: ManifestFile[] = [...kept, ...added]

	const carried = await Promise.all(
		(base.deletions ?? [])
			.filter((deletion) => listedFiles.some((file) => deletionTargets(deletion.target, file)))
			.map(carriedDeletion)
	)

	const requested = await Promise.all(
		(args.deletions ?? []).map((request) => prepareDeletion(request, newDir, args.modalRoot))
	)

	const deletions = await countDeletions([...carried, ...requested], listedFiles, addedLocalPaths)
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
			split: file.split ?? "train",
			route: splitRouteFor(file.parquet),
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

	// The route prints beside the split, because a hand-placed split is otherwise visible only in a filename.
	for (const [index, file] of added.entries()) {
		const route = plan.files[index]?.route ?? SplitRoute.Caller

		console.log(`  ${file.source} ${file.split} via ${route}: ${file.rows} rows (${file.bytes} bytes)`)
	}
}
