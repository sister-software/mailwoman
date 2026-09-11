/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The browser half of `#classifier/loader`. The Node half reads weights from disk through `@mailwoman/core/fs`,
 *   resolves them through `node:module`, and runs them on `onnxruntime-node`; none of that has a browser meaning. A
 *   bundler that follows `NeuralAddressClassifier.loadFromWeights` under the `browser` condition lands here and gets a
 *   refusal at call time instead of the Node graph at bundle time. Browser callers load through `web-loader`.
 */

import type {
	loadClassifierFromWeights as loadClassifierFromWeightsNode,
	loadScriptRoutedClassifier as loadScriptRoutedClassifierNode,
} from "#classifier/loader"

function refuse(name: string): never {
	throw new Error(
		`${name} reads weights from the filesystem and has no browser implementation; load through @mailwoman/neural/web-loader`
	)
}

export const loadClassifierFromWeights: typeof loadClassifierFromWeightsNode = () => refuse("loadClassifierFromWeights")

export const loadScriptRoutedClassifier: typeof loadScriptRoutedClassifierNode = () =>
	refuse("loadScriptRoutedClassifier")
