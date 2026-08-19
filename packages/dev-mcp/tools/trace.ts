/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The `mwdev_trace` tool definition — the description an agent reads, the input schema, and the handler wiring.
 *   The measurement itself lives in the package root; this file is the CONTRACT, and the description is the
 *   load-bearing half of it.
 */

import { z } from "zod"

import type { EngineConfig } from "../engine-registry.ts"
import { evidenceCensus } from "../evidence.ts"
import { resolveInputSet } from "../input-sets.ts"
import type { DevTool, DevToolDeps } from "../tool-kit.ts"
import { ENGINE_CONFIG_SCHEMA, componentsOf, provenanceFor, renderTrace, slimParseTrace } from "../tool-kit.ts"

export const traceTool = ({ registry, jobs }: DevToolDeps): DevTool => ({
	name: "mwdev_trace",
	description:
		"Per-stage evidence for a handful of inputs — what the model was told, what it was fed, what it decided. " +
		"Returns the structured trace AND the rendered rows. Not a measurement tool: it emits no rate and no verdict.",
	inputSchema: z.object({
		inputs: z.array(z.string()).min(1).max(20).describe("Up to 20 raw address strings."),
		config: ENGINE_CONFIG_SCHEMA.optional(),
		full_parse_trace: z
			.boolean()
			.default(false)
			.describe(
				"Include the raw logit/emission/feature matrices (thousands of floats). The default slim trace " +
					"keeps every discrete diagnostic — tokens, labels, confidences, path, priors, channel " +
					"confidence vectors — and is what a reader almost always wants."
			),
	}),
	handler: async (args) => {
		const inputs = args["inputs"] as string[]
		const config = (args["config"] as EngineConfig | undefined) ?? {}
		const fullParseTrace = args["full_parse_trace"] === true
		// Tracing is the answer here, so it is forced on regardless of what the caller passed.
		const engine = await registry.acquire({ ...config, trace: true })

		const set = await resolveInputSet({
			kind: "literal",
			inputs,
			why: "mwdev_trace inspects named inputs by design; it reports no rate, so no panel is implied.",
		})

		const rows: unknown[] = []

		for (const input of inputs) {
			const run = await engine.session.geocode(input)
			const { rendered, absent_reason } = renderTrace(run)

			rows.push({
				input,
				components: componentsOf(run),
				lat: run.result.lat,
				lon: run.result.lon,
				tier: run.result.resolution_tier,
				// The three-state channel reading (#1718): absent / silent / fired, plus the starvation flag. A
				// human read past three all-zero channel rows in this very output once; a field does not skim.
				evidence: run.trace?.parse ? evidenceCensus(run.trace.parse) : null,
				query_shape: run.trace?.queryShape ?? null,
				kind: run.trace?.kind ?? null,
				input_mode: run.trace?.inputMode ?? null,
				parse_trace: run.trace?.parse ? (fullParseTrace ? run.trace.parse : slimParseTrace(run.trace.parse)) : null,
				rendered,
				...(absent_reason ? { trace_absent_reason: absent_reason } : {}),
				timing_ms: run.timing,
			})
		}

		return {
			provenance: provenanceFor(engine, set),
			summary: `Traced ${rows.length} input${rows.length === 1 ? "" : "s"}. This tool reports evidence, never a rate — use mwdev_run over the board for that.`,
			n_requested: inputs.length,
			n_evaluated: rows.length,
			n_errored: 0,
			rows,
		}
	},
})
