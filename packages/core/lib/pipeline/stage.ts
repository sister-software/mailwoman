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
 * The identifier of each stage of the parse pipeline, spelled as its timing keys were first published.
 * A timing record keys a stage's duration by its identifier.
 *
 * A package that runs stages of its own declares their identifiers beside them,
 * as `GeocodeStageID` in `mailwoman` does, so a new stage there changes zero lines here.
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
} as const

/**
 * One of the {@link StageID} values.
 */
export type StageID = (typeof StageID)[keyof typeof StageID]

/**
 * The two stages a fault spells differently from the stage's identifier.
 *
 * `mailwoman parse` prints a fault's `stage`, so each spelling stays as it was first published.
 */
const FAULT_STAGE_SPELLINGS: Readonly<Record<string, string>> = {
	[StageID.TokenClassify]: "classifier",
	[StageID.Resolve]: "resolver",
}

/**
 * A stage of the parse pipeline as a fault spells it: `classifier` for the decode,
 * `resolver` for the resolve, and the stage's identifier for every other stage.
 */
export type PipelineFaultStage =
	| Exclude<StageID, typeof StageID.TokenClassify | typeof StageID.Resolve>
	| "classifier"
	| "resolver"

/**
 * One failure that a request caught and degraded past.
 *
 * `runPipeline` still resolves.
 * `tree` contains whatever the remaining stages could prove.
 *
 * @typeParam Stage The spellings of the stages that can fault.
 * The parse pipeline's result states {@link PipelineFaultStage}, and a context with stages of another package states `string`.
 */
export interface PipelineFault<Stage extends string = string> {
	/**
	 * The stage that threw, as a fault spells it.
	 */
	stage: Stage
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
	/**
	 * The identifier of the stage that rewrote the tree.
	 */
	stage: string
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
 * @typeParam FaultStage The spellings of the stages whose failures the request records.
 */
export interface RequestContext<Trace = StageRecord, FaultStage extends string = string> {
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
	 * Whether a stage also writes the records that cost work to build, such as the
	 * outlines of a tree rewrite or the decoder's trace.
	 *
	 * A stage writes a record it already holds, such as a decision it made, whenever {@link trace} is set.
	 */
	readonly detail: boolean

	/**
	 * The milliseconds each stage has taken, summed when a stage runs more than once.
	 */
	readonly timing: PipelineTiming

	/**
	 * Every failure the request caught and degraded past, in order.
	 */
	readonly faults: PipelineFault<FaultStage>[]
}

/**
 * Builds the context of one request.
 *
 * `detail` defaults to whether the request has a trace, so a caller states it only to
 * receive the records a stage already holds without the costly ones.
 */
export function createRequestContext<Trace = StageRecord, FaultStage extends string = string>(
	init: { signal?: AbortSignal | null; trace?: ((record: Trace) => void) | null; detail?: boolean } = {}
): RequestContext<Trace, FaultStage> {
	const trace = init.trace ?? null

	return { signal: init.signal ?? null, trace, detail: init.detail ?? trace != null, timing: {}, faults: [] }
}

/**
 * Records a failure the request degrades past, under `stage`.
 *
 * The runner calls it for a stage that declares `recover`.
 * A stage calls it for a failure of work the answer doesn't depend on, such as building a trace.
 */
export function recordFault(context: Pick<RequestContext<never>, "faults">, stage: string, cause: unknown): void {
	context.faults.push({
		stage,
		name: cause instanceof Error ? cause.name : "Error",
		message: errorMessage(cause),
		cause,
	})
}

/**
 * One step of a pipeline.
 *
 * @typeParam Input What the stage reads.
 * @typeParam Output What the stage returns.
 * @typeParam Trace The records the stage writes.
 * @typeParam ID The stage identifiers of the pipeline the stage belongs to.
 */
export interface PipelineStage<Input, Output, Trace = StageRecord, ID extends string = string> {
	/**
	 * The stage's identifier.
	 * The context's timing keys the stage's duration by it.
	 */
	readonly id: ID
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
 * `abortKindOf` in `#async/abort` reads that reason's kind.
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

		recordFault(context, FAULT_STAGE_SPELLINGS[stage.id] ?? stage.id, error)

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
 * It writes a {@linkcode TreeRewriteRecord} only when the request traces in detail
 * and the tree's outline changed.
 * The rewrite may change the tree in place, so the stage reads the outline before the rewrite runs.
 */
export function treeRewriteStage<ID extends string>(
	id: ID,
	rewrite: (tree: AddressTree) => AddressTree
): PipelineStage<AddressTree, AddressTree, TreeRewriteRecord, ID> {
	return {
		id,
		run(tree, context) {
			if (!context.trace || !context.detail) return rewrite(tree)

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
