// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 * @file The process-scope neural classifier service that the parser, the geocode session and the API engine share.
 */

import { CommandError } from "@mailwoman/core/scripting/command"
import { NeuralAddressClassifier, type ScriptRoutedClassifier } from "@mailwoman/neural"
import { weightsPackageName } from "@mailwoman/neural/weights"
import { createToken, type ServiceRegistry, type ServiceToken } from "async-init"
import { type PathBuilderLike, resolvePath } from "path-ts"

import { defineUnlessProvided } from "#services/define"

/**
 * The token of the script-routed neural classifier.
 */
export const ClassifierService: ServiceToken<ScriptRoutedClassifier<NeuralAddressClassifier>> =
	createToken("classifier")

/**
 * The options the classifier reads its weights with.
 *
 * A scope serves only callers that use the same options.
 */
export interface ClassifierServiceOptions {
	/**
	 * The BCP 47 locale whose weights package supplies the primary model, such as `en-US`.
	 */
	locale: string

	/**
	 * The data root whose `weights/` directory overlays the installed weights.
	 *
	 * Absent, the classifier probes the default data root's overlay.
	 */
	dataRoot?: PathBuilderLike

	/**
	 * A weights cache root.
	 *
	 * When set, loading uses only that cache and fails when the locale's package is absent there.
	 */
	weightsCacheRoot?: string
}

/**
 * Registers the script-routed classifier on `registry`.
 *
 * The weights load when a caller first needs the service.
 */
export function registerClassifierService(registry: ServiceRegistry, options: ClassifierServiceOptions): void {
	defineUnlessProvided(registry, ClassifierService, {
		build: async () => {
			try {
				return await NeuralAddressClassifier.loadRoutedFromWeights({
					locale: options.locale,
					...(options.dataRoot ? { overlayRoot: resolvePath(options.dataRoot, "weights") } : {}),
					...(options.weightsCacheRoot ? { cacheRoot: options.weightsCacheRoot } : {}),
				})
			} catch (error) {
				throw new CommandError(
					`Loading the neural weights for ${options.locale} failed. Install ${weightsPackageName(options.locale)}, ` +
						"or choose a locale whose weights package is installed.",
					{ cause: error }
				)
			}
		},
	})
}
