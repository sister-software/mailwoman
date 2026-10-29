/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Compares two ONNX graphs of one model on feeds the Node runtime builds.
 *
 *   The tool loads the classifier from a weights overlay (`--weights-overlay <root>`, a directory holding
 *   `<locale>/model.onnx` beside its tokenizer, card and lexicons) and parses held-out rows with it. Every feed the
 *   runtime passes to `InferenceSession.run` is recorded, so each probe holds the token ids, the attention mask,
 *   the soft-feature channels and the locale hint that serving computes. Every other row is parsed with its own
 *   country as `localeHint`, so the hint input is exercised as well as its "no hint" id. The recorded feeds are then
 *   run through `--reference` and `--candidate` on the CPU provider with the runner's session options, and every
 *   element of every output is compared.
 *
 *   The receipt records the two graphs' declared interfaces, the largest absolute difference per output with the probe
 *   that produced it, and a verdict against `--tolerance`. Every tenth probe is also run trimmed to its real length to
 *   vary the dynamic `sequence` axis. The first two probes are run once stacked as a batch of two.
 *
 *   Usage: `node packages/neural/tools/onnx-export-parity.run.ts --weights-overlay <root> --reference <a.onnx>
 *   --candidate <b.onnx> --rows <heldout rows.jsonl> [--count 1000] [--tolerance 1e-4] [--threads 4] [--out <json>]`
 */

import { readLocalJSONFile } from "@mailwoman/core/fs/readers"
import { writeLocalJSONFile } from "@mailwoman/core/fs/writers"
import { sha256File } from "@mailwoman/core/hash"
import { prettyJSON, stringifyJSON } from "@mailwoman/core/json"
import { createRequire } from "@mailwoman/core/module/resolvers"
import { parseArguments, requiredArgument } from "@mailwoman/core/scripting/arguments"
import * as ort from "onnxruntime-node"
import { JSONSpliterator } from "spliterator"

import { loadClassifierFromWeights } from "#classifier/loader"

const { values } = parseArguments({
	options: {
		"weights-overlay": { type: "string" },
		reference: { type: "string" },
		candidate: { type: "string" },
		rows: { type: "string" },
		locale: { type: "string", default: "en-us" },
		count: { type: "string", default: "1000" },
		tolerance: { type: "string", default: "1e-4" },
		threads: { type: "string", default: "4" },
		out: { type: "string" },
	},
})

const SCOPE = "onnx-export-parity"
const overlayRoot = requiredArgument(SCOPE, "weights-overlay", values["weights-overlay"])
const referencePath = requiredArgument(SCOPE, "reference", values.reference)
const candidatePath = requiredArgument(SCOPE, "candidate", values.candidate)
const rowsPath = requiredArgument(SCOPE, "rows", values.rows)
const count = Number(values.count)
const tolerance = Number(values.tolerance)
const threads = Number(values.threads)

if (!(count > 0) || !(tolerance > 0) || !(threads > 0))
	throw new Error("--count, --tolerance and --threads must be positive")

interface HeldoutRow {
	raw: string
	country?: string
	source_id?: string
}

type Feeds = Record<string, ort.Tensor>

function copyFeeds(feeds: Feeds): Feeds {
	return Object.fromEntries(
		Object.entries(feeds).map(([name, t]) => [name, new ort.Tensor(t.type, (t.data as Float32Array).slice(), t.dims)])
	)
}

const sessionOptions: ort.InferenceSession.SessionOptions = {
	executionProviders: ["cpu"],
	graphOptimizationLevel: "all",
	intraOpNumThreads: threads,
}

const [reference, candidate] = await Promise.all([
	ort.InferenceSession.create(referencePath, sessionOptions),
	ort.InferenceSession.create(candidatePath, sessionOptions),
])

// Record every feed the runtime builds while the capture classifier parses the probe rows.
const captured: Array<{ feeds: Feeds; row: number; hinted: boolean }> = []
let capturing: { row: number; hinted: boolean } | null = null

type Run = (this: ort.InferenceSession, feeds: Feeds, ...rest: unknown[]) => Promise<ort.InferenceSession.ReturnType>

