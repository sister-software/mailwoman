/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Writes the CJK-script rows of non-CJK countries as a versioned CJK corpus.
 *
 *   Usage:
 *     node packages/corpus/lib/tools/cjk-foreign-places.run.ts \
 *       --parquet <corpus dir>/wof-admin.parquet --split-attribute <corpus dir>/wof-admin.split.<hash>.json \
 *       --out-dir $MAILWOMAN_DATA_ROOT/corpus/versioned/v8-cjk-foreign-places-<date> [--force]
 */

import { orderedJSON } from "@mailwoman/core/json"
import { parseArguments, requiredArgument } from "@mailwoman/core/scripting/arguments"

import { buildForeignPlaces } from "#cjk/foreign-places"

const { values } = parseArguments({
	options: {
		parquet: { type: "string" },
		"split-attribute": { type: "string" },
		"out-dir": { type: "string" },
		force: { type: "boolean", default: false },
	},
})

const command = "cjk-foreign-places"

const report = await buildForeignPlaces({
	parquet: requiredArgument(command, "--parquet", values.parquet),
	splitAttribute: requiredArgument(command, "--split-attribute", values["split-attribute"]),
	outDir: requiredArgument(command, "--out-dir", values["out-dir"]),
	force: values.force,
})

console.log(orderedJSON(report, { indent: "\t" }))
