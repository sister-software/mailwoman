/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The `mwdev_inputs` tool definition — the description an agent reads, the input schema, and the handler wiring.
 *   The measurement itself lives in the package root; this file is the CONTRACT, and the description is the
 *   load-bearing half of it.
 */

import { z } from "zod"

import { resolveInputSet, type InputSetRef } from "../input-sets.ts"
import type { DevTool, DevToolDeps } from "../tool-kit.ts"
import { INPUT_SET_SCHEMA } from "../tool-kit.ts"

export const inputsTool = (_deps: DevToolDeps): DevTool => ({
	name: "mwdev_inputs",
	description:
		"Describe an input set BEFORE measuring it: how many rows, which strata, what kind of truth it carries, " +
		"and — for a slice — what it excluded. Cheap and idempotent; call it first.",
	inputSchema: z.object({
		inputs: INPUT_SET_SCHEMA.optional().describe("Defaults to the full board."),
	}),
	handler: async (args) => {
		const set = await resolveInputSet((args["inputs"] as InputSetRef | undefined) ?? { kind: "board" })
		const byCountry: Record<string, number> = {}
		const byAddressKind: Record<string, number> = {}
		const byStatus: Record<string, number> = {}

		for (const row of set.inputs) {
			if (row.country) {
				byCountry[row.country] = (byCountry[row.country] ?? 0) + 1
			}

			if (row.addressKind) {
				byAddressKind[row.addressKind] = (byAddressKind[row.addressKind] ?? 0) + 1
			}

			if (row.status) {
				byStatus[row.status] = (byStatus[row.status] ?? 0) + 1
			}
		}

		// `any`, never the sum: the per-kind counts overlap, and summing them produced 839 of 558 on the first run.
		const gradeable = set.hasTruth.any

		return {
			set_id: set.setID,
			n: set.n,
			sha256: set.sha256,
			selection: set.selection,
			...(set.populationN === undefined ? {} : { population_n: set.populationN }),
			...(set.why === undefined ? {} : { why: set.why }),
			...(set.corpusHash === undefined ? {} : { corpus_hash: set.corpusHash }),
			strata: { by_country: byCountry, by_address_kind: byAddressKind, by_status: byStatus },
			has_truth: set.hasTruth,
			not_covered: set.notCovered,
			summary:
				`${set.setID}: ${set.n} rows, selection ${set.selection}` +
				(set.populationN ? ` drawn from ${set.populationN}` : "") +
				`. ${gradeable ? `${gradeable} of them carry some expectation` : "NO row carries an expectation, so this set can be observed but not graded"}` +
				`, ${set.hasTruth.none} carry none` +
				` (by kind, overlapping: ${set.hasTruth.components} components, ${set.hasTruth.coordinates} coordinates, ${set.hasTruth.tier} tier).` +
				(set.notCovered.length ? ` Excluded — ${set.notCovered.join("; ")}.` : ""),
			notes: set.notes,
		}
	},
})
