/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 * The `mwdev_trace` tool definition, whose description, input schema and handler wiring are the interface an agent
 * reads; the measurement itself lives in the package root.
 */

import { z } from "zod"

import type { EngineConfig } from "#engine/registry"
import { evidenceCensus } from "#evidence"
import { resolveInputSet } from "#input-sets"
import type { DevTool, DevToolDeps } from "#tool-kit"
import { ENGINE_CONFIG_SCHEMA, componentsOf, provenanceFor, renderTrace, slimParseTrace } from "#tool-kit"

/**
 * Run the `mwdev_trace` tool, reporting per-stage evidence for a handful of inputs and no rate.
 */
export const traceTool = ({ registry }: DevToolDeps): DevTool => ({
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
		// Tracing is forced on because this surface exists to explain one row,
		// and the band probe rides with it since neither can change the answer.
		const engine = await registry.acquire({ ...config, trace: true, diagnose_unreachable: true })

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
				// The three-state channel reading: absent / silent / fired, plus the starvation flag.
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
