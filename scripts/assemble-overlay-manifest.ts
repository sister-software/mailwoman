/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Assemble a corpus OVERLAY MANIFEST — generalized from assemble-fr-admin-split-overlay-manifest.
 *   ADDS one shard parquet to a base corpus, keeping every base shard VERBATIM (pure overlay ADD),
 *   and re-roots base paths to /data (the Modal volume). Parameterized by --shard-parquet +
 *   --source so it works for any overlay shard (the fr-admin-split one is the original; #148's
 *   overture-multilocale is the second user).
 *
 *   Ported faithfully from scripts/assemble-overlay-manifest.py. The new shard's source_id column is
 *   read through DuckDB (`@duckdb/node-api`) instead of PyArrow; everything else is pure JSON.
 *
 *   Pipeline (the recipe rides the result): node scripts/build-overture-multilocale-canonical.mjs
 *   --cap 150000 --out /tmp/ovl/overture-ml.canonical.jsonl node scripts/align-canonical-shard.ts
 *   --input <canonical> --output <labeled> --corpus-version 0.5.0 node scripts/jsonl-to-parquet.ts
 *   --input <labeled> --output <NEW>/train/<shard-parquet> node
 *   scripts/assemble-overlay-manifest.ts --base <BASE>/MANIFEST.json --new-dir <NEW>\
 *   --modal-root /data/corpus/versioned/<ver>/<dir> --version <ver>\
 *   --shard-parquet <shard-parquet> --source <source> --note "..."
 *
 *   # then push the overlay to R2 + sync + `modal run -d ... --config <recipe>.yaml --resume none`.
 */

import { DuckDBInstance } from "@duckdb/node-api"
import { createHash } from "node:crypto"
import { readFileSync, statSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { parseArgs } from "node:util"

interface ShardDescriptor {
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
	rows_per_shard: unknown
	row_group_size: unknown
	shards: Array<Record<string, unknown> & { path: string; source?: string }>
	counts: { train: number; val: number; test: number }
	total_rows: number
}

/** Escape a path for single-quoted SQL string literals. */
function sqlString(value: string): string {
	return value.replace(/'/g, "''")
}

async function descriptor(
	localPath: string,
	modalPath: string,
	split: string,
	source: string
): Promise<ShardDescriptor> {
	const instance = await DuckDBInstance.create()
	const db = await instance.connect()
	const result = await db.runAndReadAll(`SELECT source_id FROM read_parquet('${sqlString(localPath)}')`)
	const sids = result.getRowObjects().map((r) => r.source_id as string)

	return {
		split,
		path: modalPath,
		format: "parquet",
		compression: "SNAPPY",
		rows: sids.length,
		bytes: statSync(localPath).size,
		sha256: createHash("sha256").update(readFileSync(localPath)).digest("hex"),
		first_source_id: sids[0]!,
		last_source_id: sids[sids.length - 1]!,
		source,
	}
}

interface Args {
	base: string
	newDir: string
	modalRoot: string
	version: string
	shardParquet: string
	source: string
	note: string
}

function parseCliArgs(): Args {
	const { values } = parseArgs({
		options: {
			base: { type: "string" },
			"new-dir": { type: "string" },
			"modal-root": { type: "string" },
			version: { type: "string" },
			"shard-parquet": { type: "string" },
			source: { type: "string" },
			note: { type: "string", default: "" },
		},
	})

	const required = ["base", "new-dir", "modal-root", "version", "shard-parquet", "source"] as const
	const missing = required.filter((k) => !values[k])
	if (missing.length > 0) {
		throw new Error(
			`Usage: assemble-overlay-manifest.ts --base <MANIFEST.json> --new-dir <dir> --modal-root <path> ` +
				`--version <ver> --shard-parquet <file> --source <id> [--note "..."]\n` +
				`  missing: ${missing.map((k) => `--${k}`).join(", ")}`
		)
	}

	return {
		base: values.base!,
		newDir: values["new-dir"]!,
		modalRoot: values["modal-root"]!,
		version: values.version!,
		shardParquet: values["shard-parquet"]!,
		source: values.source!,
		note: values.note ?? "",
	}
}

async function main(): Promise<void> {
	const args = parseCliArgs()

	const base = JSON.parse(readFileSync(args.base, "utf8")) as BaseManifest

	if (base.shards.some((s) => s.source === args.source)) {
		console.log(`WARN: base already contains source '${args.source}' — is this the right base?`)
	}

	const reroot = (p: string): string => {
		const i = p.indexOf("/corpus/versioned/")
		return i >= 0 ? "/data" + p.slice(i) : p
	}

	const kept = base.shards.map((s) => ({ ...s, path: reroot(s.path) }))

	const newTrain = await descriptor(
		join(args.newDir, "train", args.shardParquet),
		`${args.modalRoot}/train/${args.shardParquet}`,
		"train",
		args.source
	)

	const manifest = {
		corpus_version: args.version,
		overlay_base: base.corpus_version ?? null,
		note:
			args.note || `${base.corpus_version} shards (all kept verbatim) + the ${args.source} shard. Pure overlay add.`,
		schema: base.schema,
		rows_per_shard: base.rows_per_shard,
		row_group_size: base.row_group_size,
		shards: [...kept, newTrain],
		counts: {
			train: base.counts.train + newTrain.rows,
			val: base.counts.val,
			test: base.counts.test,
		},
		total_rows: base.total_rows + newTrain.rows,
	}

	const out = join(args.newDir, "MANIFEST.json")
	writeFileSync(out, JSON.stringify(manifest, null, 1) + "\n")
	console.log(`wrote ${out}`)
	console.log(`  shards: ${manifest.shards.length} (${kept.length} base kept, +1 ${args.source})`)
	console.log(`  counts: ${JSON.stringify(manifest.counts)}  total: ${manifest.total_rows}`)
	console.log(`  ${args.source} train: ${newTrain.rows} rows (${newTrain.bytes} bytes)`)
}

if (import.meta.main) {
	main().catch((err: unknown) => {
		console.error(err instanceof Error ? err.message : err)
		process.exit(1)
	})
}
