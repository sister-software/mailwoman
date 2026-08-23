/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The `mwdev_run` tool definition — the description an agent reads, the input schema, and the handler wiring.
 *   The measurement itself lives in the package root; this file is the CONTRACT, and the description is the
 *   load-bearing half of it.
 */

import { haversineKm } from "@mailwoman/spatial"
import { z } from "zod"

import type { EngineConfig } from "../engine-registry.ts"
import { resolveInputSet, type InputSetRef } from "../input-sets.ts"
import { describeObservedRate } from "../power.ts"
import { tallyPaths } from "../tally.ts"
import type { DevTool, DevToolDeps } from "../tool-kit.ts"
import { ENGINE_CONFIG_SCHEMA, INPUT_SET_SCHEMA, componentsOf, provenanceFor } from "../tool-kit.ts"

/**
 * The per-row fields `mwdev_run` can emit, in emission order.
 *
 * A full board is 558 rows and its `components` map dominates the payload — the unprojected result measured 169,649
 * characters, which overflows a tool reply and spills to a file, so the caller reads it back through `jq` instead of
 * reading it. Everything an A/B diff needs is `id` plus `lat`/`lon`/`tier`. The list is ordered so a projected row
 * keeps a stable key order regardless of the order the caller asked in.
 */
const RUN_ROW_FIELDS = [
	"id",
	"input",
	"components",
	"lat",
	"lon",
	// Haversine kilometres from the row's TRUTH point, for the sets that carry one — board, panel, golden,
	// parity, and a literal set whose caller pinned coordinates. `null` on a row with no truth AND on a row
	// that resolved nothing, which are different facts: read it beside `lat`.
	"km",
	"tier",
	"admin_coherence",
	"hierarchy",
	"timing_ms",
] as const

type RunRowField = (typeof RUN_ROW_FIELDS)[number]

export const runTool = ({ registry }: DevToolDeps): DevTool => ({
	name: "mwdev_run",
	description:
		"Geocode an input set through a warm engine. Defaults to the FULL regression board — pass a literal set " +
		"only with a reason, and the result will carry that reason and its confidence bound. PATH CAVEAT (#1669): " +
		"engines here run ONE config (default locale en-US) — the out-of-the-box path; the gauntlet HARNESS " +
		"additionally wires each row's country overlay, so a foreign row's verdict here can differ from the " +
		"board's (they coincide on US rows).",
	inputSchema: z.object({
		inputs: INPUT_SET_SCHEMA.optional(),
		config: ENGINE_CONFIG_SCHEMA.optional(),
		limit: z
			.number()
			.int()
			.positive()
			.optional()
			.describe("Cap on rows evaluated. Never the default; reported against the set's real n."),
		fields: z
			.array(z.enum(RUN_ROW_FIELDS))
			.min(1)
			.optional()
			.describe(
				"Which per-row fields to emit. Omit for all of them. `components` is by far the largest — dropping " +
					"it is the difference between a full board fitting in a reply and spilling to a file. `id` and " +
					"`lat`/`lon`/`tier` are what an A/B diff needs."
			),
		tally: z
			.array(z.string().min(1))
			.max(8)
			.optional()
			.describe(
				'Dotted paths to COUNT distinct values of across all evaluated rows, e.g. ["admin_coherence.region", ' +
					'"tier"]. Each tally sums to the evaluated row count; rows missing the path count under "~absent" ' +
					'rather than being skipped. Pair with a narrow `fields` (or fields: ["id"]) to get a census ' +
					"without a row dump — this replaces the hand-rolled recount scripts."
			),
	}),
	handler: async (args) => {
		const ref = (args["inputs"] as InputSetRef | undefined) ?? { kind: "board" }
		const config = (args["config"] as EngineConfig | undefined) ?? {}
		const limit = args["limit"] as number | undefined
		const fields = args["fields"] as RunRowField[] | undefined
		const keep = fields ? new Set<RunRowField>(fields) : undefined

		const set = await resolveInputSet(ref)
		const engine = await registry.acquire(config)
		const selected = limit ? set.inputs.slice(0, limit) : set.inputs

		const startedAt = Date.now()
		const rows: unknown[] = []
		const fullRows: unknown[] = []
		const tallyRequest = args["tally"] as string[] | undefined
		const errors: Array<{ id: string; input: string; message: string }> = []
		// Counted as rows are produced. Reading it back off `rows` would make the headline number depend on
		// whether the caller happened to project `lat` — a measurement quietly changing with a display option.
		let resolved = 0

		for (const item of selected) {
			try {
				const run = await engine.session.geocode(item.input)

				const row: Record<RunRowField, unknown> = {
					id: item.id,
					input: item.input,
					components: componentsOf(run),
					lat: run.result.lat,
					lon: run.result.lon,
					km:
						item.truthLat === undefined ||
						item.truthLon === undefined ||
						run.result.lat === null ||
						run.result.lon === null
							? null
							: haversineKm(run.result.lat, run.result.lon, item.truthLat, item.truthLon),
					tier: run.result.resolution_tier,
					admin_coherence: run.result.admin_coherence ?? null,
					// The resolved winner identities (name + placeID per rung) — what the chimera triage (#1731)
					// otherwise drops to the CLI for. Coordinate diffs alone cannot see a wrong-instance win.
					hierarchy: run.result.hierarchy ?? null,
					timing_ms: run.timing,
				}

				// `lat` is read below for the resolved count, so projection cannot drop it from the value the
				// handler reasons over — only from what is emitted. Filtering here rather than at return keeps
				// that separation in one place. Tallies count over `fullRows` for the same reason: a census must
				// not change with a display option.
				fullRows.push(row)

				rows.push(keep ? Object.fromEntries(RUN_ROW_FIELDS.filter((f) => keep.has(f)).map((f) => [f, row[f]])) : row)

				resolved += run.result.lat === null ? 0 : 1
			} catch (error) {
				errors.push({ id: item.id, input: item.input, message: (error as Error).message })
			}
		}

		const resolvedCount = resolved

		const power = describeObservedRate({
			events: resolvedCount,
			n: rows.length,
			selection: set.selection,
			eventLabel: "resolved to a coordinate",
			...(set.populationN === undefined ? {} : { populationN: set.populationN }),
		})

		return {
			...(tallyRequest?.length
				? {
						tallies: tallyPaths(fullRows, tallyRequest),
						tallies_note:
							"Each tally sums to n_evaluated; '~absent' counts rows where the path does not exist, and " +
							"'null' is a value a row explicitly carried — different claims, never merged.",
					}
				: {}),
			provenance: provenanceFor(engine, set),
			summary:
				power.sentence +
				(limit ? ` A limit of ${limit} was applied to a set of ${set.n}.` : "") +
				(set.why ? ` Hand-picked because: ${set.why}` : ""),
			n_requested: selected.length,
			n_evaluated: rows.length,
			...(keep ? { fields_emitted: RUN_ROW_FIELDS.filter((f) => keep.has(f)) } : {}),
			n_errored: errors.length,
			errors,
			power,
			elapsed_ms: Date.now() - startedAt,
			rows,
		}
	},
})