// Every session shares one class prototype, so the classifier's session runs through this `run` too.
const sessionPrototype: { run: Run } = Object.getPrototypeOf(reference)
const originalRun = sessionPrototype.run

sessionPrototype.run = function (feeds, ...rest) {
	if (capturing) {
		captured.push({ feeds: copyFeeds(feeds), ...capturing })
	}

	return originalRun.call(this, feeds, ...rest)
}

const classifier = await loadClassifierFromWeights({ locale: values.locale, overlayRoot })
const rows = await Array.fromAsync(JSONSpliterator.fromAsync<HeldoutRow>(rowsPath))

// An even spread over the file rather than its first rows.
// The file is sorted by country.
const stride = Math.max(1, Math.floor(rows.length / count))
let hintedRows = 0

for (let i = 0; i < rows.length && captured.length < count; i += stride) {
	const row = rows[i]!
	const hinted = (i / stride) % 2 === 1 && typeof row.country === "string"

	if (hinted) {
		hintedRows++
	}

	capturing = { row: i, hinted }
	await classifier.parse(row.raw, hinted ? { localeHint: row.country } : {})
	capturing = null
}

sessionPrototype.run = originalRun

const probes = captured.slice(0, count)

if (probes.length < count)
	throw new Error(`captured ${probes.length} feeds from ${rowsPath}; --count asks for ${count}`)

function declared(session: ort.InferenceSession) {
	return {
		inputs: session.inputMetadata.map((m) =>
			m.isTensor ? { name: m.name, type: m.type, shape: m.shape } : { name: m.name }
		),
		outputs: session.outputMetadata.map((m) =>
			m.isTensor ? { name: m.name, type: m.type, shape: m.shape } : { name: m.name }
		),
	}
}

const referenceInterface = declared(reference)
const candidateInterface = declared(candidate)
const interfaceEqual = stringifyJSON(referenceInterface) === stringifyJSON(candidateInterface)

interface OutputStats {
	elements: number
	overTolerance: number
	maxAbsDiff: number
	worstProbe: number | null
}

const stats: Record<string, OutputStats> = {}
let logitArgmaxAgree = 0
let logitPositions = 0

function compare(
	a: ort.InferenceSession.ReturnType,
	b: ort.InferenceSession.ReturnType,
	probe: number,
	mask?: ort.Tensor
) {
	for (const name of reference.outputNames) {
		const x = a[name]!.data as Float32Array
		const y = b[name]!.data as Float32Array

		if (x.length !== y.length || a[name]!.dims.join() !== b[name]!.dims.join()) {
			throw new Error(`probe ${probe}: ${name} has dims [${a[name]!.dims}] against [${b[name]!.dims}]`)
		}

		const s = (stats[name] ??= { elements: 0, overTolerance: 0, maxAbsDiff: 0, worstProbe: null })

		for (let i = 0; i < x.length; i++) {
			const d = Math.abs(x[i]! - y[i]!)

			// A NaN on either side is a difference, never a match.
			if (!(d <= tolerance)) {
				s.overTolerance++
			}

			if (!(d <= s.maxAbsDiff)) {
				s.maxAbsDiff = Number.isNaN(d) ? Infinity : d
				s.worstProbe = probe
			}
		}

		s.elements += x.length

		if (name === "logits" && mask) {
			const labels = a[name]!.dims.at(-1)!
			const m = mask.data as BigInt64Array

			for (let t = 0; t < m.length; t++) {
				if (m[t] === 0n) {
					continue
				}

				let ai = 0
				let bi = 0

				for (let l = 1; l < labels; l++) {
					if (x[t * labels + l]! > x[t * labels + ai]!) {
						ai = l
					}

					if (y[t * labels + l]! > y[t * labels + bi]!) {
						bi = l
					}
				}

				logitPositions++

				if (ai === bi) {
					logitArgmaxAgree++
				}
			}
		}
	}
}

/**
 * The feed trimmed to the first `length` positions along the sequence axis.
 */
