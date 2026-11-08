/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Measures the readers on this host and prints a Markdown report for `docs/performance.md`.
 *
 *   Arms: a JavaScript `Set` of strings as the baseline, the TypeScript bitset reader, and the WebAssembly batch
 *   kernels, scalar and simd. Inputs: strings end to end, and packed bytes where an arm takes them. Batch sizes 1, 16,
 *   256, 4,096 and the whole 17,576-key domain. Distributions: hits, misses, and a shuffled sweep of the domain. Startup:
 *   module import, artifact decode and validation, wasm compile and instantiate, first query. Every result is consumed
 *   so the work is kept.
 *
 *   Usage: `node packages/registry/tools/bench.run.ts [--json]`
 *
 *   The numbers describe one host and one run. The report records the host, Node and the artifact digests beside them.
 */

import { readLocalBuffer, readLocalJSONFile } from "@mailwoman/core/fs/readers"
import { prettyJSON } from "@mailwoman/core/json"
import { workspacePath } from "@mailwoman/core/paths"
import { mulberry32, shuffleWith } from "@mailwoman/core/random"
import { parseArguments } from "@mailwoman/core/scripting/arguments"
import { cpuCount, cpuModel, totalMemoryBytes } from "@mailwoman/core/utils/system"

import { decode3, KEY_SPACE_3 } from "#key"

const { values } = parseArguments({ options: { json: { type: "boolean", default: false } } })

const encoder = new TextEncoder()

function nanoseconds(start: bigint): number {
	return Number(process.hrtime.bigint() - start)
}

/**
 * Runs `run` over `rounds` repetitions and reports the median nanoseconds per code.
 */
function measure(
	label: string,
	codesPerRound: number,
	rounds: number,
	run: () => number
): { label: string; nsPerCode: number; sink: number } {
	const samples: number[] = []
	let sink = 0

	for (let round = 0; round < rounds; round++) {
		const start = process.hrtime.bigint()

		sink += run()
		samples.push(nanoseconds(start) / codesPerRound)
	}

	samples.sort((a, b) => a - b)

	return { label, nsPerCode: samples[Math.floor(samples.length / 2)]!, sink }
}

// Startup: module import.
const importStart = process.hrtime.bigint()

const [{ collisionMembership, isCountryAirportCollision }, { alpha3Membership }, { airportMembership }, wasm] =
	await Promise.all([
		import("#overlap/country-airport"),
		import("#iso3166/alpha3"),
		import("#iata/airports/validate"),
		import("#wasm"),
	])

const importNs = nanoseconds(importStart)

// Startup: decode and validate the three bitsets on first use.
const decodeStart = process.hrtime.bigint()
collisionMembership()
alpha3Membership()
airportMembership()
const decodeNs = nanoseconds(decodeStart)

const firstQueryStart = process.hrtime.bigint()
isCountryAirportCollision("AUS")
const firstQueryNs = nanoseconds(firstQueryStart)

// The baseline: a Set of strings built from the normalized JSON.
const countries = await readLocalJSONFile<{ records: Array<{ alpha3: string; status: string }> }>(
	workspacePath("registry", "data", "normalized", "iso3166-1.json")
)

const airports = await readLocalJSONFile<{ records: Array<{ iata: string }> }>(
	workspacePath("registry", "data", "normalized", "iata-airports.json")
)

const setStart = process.hrtime.bigint()

const countrySet = new Set(
	countries.records.filter((record) => record.status === "officially-assigned").map((record) => record.alpha3)
)

const airportSet = new Set(airports.records.map((record) => record.iata))
const collisionSet = new Set([...countrySet].filter((code) => airportSet.has(code)))
const setBuildNs = nanoseconds(setStart)

// Inputs.
const allCodes = Array.from({ length: KEY_SPACE_3 }, (_, key) => decode3(key))
const hits = [...collisionSet]
const misses = allCodes.filter((code) => !countrySet.has(code) && !airportSet.has(code)).slice(0, 4096)
const shuffled = [...allCodes]

// A fixed-seed shuffle so two runs read the same order.
shuffleWith(shuffled, mulberry32(0x9e_37_79_b9))

function packed(codes: readonly string[]): Uint8Array {
	const bytes = new Uint8Array(codes.length * 3)

	codes.forEach((code, index) => bytes.set(encoder.encode(code), index * 3))

	return bytes
}

const results: Array<{ arm: string; input: string; distribution: string; batch: number; nsPerCode: number }> = []
const batches = [1, 16, 256, 4096, KEY_SPACE_3]

