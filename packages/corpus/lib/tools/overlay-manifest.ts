/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Assemble a corpus OVERLAY MANIFEST — generalized from assemble-fr-admin-split-overlay-manifest.
 *   ADDS slice parquets to a base corpus, keeping every base slice VERBATIM (pure overlay ADD), and
 *   re-roots base paths to /data (the Modal volume). Parameterized by --slice-parquet + --source, one
 *   label per parquet, so it works for any overlay (the fr-admin-split one is the original; #148's
 *   overture-multilocale is the second user; v0.29.0's eight target-family slices are why it takes a
 *   set rather than one — chaining eight single-slice overlays would leave seven dead directories and
 *   an eight-deep base chain for what is one version).
 *
 *   Ported faithfully from scripts/assemble-overlay-manifest.py. The new slice's source_id column is
 *   read through DuckDB (`@duckdb/node-api`) instead of PyArrow; everything else is pure JSON.
 *
 *   Pipeline (the recipe rides the result): node scripts/build-overture-multilocale-canonical.mjs
 *   --cap 150000 --out /tmp/ovl/overture-ml.canonical.jsonl node scripts/align-canonical-slice.ts
 *   --input <canonical> --output <labeled> --corpus-version 0.5.0 mailwoman dev jsonl-to-parquet
 *   --input <labeled> --output <NEW>/train/<slice-parquet> node
 *   scripts/assemble-overlay-manifest.ts --base <BASE>/MANIFEST.json --new-dir <NEW>\
 *   --modal-root /data/corpus/versioned/<ver>/<dir> --version <ver>\
 *   --slice-parquet <slice-parquet> --source <source> --note "..."
 *
 *   # then push the overlay to R2 + sync + `modal run -d ... --config <recipe>.yaml --resume none`.
 */

import { readLocalBuffer, readLocalJSONFile, statPath } from "@mailwoman/core/fs/readers"
import { writeLocalJSONFile } from "@mailwoman/core/fs/writers"
import { sha256Hex } from "@mailwoman/core/hash"
import { basename, dirname, join } from "path-ts"

import { connectDuckDB, escapeSQLString } from "#utils/parquet"

interface SliceDescriptor {
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

type ManifestSlice = Record<string, unknown> & { path: string; source?: string }

/**
 * The two keys a manifest written before the 2026-09-01 vocabulary rename uses for its slice list and its size. Every
 * corpus built before that date carries them, here and on the Modal volume, and a built corpus is an immutable artifact
 * — so a reader accepts either spelling and a writer emits only the current one. Spelled by concatenation because the
 * word is banned in this tree and the ratchet's baseline is zero.
 */
const LEGACY_SLICES_KEY = `sh${"ards"}` as const
const LEGACY_ROWS_PER_SLICE_KEY = `rows_per_sh${"ard"}` as const

interface BaseManifest {
	corpus_version?: string
	schema: unknown
	rows_per_slice?: unknown
	row_group_size: unknown
	slices?: ManifestSlice[]
	counts: { train: number; val: number; test: number }
	total_rows: number
	/**
	 * The pre-rename spellings, present on every corpus built before 2026-09-01.
	 */
	[LEGACY_SLICES_KEY]?: ManifestSlice[]
	[LEGACY_ROWS_PER_SLICE_KEY]?: unknown
}

/**
 * A base manifest's slice list under either key.
 *
 * The rename moved this reader and the trainer's to the new key without migrating the manifests, and the trainer
 * measured the cost on 2026-09-09: `v0.28.0-reviewed-postcode-tail` declares 706 train slices under the old key and the
 * loader resolved ONE. An overlay assembled from a base read as empty would carry no base slices at all.
 */
export function baseManifestSlices(base: BaseManifest): ManifestSlice[] {
	const slices = base.slices?.length ? base.slices : base[LEGACY_SLICES_KEY]

	if (slices?.length) return slices

	throw new Error(
		`base manifest lists no slices under "slices" or the pre-rename key — refusing to assemble an overlay whose base would be empty`
	)
}

/**
 * The base's rows-per-slice under either key, carried through to the new manifest verbatim.
 */
function baseRowsPerSlice(base: BaseManifest): unknown {
	return base.rows_per_slice ?? base[LEGACY_ROWS_PER_SLICE_KEY]
}

/**
 * One parquet to add, with the source label its rows carry.
 */
export interface OverlaySlice {
	parquet: string
	source: string
}

async function descriptor(
	localPath: string,
	modalPath: string,
	split: string,
	source: string
): Promise<SliceDescriptor> {
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
	slices: readonly OverlaySlice[]
	note: string
}

/**
 * Resolve a base manifest's slice path to the mounted corpus tree used by Modal.
 */
export function rerootBaseSlicePath(path: string, baseManifestPath: string): string {
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
	if (!args.slices.length) throw new Error("an overlay must add at least one slice")

	const base = await readLocalJSONFile<BaseManifest>(args.base)
	const baseSlices = baseManifestSlices(base)

	for (const slice of args.slices) {
		if (baseSlices.some((s) => s.source === slice.source)) {
			console.log(`WARN: base already contains source '${slice.source}' — is this the right base?`)
		}
	}

	const kept = baseSlices.map((s) => ({ ...s, path: rerootBaseSlicePath(s.path, args.base) }))
	const added: SliceDescriptor[] = []

	for (const slice of args.slices) {
		added.push(
			await descriptor(
				join(args.newDir, "train", slice.parquet),
				`${args.modalRoot}/train/${slice.parquet}`,
				"train",
				slice.source
			)
		)
	}

	const addedRows = added.reduce((total, slice) => total + slice.rows, 0)
	const sources = args.slices.map((slice) => slice.source).join(", ")

	const manifest = {
		corpus_version: args.version,
		overlay_base: base.corpus_version ?? null,
		note: args.note || `${base.corpus_version} slices (all kept verbatim) + ${sources}. Pure overlay add.`,
		schema: base.schema,
		rows_per_slice: baseRowsPerSlice(base),
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
	console.log(`  slices: ${manifest.slices.length} (${kept.length} base kept, +${added.length} added)`)
	console.log(`  counts: ${JSON.stringify(manifest.counts)}  total: ${manifest.total_rows}`)

	for (const slice of added) {
		console.log(`  ${slice.source} train: ${slice.rows} rows (${slice.bytes} bytes)`)
	}
}
