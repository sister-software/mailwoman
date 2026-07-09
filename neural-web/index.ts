/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

export { defaultGazetteerLexiconURL, loadNeuralClassifierFromURLs, type LoadFromURLsOptions } from "./loader.ts"
export { DEFAULT_FIXED_SEQ_LEN, WebONNXRunner, type WebONNXRunnerOpts } from "./web-onnx-runner.ts"

// Re-export the public neural surface so callers don't need both packages on the typed path.
// Pull from the browser-safe entry — the default entry would drag onnxruntime-node + node:fs
// into the bundle graph via classifier.ts's transitive imports.
export {
	MailwomanTokenizer,
	NeuralAddressClassifier,
	type NeuralAddressClassifierConfig,
	type NeuralRunner,
} from "@mailwoman/neural/browser"
export type { InferResult } from "@mailwoman/neural/browser"
