// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 * @file The parse-priors service: the gazetteer FST, the street-morphology matcher and the
 * postcode-prefix lookup, read from the artifacts beside the classifier's weights or from a
 * data root's active selection.
 */

import type { NeuralAddressClassifier } from "@mailwoman/neural"
import type { ServiceRegistry } from "async-init"

import type { LoadParsePriorsOptions, ParsePriorArtifacts, ParsePriors } from "#geocode/parse-priors"
import { ClassifierService } from "#services/classifier"
import { need, provide, serviceKey, type ServiceTimings } from "#services/registry"

/**
 * The parse priors and the artifact paths they were read from.
 */
export interface LoadedParsePriors {
	priors: ParsePriors
	artifacts: ParsePriorArtifacts
}

/**
 * The token of the parse priors.
 */
export const ParsePriorsService = serviceKey<LoadedParsePriors>("parse-priors")

/**
 * How a scope picks and loads its parse priors.
 */
export interface ParsePriorsServiceOptions {
	/**
	 * Returns the artifact paths to load, given the routed classifier's primary model.
	 *
	 * The primary model exposes the artifacts its weights package ships.
	 * A geocode generation scope substitutes the FSTs its data root's active selection lists.
	 */
	select(primary: NeuralAddressClassifier): ParsePriorArtifacts | Promise<ParsePriorArtifacts>

	/**
	 * Which priors to load and how to report a missing artifact.
	 */
	load: LoadParsePriorsOptions
}

/**
 * Registers the parse priors on `registry`, reading the classifier from the same scope or a parent.
 */
export function registerParsePriorsService(
	registry: ServiceRegistry,
	options: ParsePriorsServiceOptions,
	timings: ServiceTimings = {}
): void {
	provide(
		registry,
		timings,
		ParsePriorsService,
		() => need(registry, ClassifierService),
		async (routed) => {
			const { loadParsePriors } = await import("#geocode/parse-priors")
			const artifacts = await options.select(routed.primary)
			const priors = await loadParsePriors(artifacts, options.load)

			return { priors, artifacts }
		}
	)
}
