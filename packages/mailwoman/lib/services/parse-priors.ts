// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 * @file The parse-priors services: which artifact files a scope reads, and the priors loaded from them.
 *
 * The priors are the gazetteer FST, the street-morphology matcher and the postcode-prefix lookup.
 * Their files sit beside the classifier's weights or in a data root's active selection.
 */

import { createToken, type ServiceRegistry, type ServiceToken } from "async-init"

import type { LoadParsePriorsOptions, ParsePriorArtifacts, ParsePriors } from "#geocode/parse-priors"
import { ClassifierService } from "#services/classifier"

/**
 * The parse priors and the artifact paths they were read from.
 */
export interface LoadedParsePriors {
	priors: ParsePriors
	artifacts: ParsePriorArtifacts
}

/**
 * The token of the artifact paths a scope loads its parse priors from.
 *
 * Each scope defines this service for itself, because the choice differs.
 * A parser reads the artifacts its weights package ships, through {@link registerShippedParsePriorArtifacts}.
 *
 * A geocode generation scope reads the FSTs its data root's active selection lists.
 */
export const ParsePriorArtifactsService: ServiceToken<ParsePriorArtifacts> = createToken("parse-prior-artifacts")

/**
 * The token of the parse priors.
 */
export const ParsePriorsService: ServiceToken<LoadedParsePriors> = createToken("parse-priors")

/**
 * Registers the artifacts the classifier's own weights package ships as the scope's parse-prior artifacts.
 *
 * The routed classifier's primary model exposes those paths.
 */
export function registerShippedParsePriorArtifacts(registry: ServiceRegistry): void {
	registry.define(ParsePriorArtifactsService, {
		needs: { routed: ClassifierService },
		build: ({ routed }): ParsePriorArtifacts => routed.primary,
	})
}

/**
 * Registers the parse priors on `registry`, loaded from the scope's {@link ParsePriorArtifactsService}.
 *
 * @param load Which priors to load and how to report a missing artifact.
 */
export function registerParsePriorsService(registry: ServiceRegistry, load: LoadParsePriorsOptions): void {
	registry.define(ParsePriorsService, {
		needs: { artifacts: ParsePriorArtifactsService },
		build: async ({ artifacts }) => {
			const { loadParsePriors } = await import("#geocode/parse-priors")
			const priors = await loadParsePriors(artifacts, load)

			return { priors, artifacts }
		},
	})
}
