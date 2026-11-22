// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   A pipeline stage, the context every stage of one request reads, and the runner.
 *
 *   A stage is an object with an `id` and a `run` function.
 *   The runner checks the abort signal, times the stage and captures its fault,
 *   so a stage does none of the three.
 *
 *   The parse pipeline and the geocode path run their stages through {@linkcode runStage}.
 */

import { decodeAsOutlineLines } from "#decoder/serialize/outline"
import type { AddressTree } from "#decoder/types"
import { errorMessage } from "#errors/schema"
import type { PipelineTiming } from "#pipeline/types"

/**
 * The identifier of each stage.
 * A timing record keys the stage's duration by it.
 *
 * The first ten are the parse pipeline's, spelled as its timing keys were first published.
 * The last four are the tree rewrites the geocode path runs after its decode.
 */
export const StageID = {
	Normalize: "normalize",
	PlaceCountry: "place-country",
	QueryShape: "query-shape",
	LocaleHint: "locale-hint",
	KindClassifier: "kind-classifier",
	POIIntent: "poi-intent",
	PhraseGrouper: "phrase-grouper",
	TokenClassify: "token-classify",
	GrouperAudit: "grouper-audit",
	Resolve: "resolve",
	RegionRecognition: "region-recognition",
	BarePostcode: "bare-postcode",
	PostcodeContradiction: "postcode-contradiction",
	StrandedAffix: "stranded-affix",
} as const

/**
 * One of the {@link StageID} values.
 */
export type StageID = (typeof StageID)[keyof typeof StageID]

/**
 * The two stages a fault spells differently from the stage's identifier.
 *
 * `mailwoman parse --json` prints a fault's `stage`, so each spelling stays as it was first published.
 */
const FAULT_STAGE_SPELLINGS: Partial<Record<StageID, "classifier" | "resolver">> = {
	[StageID.TokenClassify]: "classifier",
	[StageID.Resolve]: "resolver",
}

/**
 * A stage as a fault spells it: `classifier`, `resolver`, or the identifier of any other stage.
 */
export type PipelineFaultStage =
	| Exclude<StageID, typeof StageID.TokenClassify | typeof StageID.Resolve>
	| "classifier"
	| "resolver"

function faultStageOf(id: StageID): PipelineFaultStage {
	return FAULT_STAGE_SPELLINGS[id] ?? (id as PipelineFaultStage)
}

/**
 * One stage crash that the runner caught and degraded past.
 *
 * `runPipeline` still resolves.
 * `tree` contains whatever the remaining stages could prove.
 */
export interface PipelineFault {
	stage: PipelineFaultStage
	/**
	 * The thrown value's `name`, or `"Error"` when something that isn't an `Error` was thrown.
	 *
	 * It is machine-stable enough to branch on, with the `cause` carrying the rest.
	 */
	name: string
	message: string
	/**
	 * The value the stage threw, verbatim: not JSON-serializable in the useful sense,
	 * so serialize `stage`/`name`/`message` when you need this on a wire.
	 */
	cause: unknown
}

/**
 * What a stage that rewrites the parse tree changed, as outline lines of the tree.
 *
 * A line reads `tag [start, end): "value"` with the node's metadata after it, indented two
 * spaces for each level, so a node that only moved under another parent appears in both lists.
 */
export interface TreeRewriteRecord {
	kind: "tree-rewrite"
	stage: StageID
	/**
	 * The lines the tree had before the stage and lacks after it.
	 */
	removed: string[]
	/**
	 * The lines the tree has after the stage and lacked before it.
	 */
	added: string[]
}

/**
 * A record that a stage of this package writes to a request's trace.
 */
export type StageRecord = TreeRewriteRecord

/**
 * What every stage of one request reads and writes.
 *
 * @typeParam Trace The records the request's stages write.
 */
export interface RequestContext<Trace = StageRecord> {
	/**
	 * The signal that cancels the request, or null for a request that can't be cancelled.
	 */
	readonly signal: AbortSignal | null

