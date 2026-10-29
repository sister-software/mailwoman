/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Checks the Node sampler binding against an encoder-parity record, and measures its memory over a long stream.
 *
 *   `verify --name <record>` re-draws a record under `$MAILWOMAN_DATA_ROOT/audits/encoder-parity/<record>/` through
 *   `mtf-node`: the sampler's rows, the row encoder's arrays and each row's locale and address-system ids. It compares
 *   the emitted row count, the batch sizes, each row's identity, the tensor set with its dtypes and shapes, and the
 *   SHA-256 of every row of every tensor with the record's, and prints the first difference it finds.
 *
 *   `stream --config <yaml> --rows <n>` reads `n` rows of a split a chunk at a time, counting rows only, and prints
 *   the resident set every `--every` rows and the peak, so a reader can see whether memory grows with the rows read.
 *
 *   Usage:
 *     node packages/mailwoman/tools/training/sampler-parity.run.ts verify --name c6-train-2k [--report <json>]
 *     node packages/mailwoman/tools/training/sampler-parity.run.ts stream --config <yaml> --rows 100000 \
 *       [--split train] [--seed 43] [--set data.key=value]
 */

import { dataRootPath } from "@mailwoman/core/data-root"
import { readLocalJSONFile } from "@mailwoman/core/fs/readers"
import { writeLocalJSONFile } from "@mailwoman/core/fs/writers"
import { sha256Hex } from "@mailwoman/core/hash"
import { prettyJSON, stringifyJSON } from "@mailwoman/core/json"
import { parseArguments } from "@mailwoman/core/scripting/arguments"
import { mtfNode } from "@mailwoman/mtf/tools/sampler/native"

import { applyOverrides, loadTrainingConfig, recordedConfigPath, rerootToHost } from "./config.ts"
import {
	createConfigRowEncoder,
	encodeModelBatch,
	openSampler,
	readAddressSystemLookup,
	rowIdentity,
	sampledBatches,
	sampledRows,
	type ModelBatch,
} from "./sampler.ts"

interface ParityRecord {
	format: number
	config: { path: string; sha256: string; overrides: string[] }
	split: string
	seed: number
	requested_rows: number
	batch_size: number
	drop_spans: boolean
	emitted_rows: number
	batch_sizes: number[]
	tensors: Record<string, { dtype: string; row_shape: number[] }>
	row_identity: string[]
	digests: Record<string, string[]>
}

const { values, positionals } = parseArguments({
	allowPositionals: true,
	options: {
		name: { type: "string" },
		report: { type: "string" },
		config: { type: "string" },
		split: { type: "string", default: "train" },
		seed: { type: "string", default: "43" },
		rows: { type: "string", default: "100000" },
		every: { type: "string", default: "10000" },
		set: { type: "string", multiple: true, default: [] },
	},
})

function megabytes(bytes: number): number {
	return Math.round(bytes / 1024 / 1024)
}

/**
 * Peak resident set in MB: `ru_maxrss`, which Node reports in kilobytes.
 */
function peakRSS(): number {
	return Math.round(process.resourceUsage().maxRSS / 1024)
}

function residentMegabytes(): number {
	return megabytes(process.memoryUsage().rss)
}

/**
 * Every tensor of a batch with its dtype, its row shape and its data, in the record's table order.
 */
function batchTensors(batch: ModelBatch): Array<{
	name: string
	dtype: string
	rowShape: number[]
	data: BigInt64Array | Float32Array
}> {
	const length = batch.maxLength

	const out: Array<{ name: string; dtype: string; rowShape: number[]; data: BigInt64Array | Float32Array }> = [
		{ name: "input_ids", dtype: "int64", rowShape: [length], data: batch.inputIDs },
		{ name: "attention_mask", dtype: "int64", rowShape: [length], data: batch.attentionMask },
		{ name: "labels", dtype: "int64", rowShape: [length], data: batch.labels },
		{ name: "locale_ids", dtype: "int64", rowShape: [], data: batch.localeIDs },
		{ name: "address_system_ids", dtype: "int64", rowShape: [], data: batch.addressSystemIDs },
	]

	for (const channel of batch.channels) {
		out.push(
			{ name: `${channel.name}_features`, dtype: "float32", rowShape: [length, channel.dim], data: channel.features },
			{ name: `${channel.name}_confidence`, dtype: "float32", rowShape: [length], data: channel.confidence }
		)
	}

	return out
}

/**
 * The SHA-256 of each row of a tensor over its little-endian bytes.
 *
 * The host is little-endian, as the typed arrays hold their elements in host order.
 */
function rowDigests(data: BigInt64Array | Float32Array, rows: number): string[] {
	const width = data.length / rows
	const bytes = width * data.BYTES_PER_ELEMENT

	return Array.from({ length: rows }, (_, row) =>
		sha256Hex(new Uint8Array(data.buffer, data.byteOffset + row * bytes, bytes))
	)
}

