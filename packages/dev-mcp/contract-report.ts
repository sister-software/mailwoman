/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `mwdev_contract`'s measurement: parse an input set, validate each tree against the decoder's own structural
 *   contract, and report which violation classes fire — including the ones that do not.
 *
 *   The tree validated is `GeocodeRun.tree`, which is the tree AS THE RESOLVER SEES IT — after the postcode and
 *   stranded-affix repairs. So this counts what SURVIVES the repairs rather than what the raw decode emitted, which is
 *   the number that matters: a violation the repairs already clean up costs a consumer nothing.
 */

import { censusTrees, type ContractRow } from "#contract-census"
import type { EngineConfig, EngineRegistryLike } from "#engine-registry"
import { resolveInputSet, type InputSetRef } from "#input-sets"
import { describeObservedRate } from "#power"
import { provenanceFor } from "#tool-kit"

export async function runContractCensus(registry: EngineRegistryLike, args: Record<string, unknown>): Promise<unknown> {
	const set = await resolveInputSet((args["inputs"] as InputSetRef | undefined) ?? { kind: "board" })
	const config = (args["config"] as EngineConfig | undefined) ?? {}
	const engine = await registry.acquire(config)
	const limit = args["limit"] as number | undefined
	const selected = limit ? set.inputs.slice(0, limit) : set.inputs

	const rows: ContractRow[] = []
	const errored: string[] = []

	for (const item of selected) {
		try {
			const run = await engine.session.geocode(item.input)

			rows.push({ id: item.id, input: item.input, tree: run.tree })
		} catch {
			// A row the engine cannot parse contributes NOTHING to any tally: counting it as valid would manufacture
			// contract compliance out of a crash.
			errored.push(item.id)
		}
	}

	const census = censusTrees(rows)

	const reading = describeObservedRate({
		events: census.rows_violating,
		n: census.n_evaluated,
		selection: limit && limit < set.inputs.length ? "slice" : set.selection,
		eventLabel: "structurally invalid tree",
	})

	return {
		provenance: provenanceFor(engine, set),
		n_requested: selected.length,
		n_evaluated: census.n_evaluated,
		n_errored: errored.length,
		errored_ids: errored.slice(0, 10),
		rows_violating: census.rows_violating,
		classes: census.classes,
		stranding: census.stranding,
		never_produced: census.never_produced,
		illegal_edges: census.illegal_edges,
		duplicate_tags: census.duplicate_tags,
		notes: [
			"validated on GeocodeRun.tree — AFTER the postcode and stranded-affix repairs, so this counts what survives " +
				"them rather than what the raw decode emitted",
			"`intersection_a`/`intersection_b` are deliberately NOT strict dependents: a bare `Main St and 5th Ave` " +
				"query is a valid degenerate parse, and a rule firing on it as well as on `Elephant and Castle Road` " +
				"separates neither",
		],
		summary: summarize(census, reading.sentence),
	}
}

function summarize(census: ReturnType<typeof censusTrees>, powerSentence: string): string {
	if (!census.n_evaluated) return `Nothing was evaluated, so no contract claim can be made. ${powerSentence}`

	const worst = census.stranding.find((entry) => entry.stranded > 0)

	const strandSentence = worst
		? `Worst stranding: ${worst.tag}, ${worst.stranded} of ${worst.produced_on_rows} rows that produced it ` +
			`(${((worst.stranding_rate ?? 0) * 100).toFixed(1)}%).`
		: "No strict dependent was stranded on any row."

	// A table of tags at zero reads as a clean bill of health; for a tag no row ever produced, it is not one.
	const blindSentence = census.never_produced.length
		? ` ${census.never_produced.length} strict dependents never appeared at all (${census.never_produced.join(", ")}), ` +
			"so their zero stranding counts measure nothing."
		: ""

	const duplicateSentence = census.duplicate_tags.rows
		? ` ${census.duplicate_tags.rows} of ${census.n_evaluated} rows contained a duplicate tag ` +
			`(${((census.duplicate_tags.rate ?? 0) * 100).toFixed(1)}%); see duplicate_tags for topology.`
		: ` 0 of ${census.n_evaluated} rows contained a duplicate tag.`

	return (
		`${census.rows_violating} of ${census.n_evaluated} rows produced a structurally invalid tree. ` +
		`${strandSentence}${blindSentence}${duplicateSentence} ${census.illegal_edges.note} ${powerSentence}`
	)
}
