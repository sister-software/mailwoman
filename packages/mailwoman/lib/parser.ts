// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 * @file The parser a `mailwoman` user creates: the script-routed neural classifier, the parse priors
 * beside its weights, and the runtime pipeline over both.
 */

import type {
	CaseNormalization,
	MachinePreferences,
	PipelineOpts,
	PipelineResult,
	PlacerCountryUse,
	StageSource,
} from "@mailwoman/core/pipeline"
import { DEFAULT_WEIGHTS_LOCALE } from "@mailwoman/neural/weights/families"
import { ServiceRegistry } from "async-init"
import type { PathBuilderLike } from "path-ts"

import { createRuntimePipeline } from "#runtime-pipeline"
import { ClassifierService, registerClassifierService } from "#services/classifier"
import {
	ParsePriorsService,
	registerParsePriorsService,
	registerShippedParsePriorArtifacts,
} from "#services/parse-priors"

/**
 * Options for {@link createParser}.
 */
export interface ParserOptions {
	/**
	 * The BCP 47 locale whose weights package supplies the primary model.
	 *
	 * An input in another script routes to that script's model when its weights package is installed.
	 *
	 * @defaultValue `"en-US"`
	 */
	locale?: string

	/**
	 * The data root whose `weights/` directory overlays the installed weights.
	 */
	dataRoot?: PathBuilderLike

	/**
	 * A weights cache root.
	 *
	 * When set, loading uses only that cache and fails when the locale's package is absent there.
	 */
	weightsCacheRoot?: string

	/**
	 * Host locale preferences, used only when neither the call nor the input identifies a locale.
	 *
	 * `"auto"` reads the current `Intl` defaults and `"none"` disables host inference.
	 *
	 * @defaultValue `"auto"`
	 */
	machinePreferences?: StageSource<MachinePreferences>

	/**
	 * The default for each call's `caseNormalization`.
	 *
	 * @defaultValue `"title-case"`
	 */
	caseNormalization?: CaseNormalization

	/**
	 * The default for each call's `placerCountryUse`.
	 *
	 * @defaultValue `"filter"`
	 */
	placerCountryUse?: PlacerCountryUse

	/**
	 * Whether the parser detects POI queries and extracts their intents.
	 *
	 * @defaultValue `"extract"`
	 */
	poiQueryKind?: "extract" | "none"

	/**
	 * A scope that already holds the classifier for the same `locale`, `dataRoot` and `weightsCacheRoot`.
	 *
	 * The parser registers its services in a child of this scope and leaves the
	 * classifier loaded when it is disposed.
	 * Without one, the parser owns its classifier.
	 */
	scope?: ServiceRegistry
}

/**
 * A parser that holds its loaded classifier and priors across calls.
 */
export interface Parser extends AsyncDisposable {
	/**
	 * Parses one address.
	 */
	parse(raw: string, runOpts?: PipelineOpts): Promise<PipelineResult>

	/**
	 * The scope holding the parser's classifier and priors.
	 *
	 * A geocode session built as its child reuses the classifier.
	 */
	readonly scope: ServiceRegistry
}

/**
 * Loads the classifier and priors for `options.locale` and returns a parser over them.
 *
 * The parser releases what it loaded when it is disposed:
 *
 * ```ts
 * await using parser = await createParser({ locale: "en-US" })
 * const result = await parser.parse("350 5th Ave, New York, NY 10118")
 * ```
 */
export async function createParser(options: ParserOptions = {}): Promise<Parser> {
	const locale = options.locale ?? DEFAULT_WEIGHTS_LOCALE
	const scope = options.scope ? options.scope.createChild() : new ServiceRegistry()

	// Each registration skips a service `options.scope` provides.
	registerClassifierService(scope, {
		locale,
		...(options.dataRoot ? { dataRoot: options.dataRoot } : {}),
		...(options.weightsCacheRoot ? { weightsCacheRoot: options.weightsCacheRoot } : {}),
	})

	registerShippedParsePriorArtifacts(scope)
	registerParsePriorsService(scope, { venueHeadPrior: false, label: `locale ${locale}` })

	try {
		const [classifier, { priors }] = await Promise.all([
			scope.resolve(ClassifierService),
			scope.resolve(ParsePriorsService),
		])

		// The pipeline's own scope is a child of the parser's, so disposing the parser's scope closes it too.
		const pipeline = createRuntimePipeline(
			{
				classifier,
				fst: priors.fst ?? "none",
				streetMorphology: priors.streetMorphology ?? "none",
				anchorRegions: priors.anchorRegions ?? "none",
				...(options.machinePreferences ? { machinePreferences: options.machinePreferences } : {}),
				...(options.caseNormalization ? { caseNormalization: options.caseNormalization } : {}),
				...(options.placerCountryUse ? { placerCountryUse: options.placerCountryUse } : {}),
				...(options.poiQueryKind ? { poiQueryKind: options.poiQueryKind } : {}),
			},
			{ parent: scope }
		)

		return {
			parse: pipeline,
			scope,
			[Symbol.asyncDispose]: () => scope[Symbol.asyncDispose](),
		}
	} catch (error) {
		await scope[Symbol.asyncDispose]()

		throw error
	}
}
