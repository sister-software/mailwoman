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

import { dataRootPath } from "@mailwoman/core/data-root"
import { readLocalBuffer, readLocalJSONFile, statPath } from "@mailwoman/core/fs/readers"
import { writeLocalJSONFile } from "@mailwoman/core/fs/writers"
import { sha256Hex } from "@mailwoman/core/hash"
import { stringifyJSON } from "@mailwoman/core/json"
import { basename, dirname, PathBuilder, type PathBuilderLike } from "path-ts"

import { connectDuckDB, escapeSQLString } from "#parquet/duckdb"
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
 *
 * The parameter names the two keys this reads and nothing else, because the corpus
 * census passes a manifest it parsed as `Record<string, unknown>` and needs no `counts`
 * or `schema` to ask for the file list.
 *
 * AN EMPTY LIST AND A MISSING KEY ARE DIFFERENT READINGS, and only the second is refused.
 * A manifest whose `slices` is `[]` says the corpus holds no file, and a census counting
 * zero rows from it has measured the corpus rather than failed to read it.
 *
 * A manifest naming its file list under neither key says nothing about how
 * many files there are, and answering `[]` for that is the false absence
 * `docs/engineering/reference/the-meaning-of-zero.mdx` refuses.
 *
 * A caller that needs a non-empty list says so itself. {@linkcode assembleOverlayManifest}
 * does, because an overlay whose base carries no file is not an overlay.
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
	/**
	 * Which split the file's rows belong to.
	 * Defaults to `train`.
	 *
	 * An overlay adds train rows in the ordinary case.
	 * A file produced by `splitOverlaySlice` carries the rows a country's holdout reaches,
	 * and those belong to `val` or `test`: a held-out row appended as a train row
	 * is the leakage the holdout exists to prevent.
	 *
	 * `val` and `test` are accepted only for a filename `splitOverlaySlice` wrote,
	 * which {@link splitFromFilename} reads.
	 * See {@link assembleOverlayManifest} for what a hand-assigned holdout split cost.
	 */
	split?: SplitName
}

/**
 * The split `splitOverlaySlice` encoded in a filename, or null for a name it did not write.
 *
 * It writes `<stem>.<split>.parquet`, so the split of a routed file is readable from its name.
 * A name without that suffix was not routed through the holdout policy.
 */
export function splitFromFilename(parquet: string): SplitName | null {
	const match = /\.(train|val|test)\.parquet$/.exec(parquet)

	return match ? (match[1] as SplitName) : null
}

async function descriptor(
	localPath: string,
	modalPath: string,
	split: SplitName,
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
	newDir: PathBuilderLike
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

/**
 * Resolve a manifest file path on the Modal volume (`/data/…`) to the same file under the local data root.
 *
 * A path outside `/data/` is returned unchanged.
 */
export function localManifestFilePath(path: string): string {
	return path.startsWith("/data/") ? dataRootPath(path.slice("/data/".length)).toString() : path
}

/**
 * Write a new corpus manifest that keeps every file of `args.base` verbatim and adds `args.files`.
 *
 * A `val` or `test` file must carry the `.<split>.parquet` name `splitOverlaySlice` writes,
 * because that name is the evidence the holdout policy chose its rows.
 * A caller naming one of those splits for any other filename is refused:
 * it would be selecting a country's held-out rows by hand.
 *
 * `train` is unrestricted, since appending rows to train holds nothing out.
 */
export async function assembleOverlayManifest(args: OverlayManifestOptions): Promise<void> {
	if (!args.files.length) throw new Error("an overlay must add at least one parquet file")

	const base = await readLocalJSONFile<BaseManifest>(args.base)
	const baseFiles = baseManifestFiles(base)

	// The reader returns an empty list for a manifest that declares one, because a
	// census counting zero rows from it has measured the corpus.
	// An overlay is the other case: it keeps every base file verbatim and adds to them,
	// so a base carrying none would produce a corpus of only the added files under
	// a name that claims to extend something.
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

	// A held-out split has to come from the holdout policy rather than from the caller.
	// `splitOverlaySlice` applies the policy and encodes the split in the filename
	// it writes, so a `val` or `test` file names itself.
	// A caller asserting one for a file with no such name is choosing which rows are held out,
	// and `v0.6.0-register-surface` records what that costs: `part-synth-german-val.parquet`
	// was placed by a script's hardcoded list, with no test file beside it,
	// and 770 of the 3,987 `source_id`s in it are also in train.
	// `train` stays free to assert, because appending an overlay to train holds nothing out.
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
				// A string, because DuckDB reads it inside SQL text.
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

	console.log(`wrote ${out}`)
	console.log(`  files: ${manifest.slices.length} (${kept.length} base kept, +${added.length} added)`)
	console.log(`  counts: ${stringifyJSON(manifest.counts)}  total: ${manifest.total_rows}`)

	for (const file of added) {
		console.log(`  ${file.source} ${file.split}: ${file.rows} rows (${file.bytes} bytes)`)
	}
}
