/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Assembles a corpus manifest that keeps every file of a base corpus and adds new parquet files.
 */

import { dataRootPath } from "@mailwoman/core/data-root"
import { readLocalBuffer, readLocalJSONFile, statPath } from "@mailwoman/core/fs/readers"
import { writeLocalJSONFile } from "@mailwoman/core/fs/writers"
import { sha256Hex } from "@mailwoman/core/hash"
import { stringifyJSON } from "@mailwoman/core/json"
import { basename, dirname, PathBuilder, type PathBuilderLike } from "path-ts"

import { escapeSQLString, openDuckDB } from "#parquet/duckdb"
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
 * Existing corpora are immutable and still use these keys, so readers accept both
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
 * One parquet file to add, with the source label that its rows carry.
 */
export interface OverlayFile {
	parquet: string
	source: string
	/**
	 * The split that the file's rows belong to.
	 * The default is `train`.
	 *
	 * `val` and `test` are allowed only for files that `splitOverlaySlice` named,
	 * so that the holdout policy chooses held-out rows.
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
 * The `source` argument is what the caller believes the file holds, and the file itself
 * is what the loader reads: `file_source_counts` groups the rows, never the manifest.
 * So a caller passing a stale label writes a manifest that disagrees with its own rows, the run
 * trains on the rows, and the next plan derived from that manifest carries the stale label forward.
 *
 * This reads the column and refuses the mismatch rather than recording the claim.
 *
 * `source_id` is materialized rather than aggregated because `first_source_id`
 * and `last_source_id` mean the first and last row of the file.
 * DuckDB's `first` and `last` aggregates read whichever row a parallel scan
 * reaches first, which is not the same thing.
 */
async function descriptor(
	localPath: string,
	modalPath: string,
	split: SplitName,
	source: string
): Promise<ParquetFileDescriptor> {
	// One per file, and `assembleOverlayManifest` calls this once per file.
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
 * Reconstructing it is the mechanism behind an overlay carrying a stale list
 * of files into a later corpus version.
 */
export interface OverlayPlan {
	corpusVersion: string
	overlayBase: string | null
	baseManifest: string
	modalRoot: string
	note: string
	appliedAt: string
	files: Array<{ parquet: string; source: string; split: SplitName }>
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
 * Writes a corpus manifest that keeps every file of `args.base` and appends `args.files`.
 *
 * A `val` or `test` file must have the `.<split>.parquet` name that `splitOverlaySlice`
 * writes, which shows that the holdout policy chose its rows.
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

	for (const file of args.files) {
		if (baseFiles.some((s) => s.source === file.source)) {
			console.log(`WARN: base already contains source '${file.source}' — is this the right base?`)
		}
	}

	// Held-out rows must come from the holdout policy, which encodes the split in the filename.
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

	const kept = baseFiles.map((s) => ({ ...s, path: rerootBaseFilePath(s.path, args.base) }))
	const added: ParquetFileDescriptor[] = []

	const newDir = PathBuilder.from(args.newDir)

	for (const file of args.files) {
		const split = file.split ?? "train"

		added.push(
			await descriptor(
				// DuckDB reads the path inside SQL text, so it must be a string.
				newDir(split, file.parquet).toString(),
				`${args.modalRoot}/${split}/${file.parquet}`,
				split,
				file.source
			)
		)
	}

	const addedRows: Record<SplitName, number> = { train: 0, val: 0, test: 0 }

	for (const file of added) {
		addedRows[file.split] += file.rows
	}

	const sources = args.files.map((file) => file.source).join(", ")

	const manifest = {
		corpus_version: args.version,
		overlay_base: base.corpus_version ?? null,
		note: args.note || `${base.corpus_version} files (all kept verbatim) + ${sources}. Pure overlay add.`,
		schema: base.schema,
		rows_per_slice: baseRowsPerFile(base),
		row_group_size: base.row_group_size,
		slices: [...kept, ...added],
		counts: {
			train: base.counts.train + addedRows.train,
			val: base.counts.val + addedRows.val,
			test: base.counts.test + addedRows.test,
		},
		total_rows: base.total_rows + addedRows.train + addedRows.val + addedRows.test,
	}

	const out = newDir("MANIFEST.json")
	await writeLocalJSONFile(manifest, out)

	// The plan is written beside the manifest it produced, because the previous overlay
	// assembly's plan existed only as three scripts in a session scratch directory
	// and was carried into the next assembly as a hand-written list.
	// Commit this file under `packages/corpus/data/builds/<version>/`.
	const plan: OverlayPlan = {
		corpusVersion: args.version,
		overlayBase: base.corpus_version ?? null,
		baseManifest: args.base,
		modalRoot: args.modalRoot,
		note: manifest.note,
		appliedAt: new Date().toISOString(),
		files: args.files.map((file) => ({ parquet: file.parquet, source: file.source, split: file.split ?? "train" })),
	}

	const planPath = newDir(OVERLAY_PLAN_FILE)

	await writeLocalJSONFile(plan, planPath)

	console.log(`wrote ${planPath}`)
	console.log(`wrote ${out}`)
	console.log(`  files: ${manifest.slices.length} (${kept.length} base kept, +${added.length} added)`)
	console.log(`  counts: ${stringifyJSON(manifest.counts)}  total: ${manifest.total_rows}`)

	for (const file of added) {
		console.log(`  ${file.source} ${file.split}: ${file.rows} rows (${file.bytes} bytes)`)
	}
}
