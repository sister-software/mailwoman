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
 *
 *   Lives in `test/full` rather than `test/unit` because it never runs on the fast leg: it is gated on two staged
 *   weights caches under `$MAILWOMAN_TEMP_ROOT` that no CI checkout carries, so it always skipped there while still
 *   pulling the onnxruntime web graph into the fast leg's shared module graph at collection time.
 */

import { pathExists, readLocalBuffer } from "@mailwoman/core/fs/readers"
import { tempRootPath } from "@mailwoman/core/utils"
import { WebONNXRunner } from "@mailwoman/neural/web-onnx-runner"
import { weightsCachePackageDir } from "@mailwoman/neural/weights"
import { join } from "path-ts"
import { describe, expect, it } from "vitest"

/**
 * The two staged weights caches this benchmark compares, under `$MAILWOMAN_TEMP_ROOT`.
 *
 * `weightsCachePackageDir` owns the `node_modules/<package>` segment — the layout belongs to the weights package, and a
 * hand-assembled path into it reads a missing artifact as "absent" rather than "looked in the wrong place".
 */
function stagedModel(cacheName: string): string {
	return join(weightsCachePackageDir(String(tempRootPath(cacheName)), "en-us"), "model.onnx")
}

const V264 = stagedModel("v264-cache")
const V301 = stagedModel("v301-cache")
const have = (await pathExists(V264)) && (await pathExists(V301))

describe.skipIf(!have)("#727 span SLO (onnxruntime-web WASM EP)", () => {
	it("reports the browser-runtime cost of the span graph", async () => {
		const ids = Array.from({ length: 24 }, (_, i) => 100 + i)

		const bench = async (path: string): Promise<{ ms: number; spans: boolean }> => {
			const runner = await WebONNXRunner.fromBytes(new Uint8Array(await readLocalBuffer(path)), { useWebGPU: false })

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

		// Timing is reported rather than asserted, being machine-dependent. What the comparison is
		// actually for — that v264 emits no span scores and v301 does — is an invariant, and was
		// going unchecked.
		expect(a.spans).toBe(false)
		expect(b.spans).toBe(true)
	}, 300_000)
})