for (const [distribution, codes] of [
	["hits", hits],
	["misses", misses],
	["shuffled sweep", shuffled],
] as const) {
	for (const batch of batches) {
		if (batch > codes.length && batch !== KEY_SPACE_3) continue

		const sample = codes.slice(0, Math.min(batch, codes.length))
		const rounds = Math.max(5, Math.min(2000, Math.floor(200_000 / sample.length)))

		results.push({
			arm: "JS Set (baseline)",
			input: "strings",
			distribution,
			batch,
			...measure("set", sample.length, rounds, () => {
				let count = 0

				for (const code of sample) {
					count += collisionSet.has(code) ? 1 : 0
				}

				return count
			}),
		})

		results.push({
			arm: "TypeScript bitset",
			input: "strings",
			distribution,
			batch,
			...measure("ts", sample.length, rounds, () => {
				let count = 0

				for (const code of sample) {
					count += isCountryAirportCollision(code) ? 1 : 0
				}

				return count
			}),
		})
	}
}

const variants = wasm.preferredWasmVariant() === "simd" ? (["scalar", "simd"] as const) : (["scalar"] as const)

const startup: Record<string, number> = {
	"module import": importNs,
	"artifact decode + validate (3 bitsets)": decodeNs,
	"first query": firstQueryNs,
	"JS Set build from JSON (baseline)": setBuildNs,
}

for (const variant of variants) {
	const bytes = await readLocalBuffer(wasm.registryWasmURL(variant))
	const compileStart = process.hrtime.bigint()
	const registry = await wasm.createRegistry({ wasm: bytes })

	startup[`wasm ${variant}: compile + instantiate + load 3 artifacts`] = nanoseconds(compileStart)

	for (const [distribution, codes] of [
		["hits", hits],
		["misses", misses],
		["shuffled sweep", shuffled],
	] as const) {
		for (const batch of batches) {
			if (batch > codes.length && batch !== KEY_SPACE_3) continue

			const sample = codes.slice(0, Math.min(batch, codes.length))
			const input = packed(sample)
			const out = new Uint8Array(sample.length)
			const rounds = Math.max(5, Math.min(2000, Math.floor(200_000 / sample.length)))

			results.push({
				arm: `wasm ${variant} batch`,
				input: "packed bytes",
				distribution,
				batch,
				...measure("wasm", sample.length, rounds, () => {
					registry.countryAirport.classifyManyInto(input, out)

					let count = 0

					for (const mask of out) {
						count += mask & 4 ? 1 : 0
					}

					return count
				}),
			})

			results.push({
				arm: `wasm ${variant} batch`,
				input: "strings (encode + copy included)",
				distribution,
				batch,
				...measure("wasm-strings", sample.length, rounds, () => {
					const masks = registry.countryAirport.classify(sample)
					let count = 0

					for (const mask of masks) {
						count += mask & 4 ? 1 : 0
					}

					return count
				}),
			})
		}
	}

	registry.dispose()
}

const manifest = await readLocalJSONFile<Record<string, { sha256: string; bytes: number }>>(
	workspacePath("registry", "data", "manifests", "artifacts.json")
)

const host = {
	node: process.version,
	cpu: cpuModel(),
	cores: cpuCount(),
	memoryGB: Math.round(totalMemoryBytes() / 1e9),
	platform: `${process.platform} ${process.arch}`,
}

if (values.json) {
	console.log(prettyJSON({ host, startup, results, manifest }))
} else {
	console.log(`Host: ${host.cpu}, ${host.cores} cores, ${host.memoryGB} GB, ${host.platform}, Node ${host.node}\n`)
	console.log("| Startup | µs |\n| --- | --- |")

	for (const [label, ns] of Object.entries(startup)) {
		console.log(`| ${label} | ${(ns / 1000).toFixed(0)} |`)
	}

	console.log("\n| Arm | Input | Distribution | Batch | ns per code (median) |\n| --- | --- | --- | --- | --- |")

	for (const row of results) {
		console.log(`| ${row.arm} | ${row.input} | ${row.distribution} | ${row.batch} | ${row.nsPerCode.toFixed(1)} |`)
	}

	console.log("\n| Artifact | Bytes | SHA-256 |\n| --- | --- | --- |")

	for (const [name, entry] of Object.entries(manifest)) {
		console.log(`| ${name} | ${entry.bytes} | ${entry.sha256.slice(0, 16)}… |`)
	}
}
