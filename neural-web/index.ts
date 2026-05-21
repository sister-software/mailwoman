/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

export { loadNeuralClassifierFromUrls, type LoadFromUrlsOpts } from "./loader.js"
export { DEFAULT_FIXED_SEQ_LEN, WebOnnxRunner, type WebOnnxRunnerOpts } from "./web-onnx-runner.js"

// Re-export the public neural surface so callers don't need both packages on the typed path.
export {
	MailwomanTokenizer,
	NeuralAddressClassifier,
	type InferResult,
	type NeuralAddressClassifierConfig,
	type NeuralRunner,
} from "@mailwoman/neural"