function trimmed(feeds: Feeds, length: number): Feeds {
	return Object.fromEntries(
		Object.entries(feeds).map(([name, t]) => {
			if (t.dims.length < 2) return [name, t]

			const [batch, seq, ...rest] = t.dims as number[]
			const inner = rest.reduce((p, n) => p * n, 1)
			const data = t.data as Float32Array
			const out = new (data.constructor as Float32ArrayConstructor)(batch! * length * inner)

			for (let b = 0; b < batch!; b++) {
				out.set(data.subarray(b * seq! * inner, (b * seq! + length) * inner), b * length * inner)
			}

			return [name, new ort.Tensor(t.type, out, [batch!, length, ...rest])]
		})
	)
}

let trimmedProbes = 0

for (const [index, probe] of probes.entries()) {
	const [a, b] = await Promise.all([reference.run(probe.feeds), candidate.run(probe.feeds)])

	compare(a, b, index, probe.feeds["attention_mask"])

	if (index % 10 === 0) {
		const mask = probe.feeds["attention_mask"]!.data as BigInt64Array
		const length = mask.reduce((n, v) => n + Number(v), 0)
		const short = trimmed(probe.feeds, Math.max(1, length))
		const [ta, tb] = await Promise.all([reference.run(short), candidate.run(short)])

		compare(ta, tb, index, short["attention_mask"])

		trimmedProbes++
	}
}

// The first two probes stacked as one batch of two, run through each graph separately.
function stacked(x: Feeds, y: Feeds): Feeds {
	return Object.fromEntries(
		Object.keys(x).map((name) => {
			const a = x[name]!
			const b = y[name]!
			const data = a.data as Float32Array
			const out = new (data.constructor as Float32ArrayConstructor)(data.length * 2)

			out.set(data, 0)
			out.set(b.data as Float32Array, data.length)

			return [name, new ort.Tensor(a.type, out, [2, ...(a.dims as number[]).slice(1)])]
		})
	)
}

async function batchOfTwo(session: ort.InferenceSession) {
	try {
		const out = await session.run(stacked(probes[0]!.feeds, probes[1]!.feeds))

		return { ran: true, dims: Object.fromEntries(Object.entries(out).map(([n, t]) => [n, t.dims])) }
	} catch (error) {
		// oxlint-disable-next-line mailwoman/prefer-spliterator -- An Error message rather than a data file.
		return { ran: false, error: (error as Error).message.split("\n")[0] }
	}
}

const batch = { reference: await batchOfTwo(reference), candidate: await batchOfTwo(candidate) }
const outputsWithin = Object.values(stats).every((s) => s.overTolerance === 0)
const pass = interfaceEqual && outputsWithin

const require = createRequire(import.meta.url)

const ortVersion = (await readLocalJSONFile<{ version: string }>(require.resolve("onnxruntime-node/package.json")))
	.version

const receipt = {
	tool: "packages/neural/tools/onnx-export-parity.run.ts",
	measuredAt: new Date().toISOString(),
	onnxruntimeNode: ortVersion,
	sessionOptions,
	reference: { path: referencePath, sha256: await sha256File(referencePath) },
	candidate: { path: candidatePath, sha256: await sha256File(candidatePath) },
	probes: {
		rows: rowsPath,
		rowsSha256: await sha256File(rowsPath),
		rowsRead: rows.length,
		stride,
		count: probes.length,
		hintedRows,
		trimmedProbes,
		weightsOverlay: overlayRoot,
		locale: values.locale,
	},
	interface: { equal: interfaceEqual, reference: referenceInterface, candidate: candidateInterface },
	tolerance,
	outputs: stats,
	logitArgmax: { agree: logitArgmaxAgree, positions: logitPositions },
	batchOfTwo: batch,
	verdict: pass ? "pass" : "fail",
}

if (values.out) {
	await writeLocalJSONFile(receipt, values.out)
}

console.log(
	prettyJSON({
		verdict: receipt.verdict,
		interfaceEqual,
		outputs: stats,
		logitArgmax: receipt.logitArgmax,
		batchOfTwo: batch,
	})
)

if (!pass) {
	process.exitCode = 1
}
