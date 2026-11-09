/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The `parallelMapWorkers` handler behind `parsePipelineRows`. Each worker thread loads one classifier and one
 *   runtime pipeline, then parses the rows dispatched to it and returns every parsed node as a span, in source order,
 *   with the query kind the pipeline assigned.
 */

import { walkNodes } from "@mailwoman/core/decoder"
import { workerUserData } from "@mailwoman/core/workers"
import { NeuralAddressClassifier } from "@mailwoman/neural"

import { createRuntimePipeline } from "#runtime-pipeline"
import type { BatterySpan } from "#tools/eval-harness/battery/classify"

/**
 * What every worker receives.
 */
export interface PipelineParseWorkerData {
	/**
	 * The weights locale the classifier loads, such as `en-US`.
	 */
	locale: string
	/**
	 * A package-shaped weights cache, or `null` for the installed weights packages.
	 */
	cacheRoot: string | null
	intraOpNumThreads: number
	/**
	 * The address-system conventions the classifier loads with: `declared` follows the model card.
	 */
	conventions: "declared" | "off" | "auto"
}

/**
 * One row handed to a worker: the identity its parse is returned under, the text,
 * and the country passed as the pipeline's locale hint, or `null` to parse without one.
 */
export interface PipelineParseRow {
	id: string
	raw: string
	localeHint: string | null
}

/**
 * One row's parse: every node as a span in source order, and the pipeline's query kind.
 */
export interface PipelineParse {
	id: string
	spans: BatterySpan[]
	kind: string | null
}

const { locale, cacheRoot, intraOpNumThreads, conventions } = workerUserData<PipelineParseWorkerData>()

const classifier = await NeuralAddressClassifier.loadFromWeights({
	locale,
	intraOpNumThreads,
	...(cacheRoot ? { cacheRoot } : {}),
	addressSystemConventions: conventions,
})

const parse = createRuntimePipeline({ classifier })

/**
 * Parses one row.
 */
export async function handleItem(row: PipelineParseRow): Promise<PipelineParse> {
	const result = await parse(row.raw, row.localeHint ? { localeHint: row.localeHint } : {})

	const spans = [...walkNodes(result.tree?.roots ?? [])]
		.map((node): BatterySpan => [node.tag, node.start, node.end, node.value])
		.toSorted((a, b) => a[1] - b[1])

	return { id: row.id, spans, kind: result.kind?.kind ?? null }
}
