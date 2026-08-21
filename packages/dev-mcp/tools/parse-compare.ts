/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The `mwdev_parse_compare` tool definition — the description an agent reads, the input schema, and the handler
 *   wiring. The measurement lives in `../parse-compare-report.ts`.
 */

import { z } from "zod"

import { runParseCompare } from "../parse-compare-report.ts"
import type { DevTool, DevToolDeps } from "../tool-kit.ts"
import { ENGINE_CONFIG_SCHEMA, INPUT_SET_SCHEMA } from "../tool-kit.ts"

export const parseCompareTool = ({ registry }: DevToolDeps): DevTool => ({
	name: "mwdev_parse_compare",
	description:
		"WHAT IS THIS STRING MADE OF — mailwoman's reading against libpostal's, on the same input. `mwdev_compare` " +
		"grades geocoders on a coordinate and libpostal produces none, so an arm there would score a miss on every " +
		"row; this is the only genuinely like-for-like PARSE comparison available, because libpostal IS Pelias's " +
		"parser and `@mailwoman/libpostal` implements its exact `/parse` contract. Both sides are expressed in " +
		"libpostal's label vocabulary using that drop-in's own converter — but the mapping is MANY-TO-ONE " +
		"(neighbourhood + dependent_locality → suburb, macroregion + subregion → state_district, venue + house → " +
		"house), so agreement on a LABEL is not agreement on a TAG; the mailwoman side keeps its original tag and " +
		"collapsed labels are marked. No winner is declared: this says where two parsers read the string differently. " +
		"Photon is deliberately absent — it has no parser at all, and its structured fields are properties of the " +
		"gazetteer row it matched rather than a reading of the input.",
	inputSchema: z.object({
		endpoint: z
			.string()
			.describe(
				"Origin of an ALREADY-RUNNING libpostal /parse service, e.g. http://127.0.0.1:4400. Required and never " +
					"defaulted: this server does not start services, and the shared public instances are refused outright."
			),
		version: z
			.string()
			.describe(
				"Your claim about what is running there. REQUIRED here, unlike elsewhere: `@mailwoman/libpostal` serves " +
					"the identical path with the identical shape, so a port is not evidence of which parser answers, and " +
					"pointing at the wrong one compares mailwoman against mailwoman and reports near-total agreement. " +
					"Recorded as caller-declared, never as observed."
			),
		inputs: INPUT_SET_SCHEMA.optional().describe(
			"Defaults to the full board. Needs no truth — this measures AGREEMENT between two parsers, not correctness, " +
				"so an untruthed corpus is as measurable here as the board."
		),
		config: ENGINE_CONFIG_SCHEMA.optional().describe(
			"The mailwoman side's configuration. Pair with `weights_cache` to ask whether a CANDIDATE model reads a " +
				"string more like libpostal than the shipped one does."
		),
		limit: z.number().int().positive().optional().describe("First N rows of the resolved set."),
	}),
	handler: async (args) => runParseCompare(registry, args),
})
