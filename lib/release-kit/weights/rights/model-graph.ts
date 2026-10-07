/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file What a shipped model graph can emit, read from the graph rather than from its card.
 *
 *   A rights review asks whether a model can reproduce its training data. For this architecture the
 *   The graph's output signature supports the answer. The model maps a token sequence to label logits
 *   and a locale classification. Its supported inference interface returns no characters, vocabulary
 *   tokens, or address text.
 *
 *   That claim belongs beside the artifact rather than in a review document, because it is a property of
 *   the file and a later build can change it. The model card states `num_labels`, and a card is a claim
 *   about the graph rather than the graph. This reads the graph.
 *
 *   **This describes the supported inference interface.** It does not establish that reconstruction is
 *   impossible. A white-box extraction or inversion attack over the weights differs from what a caller
 *   can obtain by running the model. A reader of this record must keep those questions separate.
 */

import { pathExists } from "@mailwoman/core/fs/readers"
import type { PathBuilderLike } from "path-ts"

/**
 * The filename a weights package uses for its own model graph.
 */
export const MODEL_GRAPH_FILE = "model.onnx"

/**
 * One output of a model graph, as the runtime reports it.
 *
 * Local because `ModelGraphRecord` is the shape a caller holds.
 * A caller naming a single output separately would be reading one output in isolation,
 * where the question this module answers is what the whole signature permits.
 */
interface ModelGraphOutput {
	name: string
	/**
	 * The element type, such as `float32`.
	 */
	type: string
	/**
	 * The declared shape, where a string entry is a symbolic dimension such as `sequence`.
	 */
	shape: Array<number | string>
}

/**
 * The output signature of a shipped model graph.
 */
export interface ModelGraphRecord {
	format: "ONNX"
	outputs: ModelGraphOutput[]
	/**
	 * Whether any output's element type and shape could encode emitted text.
	 *
	 * False for a graph whose outputs are fixed-width logit tensors.
	 * A reader uses it to answer "can running this model return source text", and no stronger question.
	 */
	textEmittingOutput: boolean
	/**
	 * Why the graph could not be read, where it could not be.
	 *
	 * A record that states no outputs and no reason would read as a graph with no outputs.
	 */
	unreadable: string | null
}

/**
 * Element types a text-emitting output would use.
 *
 * A graph that emitted tokens would return integer token ids or strings.
 * A float logit tensor over a fixed label count cannot encode them.
 * That type and shape distinction makes the check mechanical.
 */
const TEXT_CAPABLE_TYPES: ReadonlySet<string> = new Set(["string", "int32", "int64", "uint8"])

/**
 * Reads a model graph's output signature.
 *
 * Returns a record carrying `unreadable` rather than throwing, so a rights record over
 * many packages reports the one graph it could not open instead of failing the whole pass.
 */
export async function readModelGraph(modelPath: PathBuilderLike): Promise<ModelGraphRecord> {
	if (!(await pathExists(modelPath))) {
		return { format: "ONNX", outputs: [], textEmittingOutput: false, unreadable: `no file at ${modelPath}` }
	}

	try {
		const { InferenceSession } = (await import("onnxruntime-node")).default
		const session = await InferenceSession.create(modelPath.toString())

		const outputs: ModelGraphOutput[] = session.outputNames.map((name, index) => {
			const meta = session.outputMetadata?.[index] as { type?: string; shape?: Array<number | string> } | undefined

			return { name, type: meta?.type ?? "unknown", shape: meta?.shape ?? [] }
		})

		return {
			format: "ONNX",
			outputs,
			textEmittingOutput: outputs.some((output) => TEXT_CAPABLE_TYPES.has(output.type)),
			unreadable: null,
		}
	} catch (error) {
		return {
			format: "ONNX",
			outputs: [],
			textEmittingOutput: false,
			unreadable: `${modelPath}: ${(error as Error).message}`,
		}
	}
}

/**
 * States a graph's output signature in one sentence, for a generated notice.
 *
 * The wording stays inside what the reading establishes.
 * It describes the supported inference interface and makes no claim about extraction attacks.
 */
export function describeModelGraph(record: ModelGraphRecord): string {
	if (record.unreadable) return `Model graph unread: ${record.unreadable}`

	const shapes = record.outputs.map((output) => `${output.name} ${output.type}[${output.shape.join(", ")}]`)

	return (
		`The model accepts tokenized text and emits ${shapes.join(" and ")}. ` +
		(record.textEmittingOutput
			? "One output's type could carry emitted tokens or text."
			: "It has no supported text-generating output.")
	)
}
