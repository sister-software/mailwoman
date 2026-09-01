/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The `mwdev_inputs` tool definition — the description an agent reads, the input schema, and the handler wiring.
 *   The measurement itself lives in the package root; this file is the CONTRACT, and the description is the
 *   required half of it.
 */

import { z } from "zod"

import { resolveInputSet, type InputSetRef } from "#input-sets"
import type { DevTool, DevToolDeps } from "#tool-kit"
import { INPUT_SET_SCHEMA } from "#tool-kit"

export const inputsTool = (_deps: DevToolDeps): DevTool => ({
	name: "mwdev_inputs",
	description:
		"Describe an input set BEFORE measuring it: how many rows, which strata, what kind of truth it carries, " +
		"and — for a slice — what it excluded. Cheap and idempotent; call it first. `matching` additionally answers " +
		"CLASS SIZE — how many rows carry a given surface shape, and which — which is the number a defect report is " +
		"worth nothing without, and the one most often asserted rather than counted.",
	inputSchema: z.object({
		inputs: INPUT_SET_SCHEMA.optional().describe("Defaults to the full board."),
		matching: z
			.string()
			.min(1)
			.optional()
			.describe(
				"JavaScript regular expression, tested against each row's INPUT string (case-insensitive, unicode). " +
					"Returns the count and the matching ids. Use it to size a class before proposing a fix for it — and " +
					"read the answer as a fact about THIS SET: the board is curated against known failure modes, so its " +
					"rate for a defect it was authored for is not production's."
			),
	}),

	handler: async (args) => {
		const set = await resolveInputSet((args["inputs"] as InputSetRef | undefined) ?? { kind: "board" })
		const pattern = args["matching"] as string | undefined

		let matched: Array<{ id: string; input: string }> | undefined

		if (pattern !== undefined) {
			let expression: RegExp

			try {
				expression = new RegExp(pattern, "iu")
			} catch (error) {
				// A malformed pattern must not read as "nothing matches" — that is a zero the caller would act on.
				throw new Error(`mwdev_inputs: \`matching\` is not a valid regular expression: ${(error as Error).message}`)
			}

			matched = set.inputs.filter((row) => expression.test(row.input)).map((row) => ({ id: row.id, input: row.input }))
		}

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
			...(matched === undefined
				? {}
				: {
						matching: {
							pattern,
							n: matched.length,
							of: set.n,
							rows: matched,
						},
					}),
			summary:
				`${set.setID}: ${set.n} rows, selection ${set.selection}` +
				(set.populationN ? ` drawn from ${set.populationN}` : "") +
				`. ${gradeable ? `${gradeable} of them carry some expectation` : "NO row carries an expectation, so this set can be observed but not graded"}` +
				`, ${set.hasTruth.none} carry none` +
				` (by kind, overlapping: ${set.hasTruth.components} components, ${set.hasTruth.coordinates} coordinates, ${set.hasTruth.tier} tier).` +
				(set.notCovered.length ? ` Excluded — ${set.notCovered.join("; ")}.` : "") +
				(matched === undefined
					? ""
					: ` ${matched.length} of ${set.n} rows match /${pattern}/i — a count over THIS set, which is not a` +
						" production rate."),
			notes: set.notes,
		}
	},
})
