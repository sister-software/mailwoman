/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The `mwdev_lookup` tool definition — the description an agent reads, the input schema, and the handler wiring.
 *   The measurement itself lives in the package root; this file is the CONTRACT, and the description is the
 *   load-bearing half of it.
 */

import { z } from "zod"

import type { EngineConfig } from "../engine-registry.ts"
import { runLookup } from "../lookup-tool.ts"
import { LookupSource } from "../lookup.ts"
import type { DevTool, DevToolDeps } from "../tool-kit.ts"
import { ENGINE_CONFIG_SCHEMA } from "../tool-kit.ts"

export const lookupTool = ({ registry, jobs }: DevToolDeps): DevTool => ({
	name: "mwdev_lookup",
	description:
		"Ask a data source directly whether it knows a string. Keeps ABSENCE (the source has no entry) apart from " +
		"a MEASURED ZERO (it has one, scored zero) and from a hit that carries nothing actionable — the " +
		"distinction most resolve failures turn on. Every gazetteer source keys on a NORMALIZED form, not the " +
		"string you type, and reports the key it used beside what it found.",
	inputSchema: z.object({
		source: z.enum([
			LookupSource.FST,
			LookupSource.StreetMorphology,
			LookupSource.Normalize,
			LookupSource.Candidate,
			LookupSource.WOF,
			LookupSource.POI,
			LookupSource.Codex,
			LookupSource.Postcode,
		]),
		queries: z.array(z.string()).min(1).max(50),
		locale: z
			.string()
			.optional()
			.describe(
				"`normalize`: the normalization locale, default `und`. `postcode`: which weights package's anchor " +
					"artifact to read, default `en-us`. Ignored elsewhere."
			),
		country: z
			.string()
			.optional()
			.describe(
				"ISO alpha-2 filter for `candidate` and `poi`. A key that exists but has no row in this country is " +
					"reported as a FILTER miss, never as an absence."
			),
		limit: z.number().int().positive().max(100).optional().describe("Rows per query; the count is always exact."),
		config: ENGINE_CONFIG_SCHEMA.optional().describe(
			"Selects WHICH artifacts to read — `candidate_db`, `resolve_db`, `data_root`, and for the FST sources the " +
				"weights package. `gazetteer_prior` is forced on for those two, since a session resolves the FST path " +
				"only when it would feed the prior."
		),
	}),
	handler: async (args) =>
		runLookup(registry, {
			source: args["source"] as LookupSource,
			queries: args["queries"] as string[],
			...(args["locale"] === undefined ? {} : { locale: args["locale"] as string }),
			...(args["country"] === undefined ? {} : { country: args["country"] as string }),
			...(args["limit"] === undefined ? {} : { limit: args["limit"] as number }),
			...(args["config"] === undefined ? {} : { config: args["config"] as EngineConfig }),
		}),
})
