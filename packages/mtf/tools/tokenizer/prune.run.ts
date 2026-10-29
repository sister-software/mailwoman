/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Prune a tokenizer's unused pieces and the int8 model's matching embedding rows.
 *
 *   `--train-counts` is the per-piece count `utilization.run.ts` writes; `--eval-fired` is a JSON file whose
 *   `fired_ids` lists the pieces the evaluation surface uses. The tool writes `tokenizer.model`, `model.onnx`,
 *   `id-map.json` and `prune-report.json` under `--out-dir`. `verify.run.ts prune` then checks the result.
 *
 *   Usage: `node packages/mtf/tools/tokenizer/prune.run.ts --tokenizer <model> --onnx <int8 onnx>
 *   --train-counts <json> --eval-fired <json> --out-dir <dir>`
 */

import { parseArguments, requiredArgument } from "@mailwoman/core/scripting/arguments"
import { resolvePath } from "path-ts"

import { prunePieces } from "./prune.ts"

const { values } = parseArguments({
	options: {
		tokenizer: { type: "string" },
		onnx: { type: "string" },
		"train-counts": { type: "string" },
		"eval-fired": { type: "string" },
		"out-dir": { type: "string" },
	},
})

await prunePieces({
	tokenizer: resolvePath(requiredArgument("prune", "tokenizer", values.tokenizer)),
	onnx: resolvePath(requiredArgument("prune", "onnx", values.onnx)),
	trainCounts: resolvePath(requiredArgument("prune", "train-counts", values["train-counts"])),
	evalFired: resolvePath(requiredArgument("prune", "eval-fired", values["eval-fired"])),
	outDirectory: resolvePath(requiredArgument("prune", "out-dir", values["out-dir"])),
})
