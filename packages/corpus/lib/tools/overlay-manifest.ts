/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Assemble a corpus OVERLAY MANIFEST — generalized from assemble-fr-admin-split-overlay-manifest.
 *   ADDS one slice parquet to a base corpus, keeping every base slice VERBATIM (pure overlay ADD),
 *   and re-roots base paths to /data (the Modal volume). Parameterized by --slice-parquet +
 *   --source so it works for any overlay slice (the fr-admin-split one is the original; #148's
 *   overture-multilocale is the second user).
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
import { sha256Hex } from "@mailwoman/core/utils"
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

interface BaseManifest {
	corpus_version?: string
	schema: unknown
	rows_per_slice: unknown
	row_group_size: unknown
	slices: Array<Record<string, unknown> & { path: string; source?: string }>
	counts: { train: number; val: number; test: number }
	total_rows: number
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
	sliceParquet: string
	source: string
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
	const base = await readLocalJSONFile<BaseManifest>(args.base)

	if (base.slices.some((s) => s.source === args.source)) {
		console.log(`WARN: base already contains source '${args.source}' — is this the right base?`)
	}

	const kept = base.slices.map((s) => ({ ...s, path: rerootBaseSlicePath(s.path, args.base) }))

	const newTrain = await descriptor(
		join(args.newDir, "train", args.sliceParquet),
		`${args.modalRoot}/train/${args.sliceParquet}`,
		"train",
		args.source
	)

	const manifest = {
		corpus_version: args.version,
		overlay_base: base.corpus_version ?? null,
		note:
			args.note || `${base.corpus_version} slices (all kept verbatim) + the ${args.source} slice. Pure overlay add.`,
		schema: base.schema,
		rows_per_slice: base.rows_per_slice,
		row_group_size: base.row_group_size,
		slices: [...kept, newTrain],
		counts: {
			train: base.counts.train + newTrain.rows,
			val: base.counts.val,
			test: base.counts.test,
		},
		total_rows: base.total_rows + newTrain.rows,
	}

	const out = join(args.newDir, "MANIFEST.json")
	await writeLocalJSONFile(manifest, out)

	console.log(`wrote ${out}`)
	console.log(`  slices: ${manifest.slices.length} (${kept.length} base kept, +1 ${args.source})`)
	console.log(`  counts: ${JSON.stringify(manifest.counts)}  total: ${manifest.total_rows}`)
	console.log(`  ${args.source} train: ${newTrain.rows} rows (${newTrain.bytes} bytes)`)
}
