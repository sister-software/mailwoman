/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `mwdev_parse_compare`'s measurement: one input set through mailwoman's parser and one already-running libpostal
 *   `/parse` endpoint, diffed span by span.
 *
 *   Two refusals carry over from `external-arm.ts` unchanged, and the second is sharper here than anywhere else in
 *   this server. Nothing is ever started: an endpoint that is not up is a refusal with the reason, not a run where
 *   every row records libpostal as silent. And an arm's identity is never inferred from a port, because
 *   `@mailwoman/libpostal` answers this exact path with this exact shape — pointing at the wrong port compares
 *   mailwoman against mailwoman and produces a beautifully high agreement rate.
 */

import type { EngineConfig, EngineRegistry } from "./engine-registry.ts"
import { resolveInputSet, type InputSetRef } from "./input-sets.ts"
import {
	diffSpans,
	libpostalClient,
	libpostalSpans,
	mailwomanSpans,
	SpanVerdict,
	type ParseComparisonRow,
} from "./parse-compare.ts"
import { describeObservedRate } from "./power.ts"
import { inputSetProvenance } from "./tool-kit.ts"

export async function runParseCompare(registry: EngineRegistry, args: Record<string, unknown>): Promise<unknown> {
	const endpoint = args["endpoint"] as string | undefined

	if (!endpoint) {
		throw new Error(
			"mwdev_parse_compare needs `endpoint` — the origin of an ALREADY-RUNNING libpostal /parse service, e.g. " +
				"http://127.0.0.1:4400. This server never starts one."
		)
	}

	const version = args["version"] as string | undefined

	if (!version) {
		throw new Error(
			"mwdev_parse_compare needs `version` — your claim about what is running at that endpoint. " +
				"`@mailwoman/libpostal` serves the identical /parse contract, so a URL and a port are not evidence of " +
				"which parser answers there, and a mailwoman-against-mailwoman run reads as near-total agreement."
		)
	}

	const set = await resolveInputSet((args["inputs"] as InputSetRef | undefined) ?? { kind: "board" })
	const config = (args["config"] as EngineConfig | undefined) ?? {}
	const engine = await registry.acquire(config)
	const limit = args["limit"] as number | undefined
	const selected = limit ? set.inputs.slice(0, limit) : set.inputs

	const client = libpostalClient(endpoint)
	const rows: ParseComparisonRow[] = []

	for (const item of selected) {
		const run = await engine.session.geocode(item.input)
		const ours = mailwomanSpans(run.tree)

		let theirs: ReturnType<typeof mailwomanSpans> | null = null
		let libpostalError: string | null = null

		try {
			theirs = await libpostalSpans(client, item.input)
		} catch (error) {
			libpostalError = (error as Error).message
		}

		const diff = theirs ? diffSpans(ours, theirs) : []

		rows.push({
			id: item.id,
			input: item.input,
			mailwoman: ours,
			libpostal: theirs,
			libpostal_error: libpostalError,
			diff,
			// A row libpostal could not answer is not an agreement. Without this it would be one, since an empty diff
			// contains no disagreement.
			agrees: theirs !== null && diff.every((entry) => entry.verdict === SpanVerdict.Agree),
		})
	}

	const answered = rows.filter((row) => row.libpostal !== null)
	const differing = answered.filter((row) => !row.agrees)

	const reading = describeObservedRate({
		events: differing.length,
		n: answered.length,
		selection: limit && limit < set.inputs.length ? "slice" : set.selection,
		eventLabel: "row read differently",
	})

	return {
		provenance: {
			engine_id: engine.engineID,
			tree_fingerprint: engine.fingerprint.digest,
			input_set: inputSetProvenance(set),
			libpostal: { endpoint, version, version_source: "caller-declared" },
		},
		n_requested: selected.length,
		n_evaluated: answered.length,
		n_errored: rows.length - answered.length,
		rows_agreeing: answered.length - differing.length,
		by_label: tallyByLabel(rows),
		rows: differing,
		notes: [
			"Both sides are in libpostal's label vocabulary via `@mailwoman/libpostal`'s own converter. The mapping is " +
				"MANY-TO-ONE (neighbourhood + dependent_locality → suburb, macroregion + subregion → state_district, " +
				"venue + house → house, intersection_a + intersection_b → road), so agreement on a label is not " +
				"agreement on a tag; `collapsed_from` marks the labels where that applies and the mailwoman side keeps " +
				"its original `tag`.",
			"Values compare case-folded: libpostal lowercases its output and mailwoman preserves the input's case.",
			"Only DIFFERING rows are returned; the agreeing ones are in the counts. No winner is declared — this reports " +
				"where two parsers read the string differently, not which is right.",
		],
		summary:
			`${differing.length} of ${answered.length} rows read differently by mailwoman and the libpostal at ` +
			`${endpoint} (declared ${version}). ${reading.sentence}`,
	}
}

/**
 * Which labels the two parsers disagree on, most often first — the question a per-row list cannot answer at board
 * scale.
 */
function tallyByLabel(rows: readonly ParseComparisonRow[]): Array<{ label: string; verdicts: Record<string, number> }> {
	const tally = new Map<string, Record<string, number>>()

	for (const row of rows) {
		for (const entry of row.diff) {
			const verdicts = tally.get(entry.label) ?? {}

			verdicts[entry.verdict] = (verdicts[entry.verdict] ?? 0) + 1

			tally.set(entry.label, verdicts)
		}
	}

	return [...tally.entries()]
		.map(([label, verdicts]) => ({ label, verdicts }))
		.toSorted((a, b) => disagreements(b.verdicts) - disagreements(a.verdicts) || a.label.localeCompare(b.label))
}

function disagreements(verdicts: Record<string, number>): number {
	return Object.entries(verdicts)
		.filter(([verdict]) => verdict !== SpanVerdict.Agree)
		.reduce((total, [, count]) => total + count, 0)
}
