/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The `mwdev_lookup` tool definition — the description an agent reads, the input schema, and the handler wiring.
 *   The measurement itself lives in the package root; this file is the CONTRACT, and the description is the
 *   required half of it.
 */

import { z } from "zod"

import type { EngineConfig } from "../engine-registry.ts"
import { runLookup } from "../lookup-tool.ts"
import { LookupSource } from "../lookup.ts"
import type { DevTool, DevToolDeps } from "../tool-kit.ts"
import { ENGINE_CONFIG_SCHEMA } from "../tool-kit.ts"

export const lookupTool = async ({ registry }: DevToolDeps): Promise<DevTool> => ({
	name: "mwdev_lookup",
	description:
		"Ask a data source directly whether it knows a string. Keeps ABSENCE (the source has no entry) apart from " +
		"a MEASURED ZERO (it has one, scored zero) and from a hit that carries nothing actionable — the " +
		"distinction most resolve failures turn on. Every gazetteer source keys on a NORMALIZED form, not the " +
		"string you type, and reports the key it used beside what it found. The `candidate` source carries the " +
		"fame-diagnosis extras: each row's `name_role` stamp and the score source's `importance_split` " +
		"(referential/encyclopedic beside the blend), and `compare_candidate_db` runs the same queries against a " +
		"second artifact with a per-query delta — the staged-vs-live probe, without a script.",
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
		queries: z.array(z.string()).min(1).max(100),
		locales: z
			.array(z.string())
			.min(1)
			.max(12)
			.optional()
			.describe(
				"FST sources only — sweep the SAME queries across each locale's own artifact, answering per locale instead " +
					"of once. This is the shape a degenerate-surface audit needs: do function words (`la`, `de`, `van`) or " +
					"street-type words (`boulevard`, `rue`, `strasse`) accept as locality-ish entries, and in which locales? " +
					"Each locale costs a full session build, so this is an occasional measurement rather than a probe. A " +
					"locale whose overlay ships no FST reports its own absence in place rather than dropping out."
			),
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
		compare_candidate_db: z
			.string()
			.optional()
			.describe(
				"`candidate` only — a second candidate.db to run the SAME queries against. The result adds `rows_compare` " +
					"and per-query `deltas`: rows only one artifact holds, and shared rows whose ranking fields " +
					"(importance, population, is_primary, name_role) moved. Deltas cover the returned rows, so raise " +
					"`limit` for a deep key."
			),
		config: ENGINE_CONFIG_SCHEMA.optional().describe(
			"Selects WHICH artifacts to read — `candidate_db`, `resolve_db`, `data_root`, and for the FST sources the " +
				"weights package. `gazetteer_prior` is forced on for those two, since a session resolves the FST path " +
				"only when it would feed the prior."
		),
	}),
	handler: async (args) =>
		await runLookup(registry, {
			source: args["source"] as LookupSource,
			queries: args["queries"] as string[],
			...(args["locale"] === undefined ? {} : { locale: args["locale"] as string }),
			...(args["locales"] === undefined ? {} : { locales: args["locales"] as string[] }),
			...(args["country"] === undefined ? {} : { country: args["country"] as string }),
			...(args["limit"] === undefined ? {} : { limit: args["limit"] as number }),
			...(args["config"] === undefined ? {} : { config: args["config"] as EngineConfig }),
			...(args["compare_candidate_db"] === undefined
				? {}
				: { compareCandidateDB: args["compare_candidate_db"] as string }),
		}),
})
