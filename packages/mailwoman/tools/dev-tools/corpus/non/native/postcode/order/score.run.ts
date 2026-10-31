/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 * Scores the held-out non-native postcode-order set that `non-native-postcode-order-eval.run.ts` writes.
 *
 * Usage:
 *
 * ```sh
 * node packages/mailwoman/tools/dev-tools/corpus/non/native/postcode/order/score.run.ts \
 *   --golden <golden.jsonl> [--weights-cache <package-shaped weights root>]
 * ```
 *
 * Each row is parsed on the geocode path. The tool prints postcode-span, locality-span and full-component
 * exact match per country and overall, with denominators, and writes the receipt to
 * `<golden>.score.json`, or to `<golden>.<weights-cache basename>.score.json` when a cache is graded.
 */

import { readLocalBuffer } from "@mailwoman/core/fs/readers"
import { writeLocalJSONFile } from "@mailwoman/core/fs/writers"
import { md5Hex } from "@mailwoman/core/hash"
import { parseArguments } from "@mailwoman/core/scripting/arguments"
import { basename, dirname, resolvePath } from "path-ts"
import { JSONSpliterator } from "spliterator"

import {
	type MatchRate,
	parsePostcodeOrderRows,
	type PostcodeOrderGoldenRow,
	type PostcodeOrderScore,
	scoreNonNativeOrderRows,
} from "#tools/eval-harness/heldout/postcode-order"

const { values } = parseArguments({
	options: {
		golden: { type: "string", description: "The golden JSONL the non-native postcode-order sweep wrote" },
		"weights-cache": {
			type: "string",
			description: "A package-shaped weights root (a weights cache or a staged candidate); absent, the shipped weights",
		},
	},
})

if (!values.golden) {
	throw new Error("--golden is required")
}

const goldenPath = resolvePath(values.golden)
const rows = await JSONSpliterator.fromAsync<PostcodeOrderGoldenRow>(goldenPath).toArray()

if (!rows.length) {
	throw new Error(`${goldenPath} holds no rows. Refusing to write a receipt for an empty set.`)
}

console.error(`${rows.length} golden rows from ${goldenPath}`)

const started = performance.now()

const { predictions, modelPath } = await parsePostcodeOrderRows(
	rows,
	values["weights-cache"] ? { weightsCache: values["weights-cache"] } : {}
)

const report = scoreNonNativeOrderRows(rows, predictions)

const percent = (rate: MatchRate) => `${(100 * rate.rate).toFixed(1)}% (${rate.matched}/${rate.of})`

const line = (label: string, score: PostcodeOrderScore) =>
	[label, score.rows, percent(score.postcode), percent(score.locality), percent(score.full)].join("\t")

console.log(["country", "rows", "postcode", "locality", "full"].join("\t"))

for (const [country, score] of Object.entries(report.byCountry)) {
	console.log(line(country, score))
}

console.log(line("overall", report.overall))

const stem = basename(goldenPath.toString(), ".jsonl")
const arm = values["weights-cache"] ? `.${basename(resolvePath(values["weights-cache"]).toString())}` : ""
const receiptPath = resolvePath(dirname(goldenPath.toString()), `${stem}${arm}.score.json`)

await writeLocalJSONFile(
	{
		golden: goldenPath.toString(),
		goldenMD5: md5Hex(await readLocalBuffer(goldenPath)),
		weightsCache: values["weights-cache"] ? resolvePath(values["weights-cache"]).toString() : null,
		modelPath,
		modelMD5: modelPath ? md5Hex(await readLocalBuffer(modelPath)) : null,
		parsePath: "parseForGeocode (geocodeParseInputs) with the geocode session's default priors",
		seconds: (performance.now() - started) / 1000,
		...report,
	},
	receiptPath
)

console.error(`Wrote ${receiptPath}`)
