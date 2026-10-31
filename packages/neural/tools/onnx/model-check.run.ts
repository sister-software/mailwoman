/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Runs recorded feeds through an ONNX graph and compares every output element with the outputs the model computed.
 *
 *   The Rust trainer's `trainer export-feeds` writes the feeds (one row each: the token ids, the mask, every channel
 *   and the locale hint) together with the outputs its forward pass computed for them. This tool runs each feed
 *   through the graph on the CPU provider with the runner's session options and reports the largest absolute
 *   difference per output against `--tolerance`. It is the export's check against the model that `verify_parity`
 *   runs against torch in the Python exporter.
 *
 *   Usage: `node packages/neural/tools/onnx/model-check.run.ts --model <model.onnx> --feeds <feeds.json>
 *   [--tolerance 1e-4] [--threads 4] [--out <receipt.json>]`
 */

import { readLocalJSONFile } from "@mailwoman/core/fs/readers"
import { writeLocalJSONFile } from "@mailwoman/core/fs/writers"
import { sha256File } from "@mailwoman/core/hash"
import { prettyJSON } from "@mailwoman/core/json"
import { parseArguments, requiredArgument } from "@mailwoman/core/scripting/arguments"
import * as ort from "onnxruntime-node"

const { values } = parseArguments({
	options: {
		model: { type: "string" },
		feeds: { type: "string" },
		tolerance: { type: "string", default: "1e-4" },
		threads: { type: "string", default: "4" },
		out: { type: "string" },
	},
})

const SCOPE = "onnx-model-check"
const modelPath = requiredArgument(SCOPE, "model", values.model)
const feedsPath = requiredArgument(SCOPE, "feeds", values.feeds)
const tolerance = Number(values.tolerance)
const threads = Number(values.threads)

if (!(tolerance > 0) || !(threads > 0)) throw new Error("--tolerance and --threads must be positive")

interface RecordedTensor {
	type: "int64" | "float32"
	dims: number[]
	data: number[]
}

interface Probe {
	feeds: Record<string, RecordedTensor>
	expected: Record<string, RecordedTensor>
}

interface FeedsFile {
	checkpoint: string
	probes: Probe[]
}

function tensor(recorded: RecordedTensor): ort.Tensor {
	if (recorded.type === "int64") {
		return new ort.Tensor(
			"int64",
			BigInt64Array.from(recorded.data, (v) => BigInt(v)),
			recorded.dims
		)
	}

	return new ort.Tensor("float32", Float32Array.from(recorded.data), recorded.dims)
}

const recorded = await readLocalJSONFile<FeedsFile>(feedsPath)

// A check over no probe would report every output within tolerance, so an empty feeds file is a failure.
if (!recorded.probes?.length)
	throw new Error(`${feedsPath} holds no probe, so the graph would be checked against nothing`)

const session = await ort.InferenceSession.create(modelPath, {
	executionProviders: ["cpu"],
	graphOptimizationLevel: "all",
	intraOpNumThreads: threads,
})

const worst: Record<string, { maxAbs: number; probe: number; element: number }> = {}
const missing = new Set<string>()

for (const [index, probe] of recorded.probes.entries()) {
	const feeds: Record<string, ort.Tensor> = {}

	for (const name of session.inputNames) {
		const value = probe.feeds[name]

		if (!value) throw new Error(`probe ${index} has no feed for graph input ${name}`)
		feeds[name] = tensor(value)
	}

	const outputs = await session.run(feeds)

	for (const [name, expected] of Object.entries(probe.expected)) {
		const actual = outputs[name]

		if (!actual) {
			missing.add(name)

			continue
		}

		const data = actual.data as Float32Array

		if (data.length !== expected.data.length) {
			throw new Error(`probe ${index} ${name}: ${data.length} elements against ${expected.data.length}`)
		}

		const entry = (worst[name] ??= { maxAbs: 0, probe: -1, element: -1 })

		for (let i = 0; i < data.length; i++) {
			const diff = Math.abs(data[i]! - expected.data[i]!)

			if (diff > entry.maxAbs || Number.isNaN(diff)) {
				entry.maxAbs = Number.isNaN(diff) ? Infinity : diff
				entry.probe = index
				entry.element = i
			}
		}
	}
}

const pass = missing.size === 0 && Object.values(worst).every((w) => w.maxAbs <= tolerance)

const receipt = {
	model: modelPath,
	modelSHA256: await sha256File(modelPath),
	feeds: feedsPath,
	checkpoint: recorded.checkpoint,
	probes: recorded.probes.length,
	inputs: session.inputNames,
	outputs: session.outputNames,
	tolerance,
	worst,
	missingOutputs: [...missing],
	pass,
}

process.stdout.write(prettyJSON(receipt))

if (values.out) {
	await writeLocalJSONFile(receipt, values.out)
}

if (!pass) {
	process.exitCode = 1
}
