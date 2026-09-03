/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The `mwdev_constraints` tool definition — the description an agent reads, the input schema, and the handler
 *   wiring. The measurement lives in `../constraint-census.ts`.
 */

import { z } from "zod"

import { runConstraintCensus } from "#constraint-census"
import type { EngineConfig } from "#engine-registry"
import type { InputSetRef } from "#input-sets"
import type { DevTool, DevToolDeps } from "#tool-kit"
import { ENGINE_CONFIG_SCHEMA, INPUT_SET_SCHEMA } from "#tool-kit"

export const constraintsTool = ({ registry }: DevToolDeps): DevTool => ({
	name: "mwdev_constraints",
	description:
		"WHAT OUR CHECKS COST. Every backend lookup that resolved NOTHING, grouped by the constraint in force when it " +
		"missed, with the one split that makes it a measurement: a lookup that missed in band X while the same key " +
		"sits in band Y is a REACHABILITY failure — we held the row and the query went to the wrong shelf — while a " +
		"key that exists nowhere is a COVERAGE fact. Both reach a caller as `null` today and they call for opposite " +
		"work, so they are reported separately and never summed. Complements mwdev_census, which asks whether a " +
		"PARSE-path mechanism fires at all; this asks what a resolver-path constraint costs when it does. A check " +
		"that fires often and never once accompanies a pick is reported INERT — the first run over the board found " +
		"`parent_fallback_retry` at 194 firings and zero conversions, because it relaxes the PARENT while the BAND " +
		"is what blocks (#1756). Keys are folded with the candidate build's own `normalizeLocalityForKey`; a " +
		"lowercase approximation silently moves rows from reachability into coverage.",
	inputSchema: z.object({
		inputs: INPUT_SET_SCHEMA.optional().describe("Defaults to the full board."),
		config: ENGINE_CONFIG_SCHEMA.optional().describe(
			"Tracing is forced on regardless — the resolver-interior records are the census's entire input."
		),
	}),
	handler: async (args) =>
		runConstraintCensus(registry, {
			inputs: args["inputs"] as InputSetRef | undefined,
			config: args["config"] as EngineConfig | undefined,
		}),
})
