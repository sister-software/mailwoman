/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Browser counterpart of `onnx-runner.ts`, selected by the `browser` export condition on
 *   `@mailwoman/neural/onnx-runner`.
 *
 *   `onnxruntime-node` is a native addon: anything that follows a value import of the Node runner into a browser graph
 *   pulls its `.node` binaries along and fails parsing them. Resolution picks the module rather than the importer
 *   guarding the import, so a caller names one specifier and never has to know which runtime it is in.
 *
 *   NOTE FOR BUNDLER CONFIG: a webpack SSR compile resolves under the `node` condition, not `browser` — correctly, since
 *   it targets Node — so a Docusaurus-style server bundle reaches the real runner unless its config aliases this module
 *   explicitly. That is a property of building FOR Node, not a gap in this map.
 *
 *   Every export throws rather than no-opping. A browser caller reaching `ONNXRunner` wanted inference, and an inert
 *   object would surface as an empty parse far from its cause.
 */

/**
 * Present so both modules expose the same shape; never read here.
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
 * Shaped to match the Node class's static surface so an importer sees the same API either way. An object rather than a
 * class because there is nothing to instantiate — every entry point throws.
 */
export const ONNXRunner = {
	create(): never {
		throw new Error(BROWSER_MESSAGE)
	},

	fromBytes(): never {
		throw new Error(BROWSER_MESSAGE)
	},
}
