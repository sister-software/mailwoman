// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   Assemble a corpus overlay whose `wof-admin` files store a `draw_weight` column
 *   from the admin gazetteer's place ranking (#3541).
 *
 *   Each `wof-admin` row stores its WOF record's id inside its `source_id` (`wof-admin-<id>-…`).
 *   The row's raw weight is that record's `place_importance.importance`, raised to `--floor`,
 *   and a record without an importance row takes the floor.
 *
 *   The default floor is the referential score of a place of 1,000 people, `log2(2) / 14`,
 *   so an unscored place weighs as a village does and no scored place weighs less.
 *   The weights are divided by their mean over the source's train rows, so the source's
 *   mean draw weight is 1 and its share of the run is unchanged.
 *
 *   The overlay keeps every other base file, drops the base's `wof-admin` files and adds
 *   the rewritten ones, each with the base file's split attribute re-addressed to it.
 *   `DRAW_WEIGHTS.json` beside the manifest records the weights' inputs and distribution.
 *
 *   Usage:
 *   node packages/mailwoman/tools/dev-tools/corpus/draw-weight-overlay.run.ts \
 *     --base <base corpus directory>/MANIFEST.json \
 *     --importance-db /mnt/mw/db/wof/admin-global-priority-importance-<md5>.db \
 *     --out <data root>/corpus/versioned/<version>/corpus-<version> --version <version without v>
 */

import { readLocalJSONFile } from "@mailwoman/core/fs/readers"
import { writeLocalJSONFile } from "@mailwoman/core/fs/writers"
import { referentialFromPopulation } from "@mailwoman/core/resolver"
import { parseArguments } from "@mailwoman/core/scripting/arguments"
import { stringifyJSON } from "@mailwoman/core/values/json"
import { writeDrawWeightedFiles } from "@mailwoman/corpus/tools/overlay/draw-weight"
import {
	assembleOverlayManifest,
	baseManifestFiles,
	localManifestFilePath,
} from "@mailwoman/corpus/tools/overlay/manifest"
import { readImportanceSource } from "@mailwoman/resolver-wof-sqlite/schema/importance-source"
import type { PlaceImportanceDatabase } from "@mailwoman/resolver-wof-sqlite/schema/place-importance"
import { DatabaseClient } from "@mailwoman/sqlite/client"
import { basename, dirname, PathBuilder } from "path-ts"

const SOURCE = "wof-admin"

const { values } = parseArguments({
	options: {
		base: { type: "string", description: "The base corpus's inner MANIFEST.json" },
		"importance-db": { type: "string", description: "The importance build of the admin gazetteer" },
		out: { type: "string", description: "The new corpus directory, corpus-<version>" },
		version: { type: "string", description: "The new corpus version, without a `v` prefix" },
		floor: { type: "string", description: "The least raw weight. Defaults to the referential score of 1,000 people" },
	},
})

if (!values.base || !values["importance-db"] || !values.out || !values.version) {
	throw new Error("--base, --importance-db, --out and --version are required")
}

const floor = values.floor ? Number(values.floor) : referentialFromPopulation(1000)
const stamp = await readImportanceSource(values["importance-db"])

if (!stamp) throw new Error(`${values["importance-db"]} records no importance_source, so its admin database is unknown`)

const scores = new Map<number, number>()

{
	using db = new DatabaseClient<PlaceImportanceDatabase>(values["importance-db"], { readOnly: true })

	for (const row of await db.selectFrom("place_importance").select(["id", "importance"]).execute()) {
		scores.set(Number(row.id), row.importance)
	}
}

console.log(`${scores.size.toLocaleString()} scored places from ${values["importance-db"]} (admin md5 ${stamp.md5})`)

const base = await readLocalJSONFile<object>(values.base)

const files = baseManifestFiles<{ path: string; source?: string; split_attribute?: { path: string } }>(base)
	.filter((file) => file.source === SOURCE)
	.map((file) => {
		if (!file.split_attribute) throw new Error(`${file.path} records no split attribute to carry`)

		return {
			parquet: localManifestFilePath(file.path),
			splitAttribute: localManifestFilePath(file.split_attribute.path),
		}
	})

if (!files.length) throw new Error(`${values.base} lists no ${SOURCE} file`)

const outDir = PathBuilder.from(values.out)

const summary = await writeDrawWeightedFiles({
	source: SOURCE,
	files,
	keyPattern: `^${SOURCE}-(\\d+)-`,
	scores,
	floor,
	outDir,
})

const modalRoot = `/data/corpus/versioned/${basename(dirname(values.out))}/${basename(values.out)}`
const share = (n: number) => `${((100 * n) / summary.trainRows).toFixed(1)}%`

await assembleOverlayManifest({
	base: values.base,
	newDir: outDir,
	modalRoot,
	version: values.version,
	files: summary.files.map((file) => ({ parquet: file.parquet, source: SOURCE, splitAttribute: file.splitAttribute })),
	replaceSources: [SOURCE],
	note:
		`${basename(dirname(dirname(values.base)))} with its ${files.length} ${SOURCE} files rewritten with a draw_weight ` +
		`column (#3541): max(place_importance.importance, ${floor.toFixed(6)}) over ${basename(values["importance-db"])}, ` +
		`unscored places at the floor, divided by the mean over the ${summary.trainRows.toLocaleString()} train rows ` +
		`(${share(summary.floorTrainRows)} at the floor, weight ${summary.floorWeight.toFixed(4)}; ` +
		`largest weight ${summary.maxWeight.toFixed(4)}). Rows, order and split attributes are the base files'.`,
})

await writeLocalJSONFile(
	{
		source: SOURCE,
		importanceDatabase: values["importance-db"],
		importanceSource: stamp,
		scoredPlaces: scores.size,
		...summary,
	},
	outDir("DRAW_WEIGHTS.json")
)

console.log(
	`${SOURCE}: ${summary.trainRows.toLocaleString()} train rows, ${share(summary.scoredTrainRows)} scored, ` +
		`${share(summary.floorTrainRows)} at the floor ${floor} (weight ${summary.floorWeight.toFixed(4)}), ` +
		`largest weight ${summary.maxWeight.toFixed(4)}`
)
console.log(`quantiles over train rows: ${stringifyJSON(summary.quantiles)}`)