	/**
	 * Receives each record a stage writes, or null when the request records none.
	 *
	 * A stage builds a record only after it has read a sink here.
	 */
	readonly trace: ((record: Trace) => void) | null

	/**
	 * The milliseconds each stage has taken, summed when a stage runs more than once.
	 */
	readonly timing: PipelineTiming

	/**
	 * Every stage crash the runner caught and degraded past, in order.
	 */
	readonly faults: PipelineFault[]
}

/**
 * Builds the context of one request.
 */
export function createRequestContext<Trace = StageRecord>(
	init: { signal?: AbortSignal | null; trace?: ((record: Trace) => void) | null } = {}
): RequestContext<Trace> {
	return { signal: init.signal ?? null, trace: init.trace ?? null, timing: {}, faults: [] }
}

/**
 * One step of a pipeline.
 *
 * @typeParam Input What the stage reads.
 * @typeParam Output What the stage returns.
 * @typeParam Trace The records the stage writes.
 */
export interface PipelineStage<Input, Output, Trace = StageRecord> {
	readonly id: StageID
	run(input: Input, context: RequestContext<Trace>): Output | Promise<Output>

	/**
	 * The output the pipeline continues with when `run` throws.
	 *
	 * The runner records a fault for a stage that declares it, and rethrows for a stage that leaves it out.
	 */
	recover?(input: Input): Output
}

/**
 * Runs one stage: checks the abort signal, runs the stage, and adds its duration to the context's timing.
 *
 * An aborted request rejects with the signal's reason, the value the cancelling code aborted with.
 * `abortKindOf` in `#abort` reads that reason's kind.
 *
 * The signal is checked before the stage, so a running stage finishes first.
 *
 * A stage that declares `recover` and throws has a fault recorded, and the run
 * continues with the recovered output.
 */
export async function runStage<Input, Output, Trace>(
	stage: PipelineStage<Input, Output, Trace>,
	input: Input,
	context: RequestContext<Trace>
): Promise<Output> {
	if (context.signal?.aborted) {
		throw context.signal.reason ?? new DOMException("Pipeline aborted", "AbortError")
	}

	const startedAt = performance.now()

	try {
		return await stage.run(input, context)
	} catch (error) {
		if (!stage.recover) throw error

		context.faults.push({
			stage: faultStageOf(stage.id),
			name: error instanceof Error ? error.name : "Error",
			message: errorMessage(error),
			cause: error,
		})

		return stage.recover(input)
	} finally {
		context.timing[stage.id] = (context.timing[stage.id] ?? 0) + (performance.now() - startedAt)
	}
}

/**
 * Runs stages in order, each reading the output of the stage before it.
 */
export async function runStages<Value, Trace>(
	stages: readonly PipelineStage<Value, Value, Trace>[],
	input: Value,
	context: RequestContext<Trace>
): Promise<Value> {
	let value = input

	for (const stage of stages) {
		value = await runStage(stage, value, context)
	}

	return value
}

/**
 * A stage that rewrites the parse tree and writes what it changed to the trace.
 *
 * It writes a {@linkcode TreeRewriteRecord} only when the request has a trace
 * and the tree's outline changed.
 * The rewrite may change the tree in place, so the stage reads the outline before the rewrite runs.
 */
export function treeRewriteStage(
	id: StageID,
	rewrite: (tree: AddressTree) => AddressTree
): PipelineStage<AddressTree, AddressTree, TreeRewriteRecord> {
	return {
		id,
		run(tree, context) {
			if (!context.trace) return rewrite(tree)

			const before = decodeAsOutlineLines(tree, { metadata: true })
			const rewritten = rewrite(tree)
			const after = decodeAsOutlineLines(rewritten, { metadata: true })
			const removed = before.filter((line) => !after.includes(line))
			const added = after.filter((line) => !before.includes(line))

			if (removed.length || added.length) {
				context.trace({ kind: "tree-rewrite", stage: id, removed, added })
			}

			return rewritten
		},
	}
}
