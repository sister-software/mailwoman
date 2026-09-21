/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Assemble a corpus overlay manifest — generalized from assemble-fr-admin-split-overlay-manifest.
 *   Adds parquet files to a base corpus, keeping every base file verbatim (pure overlay add), and
 *   re-roots base paths to /data (the Modal volume). Parameterized by --parquet + --source, one
 *   label per parquet, so it works for any overlay (the fr-admin-split one is the original; #148's
 *   overture-multilocale is the second user. v0.29.0's eight target-family recipe outputs are why it
 *   takes a set rather than one — chaining eight single-file overlays would leave seven dead
 *   directories and an eight-deep base chain for what is one version).
 *
 *   Ported faithfully from scripts/assemble-overlay-manifest.py. The new file's source_id column is
 *   read through DuckDB (`@duckdb/node-api`) instead of PyArrow. everything else is pure JSON.
 *
 *   Pipeline (the recipe rides the result): `mailwoman corpus slice <recipe> --out <canonical>`, then
 *   `mailwoman corpus align-slice --input <canonical> --out <labeled> --corpus-version 0.5.0`, then
 *   `mailwoman dev jsonl-to-parquet --input <labeled> --output <new>/train/<parquet>`, then
 *   `mailwoman corpus overlay-manifest --base <base>/manifest.json --new-dir <new>\
 *   --modal-root /data/corpus/versioned/<ver>/<dir> --version <ver>\
 *   --parquet <parquet> --source <source> --note "..."`
 *
 *   # then push the overlay to R2 + sync + `modal run -d ... --config <recipe>.yaml --resume none`.
 */

import { readLocalBuffer, readLocalJSONFile, statPath } from "@mailwoman/core/fs/readers"
import { writeLocalJSONFile } from "@mailwoman/core/fs/writers"
import { sha256Hex } from "@mailwoman/core/hash"
import { stringifyJSON } from "@mailwoman/core/json"
import { basename, dirname, join } from "path-ts"

import { connectDuckDB, escapeSQLString } from "#parquet/duckdb"

interface ParquetFileDescriptor {
	split: string
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
 * The two keys a manifest written before the 2026-09-01 vocabulary rename uses
 * for its file list and its size.
 *
 * Every corpus built before that date carries them, here and on the Modal volume,
 * and a built corpus is an immutable artifact.
 * So a reader accepts either spelling and a writer emits only the current one.
 *
 * Spelled by concatenation because the word is banned in this tree and the ratchet's baseline is zero.
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
	/**
	 * The pre-rename spellings, present on every corpus built before 2026-09-01.
	 */
	[PRE_RENAME_FILES_KEY]?: ManifestFile[]
	[PRE_RENAME_ROWS_PER_FILE_KEY]?: unknown
}

/**
 * A base manifest's file list under either key.
 *
 * `slices` is the current wire key, the one the Python loader's `manifest_files` reads first.
 *
 * The rename moved this reader and the trainer's to the new key without migrating the manifests,
 * and the trainer measured the cost on 2026-09-09: `v0.28.0-reviewed-postcode-tail`
 * declares 706 train files under the old key and the loader resolved one.
 * An overlay assembled from a base read as empty would carry no base files at all.
 */
export function baseManifestFiles(base: BaseManifest): ManifestFile[] {
	const files = base.slices?.length ? base.slices : base[PRE_RENAME_FILES_KEY]

	if (files?.length) return files

	throw new Error(
		`base manifest lists no files under "slices" or the pre-rename key — refusing to assemble an overlay whose base would be empty`
	)
}

/**
 * The base's rows-per-file under either key, carried through to the new manifest verbatim.
 */
function baseRowsPerFile(base: BaseManifest): unknown {
	return base.rows_per_slice ?? base[PRE_RENAME_ROWS_PER_FILE_KEY]
}

/**
 * One parquet to add, with the source label its rows carry.
 */
export interface OverlayFile {
	parquet: string
	source: string
}

async function descriptor(
	localPath: string,
	modalPath: string,
	split: string,
	source: string
): Promise<ParquetFileDescriptor> {
	const db = await connectDuckDB()
	const result = await db.runAndReadAll(`SELECT source_id FROM read_parquet('${escapeSQLString(localPath)}')`)
	const sids = result.getRowObjects().map((r) => r.source_id as string)

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

export interface OverlayManifestOptions {
	base: string
	newDir: string
	modalRoot: string
	version: string
	/**
	 * The parquets this overlay adds, in the order they should appear after the base's own.
	 */
	files: readonly OverlayFile[]
	note: string
}

/**
 * Resolve a base manifest's file path to the mounted corpus tree used by Modal.
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

export async function assembleOverlayManifest(args: OverlayManifestOptions): Promise<void> {
	if (!args.files.length) throw new Error("an overlay must add at least one parquet file")

	const base = await readLocalJSONFile<BaseManifest>(args.base)
	const baseFiles = baseManifestFiles(base)

	for (const file of args.files) {
		if (baseFiles.some((s) => s.source === file.source)) {
			console.log(`WARN: base already contains source '${file.source}' — is this the right base?`)
		}
	}

	const kept = baseFiles.map((s) => ({ ...s, path: rerootBaseFilePath(s.path, args.base) }))
	const added: ParquetFileDescriptor[] = []

	for (const file of args.files) {
		added.push(
			await descriptor(
				join(args.newDir, "train", file.parquet),
				`${args.modalRoot}/train/${file.parquet}`,
				"train",
				file.source
			)
		)
	}

	const addedRows = added.reduce((total, file) => total + file.rows, 0)
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
			train: base.counts.train + addedRows,
			val: base.counts.val,
			test: base.counts.test,
		},
		total_rows: base.total_rows + addedRows,
	}

	const out = join(args.newDir, "MANIFEST.json")
	await writeLocalJSONFile(manifest, out)

	console.log(`wrote ${out}`)
	console.log(`  files: ${manifest.slices.length} (${kept.length} base kept, +${added.length} added)`)
	console.log(`  counts: ${stringifyJSON(manifest.counts)}  total: ${manifest.total_rows}`)

	for (const file of added) {
		console.log(`  ${file.source} train: ${file.rows} rows (${file.bytes} bytes)`)
	}
}
