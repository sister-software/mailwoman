/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Check a tokenizer.
 *
 *   `byte-fallback` encodes a held-out fixture (JSONL with `raw`, `text` or `input`, or plain text) and prints the
 *   byte-fallback rate overall and per script.
 *
 *   `prune` runs the two release checks of a pruned tokenizer and model, segmentation identity (B1) and bit-equal
 *   logits (B2), writes `verify-report.json` into the pruned directory, and exits non-zero unless both pass.
 *
 *   Usage:
 *
 *     node packages/mtf/tools/tokenizer/verify.run.ts byte-fallback --tokenizer <model> --fixture <jsonl>
 *     node packages/mtf/tools/tokenizer/verify.run.ts prune --orig-tokenizer <model> --orig-onnx <onnx>
 *       --pruned-dir <dir> --manifest <MANIFEST.json> --eval-texts <json> [--sample-rows 1000000]
 *       [--logit-inputs 256] [--seed 42] [--data-root-remap <from>:<to>]
 */

import { dataRootPath } from "@mailwoman/core/data-root"
import { prettyJSON } from "@mailwoman/core/json"
import { parseArguments, requiredArgument } from "@mailwoman/core/scripting/arguments"
import { resolvePath } from "path-ts"

import { measureByteFallback, readFixtureLines } from "./byte-fallback.ts"
import { verifyPrune } from "./verify.ts"

const { values, positionals } = parseArguments({
	allowPositionals: true,
	options: {
		tokenizer: { type: "string" },
		fixture: { type: "string" },
		"orig-tokenizer": { type: "string" },
		"orig-onnx": { type: "string" },
		"pruned-dir": { type: "string" },
		manifest: { type: "string" },
		"eval-texts": { type: "string" },
		"sample-rows": { type: "string", default: "1000000" },
		"logit-inputs": { type: "string", default: "256" },
		seed: { type: "string", default: "42" },
		"data-root-remap": { type: "string" },
	},
})

const command = positionals[0]

if (command === "byte-fallback") {
	const tokenizer = resolvePath(requiredArgument(command, "tokenizer", values.tokenizer))
	const fixture = resolvePath(requiredArgument(command, "fixture", values.fixture))

	console.log(prettyJSON(await measureByteFallback(tokenizer, await readFixtureLines(fixture)), false, 2))
} else if (command === "prune") {
	const remap = values["data-root-remap"] ?? `/data:${dataRootPath()}`
	const at = remap.indexOf(":")

	const report = await verifyPrune({
		originalTokenizer: resolvePath(requiredArgument(command, "orig-tokenizer", values["orig-tokenizer"])),
		originalONNX: resolvePath(requiredArgument(command, "orig-onnx", values["orig-onnx"])),
		prunedDirectory: resolvePath(requiredArgument(command, "pruned-dir", values["pruned-dir"])),
		manifest: resolvePath(requiredArgument(command, "manifest", values.manifest)),
		evalTexts: resolvePath(requiredArgument(command, "eval-texts", values["eval-texts"])),
		sampleRows: Number(values["sample-rows"]),
		logitInputs: Number(values["logit-inputs"]),
		seed: Number(values.seed),
		remap: [remap.slice(0, at), remap.slice(at + 1)],
	})

	if (report.verdict !== "PASS") {
		process.exitCode = 1
	}
} else {
	console.error("usage: verify.run.ts byte-fallback|prune [options]")

	process.exitCode = 2
}
