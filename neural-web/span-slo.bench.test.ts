/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   #378 SLO probe for the #727 span output, on the BROWSER runtime (onnxruntime-web WASM EP) rather
 *   than onnxruntime-node — the Phase-2 bench measured the node runtime, which is not what ships.
 *
 *   Reported, not asserted: a wall-clock threshold in CI is a flake generator. The number goes in the
 *   Phase-3 verdict; this file exists so it is reproducible.
 */

import { existsSync } from "node:fs"
import { readFile } from "node:fs/promises"

import { describe, it } from "vitest"

import { WebONNXRunner } from "./web-onnx-runner.ts"

const V264 = "scratchpad/v264-cache/node_modules/@mailwoman/neural-weights-en-us/model.onnx"
const V301 = "scratchpad/v301-cache/node_modules/@mailwoman/neural-weights-en-us/model.onnx"
const have = existsSync(V264) && existsSync(V301)

describe.skipIf(!have)("#727 span SLO (onnxruntime-web WASM EP)", () => {
	it("reports the browser-runtime cost of the span graph", async () => {
		const ids = Array.from({ length: 24 }, (_, i) => 100 + i)

		const bench = async (path: string): Promise<{ ms: number; spans: boolean }> => {
			const runner = await WebONNXRunner.fromBytes(new Uint8Array(await readFile(path)), { useWebGPU: false })

			for (let i = 0; i < 8; i++) {
				await runner.infer(ids)
			}
			const t0 = performance.now()
			const N = 40
			let spans = false

			for (let i = 0; i < N; i++) {
				spans = !!(await runner.infer(ids)).spanScores
			}

			return { ms: (performance.now() - t0) / N, spans }
		}
		const a = await bench(V264)
		const b = await bench(V301)
		console.log(`\n  v264 (no spans) : ${a.ms.toFixed(2)} ms/infer  spans=${a.spans}`)
		console.log(`  v301 (spans)    : ${b.ms.toFixed(2)} ms/infer  spans=${b.spans}`)
		console.log(`  delta           : ${(b.ms - a.ms).toFixed(2)} ms (${((100 * (b.ms - a.ms)) / a.ms).toFixed(1)}%)`)
		console.log(`  NOTE: v301 unflattens spans on EVERY infer here — the full cost, not logits-only.\n`)
	}, 300_000)
})
