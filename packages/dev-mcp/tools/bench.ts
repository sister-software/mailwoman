/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The `mwdev_bench` tool definition — the description an agent reads, the input schema, and the handler wiring.
 *   The measurement itself lives in the package root; this file is the CONTRACT, and the description is the
 *   load-bearing half of it.
 */

import { z } from "zod"

import { assembleBench, summarizeLatency } from "../bench.ts"
import type { EngineConfig } from "../engine-registry.ts"
import { resolveInputSet, type InputSetRef } from "../input-sets.ts"
import type { DevTool, DevToolDeps } from "../tool-kit.ts"
import { ENGINE_CONFIG_SCHEMA, INPUT_SET_SCHEMA, provenanceFor } from "../tool-kit.ts"

export const benchTool = ({ registry, jobs }: DevToolDeps): DevTool => ({
	name: "mwdev_bench",
	description:
		"Latency and throughput for the geocode path, cold and warm reported SEPARATELY. Single-threaded on " +
		"purpose — the result says why.",
	inputSchema: z.object({
		inputs: INPUT_SET_SCHEMA.optional(),
		config: ENGINE_CONFIG_SCHEMA.optional(),
		repetitions: z.number().int().positive().max(5).default(1),
		include_cold: z
			.boolean()
			.default(false)
			.describe("Evict first and time a construction. Costs ~1.4s and is the number a user actually experiences."),
		limit: z.number().int().positive().optional(),
	}),
	handler: async (args) => {
		const set = await resolveInputSet((args["inputs"] as InputSetRef | undefined) ?? { kind: "board" })
		const config = (args["config"] as EngineConfig | undefined) ?? {}
		const repetitions = (args["repetitions"] as number | undefined) ?? 1
		const limit = args["limit"] as number | undefined
		const selected = limit ? set.inputs.slice(0, limit) : set.inputs

		let cold: { engine_build_ms: number; first_query_ms: number; total_ms: number } | null = null

		if (args["include_cold"]) {
			// Evicting is what makes this a COLD measurement rather than a second warm one.
			registry.closeAll()

			const startedAt = Date.now()
			const coldEngine = await registry.acquire(config)
			const builtAt = Date.now()

			await coldEngine.session.geocode(selected[0]!.input)

			cold = {
				engine_build_ms: coldEngine.buildMs,
				first_query_ms: Date.now() - builtAt,
				total_ms: Date.now() - startedAt,
			}
		}

		const engine = await registry.acquire(config)
		const samples: number[] = []

		for (let pass = 0; pass < repetitions; pass++) {
			for (const item of selected) {
				const startedAt = performance.now()

				await engine.session.geocode(item.input)
				samples.push(performance.now() - startedAt)
			}
		}

		const reading = assembleBench(cold, summarizeLatency(samples))

		return {
			provenance: provenanceFor(engine, set),
			...reading,
			repetitions,
			n_inputs: selected.length,
		}
	},
})
