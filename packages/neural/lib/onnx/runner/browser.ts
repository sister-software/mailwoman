/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Browser counterpart of `onnx-runner.ts`, selected by the `browser` export condition on
 *   `@mailwoman/neural/onnx-runner`, because `onnxruntime-node` is a native addon whose `.node`
 *   binaries a browser graph cannot parse and resolution picks the module rather than the importer.
 *
 *   A webpack SSR compile resolves under the `node` condition rather than `browser` and so reaches
 *   the Node runner unless its config aliases this module explicitly.
 */

/**
 * Present so both modules expose the same shape.
 * Never read here.
 */
export const DEFAULT_INTRA_OP_THREADS = 2

/**
 * A property of the exported ONNX graph rather than of the runtime executing it, so both modules agree.
 */
export const DEFAULT_FIXED_SEQ_LEN = 128

const BROWSER_MESSAGE =
	"ONNXRunner is Node-only — it wraps onnxruntime-node, a native addon. " +
	"In a browser use WebONNXRunner (onnxruntime-web), which satisfies the same NeuralRunner interface."

/**
 * Shaped to match the Node class's static surface so an importer sees the same API either way.
 */
export const ONNXRunner = {
	create(): never {
		throw new Error(BROWSER_MESSAGE)
	},

	fromBytes(): never {
		throw new Error(BROWSER_MESSAGE)
	},
}