async function verify(name: string, reportPath: string | undefined): Promise<boolean> {
	const directory = dataRootPath("audits", "encoder-parity", name)
	const record = await readLocalJSONFile<ParityRecord>(directory("record.json"))

	if (record.format !== 1) throw new Error(`record format ${record.format} is not 1`)

	const configPath = await recordedConfigPath(record.config)
	const config = rerootToHost(applyOverrides(await loadTrainingConfig(configPath), record.config.overrides))
	const started = performance.now()
	const mtf = await mtfNode()
	const encoder = createConfigRowEncoder(mtf, config.data)
	const addressSystem = await readAddressSystemLookup()

	const sampler = openSampler(mtf, config, record.split, record.seed, {
		rowLimit: record.requested_rows,
		dropSpans: record.drop_spans,
	})

	const initSeconds = (performance.now() - started) / 1000

	const sizes: number[] = []
	const identities: string[] = []
	const digests: Record<string, string[]> = {}
	const shapes: Record<string, { dtype: string; row_shape: number[] }> = {}

	for (const rows of sampledBatches(sampler, record.batch_size)) {
		const batch = encodeModelBatch(encoder, addressSystem, rows)

		sizes.push(rows.length)
		identities.push(...rows.map(rowIdentity))

		for (const tensor of batchTensors(batch)) {
			shapes[tensor.name] ??= { dtype: tensor.dtype, row_shape: tensor.rowShape }
			;(digests[tensor.name] ??= []).push(...rowDigests(tensor.data, rows.length))
		}
	}

	const emitted = sizes.reduce((a, b) => a + b, 0)
	const structural: string[] = []

	if (emitted !== record.emitted_rows) {
		structural.push(`emitted rows ${emitted} != recorded ${record.emitted_rows}`)
	}

	if (stringifyJSON(sizes) !== stringifyJSON(record.batch_sizes)) {
		structural.push("batch sizes differ")
	}

	const firstIdentity = identities.findIndex((id, i) => id !== record.row_identity[i])

	if (firstIdentity !== -1 || identities.length !== record.row_identity.length) {
		structural.push(
			`sampled rows differ from the record, first at row ${firstIdentity === -1 ? identities.length : firstIdentity}`
		)
	}

	if (stringifyJSON(shapes) !== stringifyJSON(record.tensors)) {
		structural.push(`tensor set, dtypes or shapes differ: now ${stringifyJSON(shapes)}`)
	}

	const tensors: Record<string, { rows: number; differing_rows: number }> = {}
	const differing = new Set<number>()
	let firstMismatch: { row: number; tensor: string } | null = null

	if (!structural.length) {
		for (const tensor of Object.keys(record.tensors)) {
			const now = digests[tensor] ?? []
			const recorded = record.digests[tensor] ?? []
			let count = 0

			for (const [row, digest] of now.entries()) {
				if (digest === recorded[row]) continue

				count++
				differing.add(row)
				firstMismatch ??= { row, tensor }
			}

			tensors[tensor] = { rows: now.length, differing_rows: count }
		}
	}

	const report = {
		record: name,
		emitted_rows: emitted,
		recorded_rows: record.emitted_rows,
		structural,
		tensors,
		first_mismatch: firstMismatch,
		differing_rows: !structural.length ? differing.size : null,
		equal: structural.length === 0 && differing.size === 0,
		init_seconds: Math.round(initSeconds * 10) / 10,
		total_seconds: Math.round((performance.now() - started) / 100) / 10,
		peak_rss_mb: peakRSS(),
	}

	if (reportPath) {
		await writeLocalJSONFile(report, reportPath)
	}

	console.log(prettyJSON(report, false, 1))

	return report.equal
}

async function stream(): Promise<void> {
	if (!values.config) throw new Error("stream needs --config <yaml>")

	const rows = Number(values.rows)
	const every = Number(values.every)
	const config = rerootToHost(applyOverrides(await loadTrainingConfig(values.config), values.set))
	const started = performance.now()
	const mtf = await mtfNode()
	const sampler = openSampler(mtf, config, values.split, Number(values.seed), { rowLimit: rows })
	const initSeconds = (performance.now() - started) / 1000

	console.log(`opened ${values.split} in ${initSeconds.toFixed(1)} s; rss ${residentMegabytes()} MB`)

	let read = 0
	let characters = 0
	const samples: Array<{ rows: number; rss_mb: number; seconds: number }> = []

	for (const row of sampledRows(sampler)) {
		read++
		characters += row.raw.length

		if (read % every === 0) {
			const sample = {
				rows: read,
				rss_mb: residentMegabytes(),
				seconds: Math.round((performance.now() - started) / 100) / 10,
			}

			samples.push(sample)

			console.log(`${sample.rows} rows, rss ${sample.rss_mb} MB, ${sample.seconds} s`)
		}
	}

	console.log(
		stringifyJSON({
			rows: read,
			characters,
			init_seconds: Math.round(initSeconds * 10) / 10,
			samples,
			peak_rss_mb: peakRSS(),
		})
	)
}

const [command] = positionals

if (command === "verify") {
	if (!values.name) throw new Error("verify needs --name <record>")

	if (!(await verify(values.name, values.report))) {
		process.exitCode = 1
	}
} else if (command === "stream") {
	await stream()
} else {
	throw new Error("expected the command verify or stream")
}
