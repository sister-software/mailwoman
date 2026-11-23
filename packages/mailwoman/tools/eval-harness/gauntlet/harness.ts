// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   Shared Gauntlet harness: build the full-pipeline geocoder (optionally with a candidate model,
 *   so an eval can compare candidate-vs-production on the same inputs) and run one address end-to-end.
 *
 *   The geocoder is the routed geocode sessions of {@linkcode gauntletBatchConfig}
 *   (`#geocode/batch/config`), the sessions a bulk geocode's workers build from the same config,
 *   so the board, `mwdev_compare` and the held-out read grade one construction.
 *
 *   The Gauntlet grades the assembled output — coordinate + tier — not raw parse F1.
 */

import { md5Hex } from "@mailwoman/core/crypto/hash"
import { dataRootPath } from "@mailwoman/core/data-root"
import { readLocalBuffer, readLocalTextFile } from "@mailwoman/core/fs/readers"
import { pathExists } from "@mailwoman/core/fs/readers/stat"
import type { AdminCoherenceReport, GeocodeResult, VariantAliasExemption } from "@mailwoman/core/geocode"
import { deriveInputMode, type QueryKind } from "@mailwoman/core/pipeline"
import type { ResolveNodeTrace, WeakResolutionReading } from "@mailwoman/core/resolver"
import { tryParsingJSON } from "@mailwoman/core/values/json"
import { createScorer, NeuralAddressClassifier, type NeuralParseTrace } from "@mailwoman/neural"
import type { ModelCardToggle } from "@mailwoman/neural/classifier/options"
import { ScriptRoutedClassifier } from "@mailwoman/neural/classifier/script-router"
import type { FSTMatcherLike } from "@mailwoman/neural/prior/fst"
import { resolveWeights, weightsCachePackageDir } from "@mailwoman/neural/weights"
import { readDeclaredArtifactFile } from "@mailwoman/neural/weights/channels"
import type { ServiceRegistry } from "async-init"
import { resolvePath, type PathBuilder, type PathBuilderLike } from "path-ts"

import type { CapitalTier } from "#engine/resolver-backend"
import { createBatchGeocodeSessions, type GeocodeBatchConfig } from "#geocode/batch/config"
import { type DecoderSettings, geocodeParseInputs } from "#geocode/core"
import type { GeocodeRequestOptions } from "#geocode/session"
import type { GeocodeRoute } from "#geocode/session/routes"
import { createLocaleKindClassifier, GenerationServices } from "#geocode/session/services"
import { ClassifierService, registerClassifierService } from "#services/classifier"
import { gradedBaseOnly, OVERLAY_LOCALE_BY_COUNTRY } from "#tools/eval-harness/gauntlet/routing"
import { type SwitchPin, switchPinEntry } from "#tools/eval-harness/rig/switch-pin"

export interface GauntletDeps extends AsyncDisposable {
	geocode(input: string, opts?: GauntletGeocodeOpts): Promise<GeocodeResult>
	/**
	 * The same geocode, with the resolver's interior recorded: one {@linkcode ResolveNodeTrace}
	 * per backend lookup the walk performed, carrying the query as sent, the candidate table
	 * with its per-stage rank vector, the checks that fired and the pick's provenance.
	 *
	 * A separate method rather than a field on {@linkcode GauntletGeocodeOpts}, because the
	 * opts object is what a conformance-law row may pin and a law that could pin an observer
	 * would vary the instrument; `resolver` is `[]` when the walk performed no lookup.
	 */
	geocodeTraced(
		input: string,
		opts?: GauntletGeocodeOpts
	): Promise<{ result: GeocodeResult; resolver: ResolveNodeTrace[] }>
	/**
	 * Report-only access to the exact classifier, overlay, parse options
	 * and FST selected by the Gauntlet path.
	 *
	 * It performs no resolution and doesn't alter the check's geocode path.
	 * `wrapFST` replaces the case's gazetteer FST for this one parse with the matcher it returns,
	 * so a census can decode a candidate FST rule without changing the decoder.
	 *
	 * The returned `fst` is always the unwrapped matcher.
	 * The returned `classifier` is the one that parsed the row.
	 *
	 * `decoderSettings` overrides the pins' decoder settings for this one parse,
	 * so a census can decode a row with a setting on and off from one set of loaded deps.
	 */
	diagnoseParse(
		input: string,
		opts?: GauntletGeocodeOpts,
		wrapFST?: (fst: FSTMatcherLike) => FSTMatcherLike,
		decoderSettings?: DecoderSettings
	): Promise<{ trace: NeuralParseTrace; classifier: NeuralAddressClassifier; fst?: FSTMatcherLike }>
	/**
	 * Whether a row routed to `caseCountry` graded without that country's weights overlay. a
	 * base-only pass isn't evidence that the production path passes, so a caller turning a passing
	 * row into a durable claim must ask this first and withhold the claim when it answers true.
	 *
	 * Overlays load lazily on the first row of their country, so ask after grading that row.
	 */
	gradedBaseOnly(caseCountry: string | null): boolean
}

/**
 * {@linkcode buildGauntletDeps} needs two choices: the model to grade and its resolver configuration.
 */
export interface GauntletDepsOptions {
	/**
	 * Candidate ONNX (swaps only the model — see {@linkcode buildGauntletDeps}).
	 */
	modelPath?: string
	/**
	 * Candidate tokenizer (a splice candidate's new vocab).
	 */
	tokenizerPath?: string
	/**
	 * Candidate model-card, paired with `tokenizerPath`.
	 */
	modelCardPath?: string | null
	/**
	 * Package-shaped candidate weights dir, resolved as production resolves it.
	 */
	weightsCacheRoot?: string
	/**
	 * Candidate gazetteer artifact (a staged `candidate.db`) — the resolver-side twin of
	 * `weightsCacheRoot`; unset resolves the convention path production loads.
	 */
	candidateDB?: string
	/**
	 * The near-postcode gazetteer choreography for this run, `"declared"` (the card's) by default.
	 *
	 * Any other value is a declared ablation that pairs with the train-time half, so serving a model
	 * trained with it under `"off"` is a deliberate mismatch and never a shipping configuration.
	 */
	suppressGazetteerNearPostcode?: ModelCardToggle
	/**
	 * Replace the kind classifier's top verdict on every input this deps object geocodes —
	 * a declared ablation, never a shipping configuration.
	 *
	 * The verdict is what selects the parse register, so each request's input mode is set
	 * from {@link deriveInputMode} as well and wins over the pipeline's internal call.
	 */
	forceQueryKind?: QueryKind
	/**
	 * Resolver-side pins applied to every geocode this deps object performs.
	 *
	 * @defaultValue {@linkcode PRODUCTION_RESOLVER_PINS}
	 */
	pins?: GauntletResolverPins
}

/**
 * Resolver-side pins a gauntlet run can PIN — the counterpart to the model-side
 * `modelPath`/`tokenizerPath` swaps.
 *
 * The `eval oa-resolver` idiom treats a pin as a default override rather than a new
 * mechanism: every field maps 1:1 onto the geocode session option of the same name
 * ({@linkcode resolverPinSessionOptions}), and `"production"` leaves the session's default in force.
 */
export interface GauntletResolverPins {
	/**
	 * Postcode-country coherence — a (postcode, locality) pair coherent in exactly
	 * one country overrides a wrong `defaultCountry`.
	 */
	postcodeCountryCoherence: SwitchPin
	/**
	 * Feed the gazetteer FST prior to the parse.
	 */
	gazetteerPrior: SwitchPin
	/**
	 * The admin-containment re-rank: a parsed region qualifier participates in
	 * locality-candidate selection through the candidate gazetteer's ancestors sidecar.
	 */
	adminContainmentRerank: SwitchPin
	/**
	 * A parsed dependent locality resolves inside its parent through the same sidecar
	 * and answers the coordinate ahead of the locality (#2804).
	 */
	dependentLocalityContainment: SwitchPin
	/**
	 * A `locality` span written with its country's county designator resolves as its
	 * region's county when no locality of that name is in the region.
	 */
	countyDesignatorFallback: SwitchPin
	/**
	 * A `subregion` or `region` value naming a former division linked to the resolved locality is accepted.
	 * The `on` pin reads the former divisions table.
	 */
	formerDivisions: SwitchPin
	/**
	 * A soft country scope acts inside retrieval, and a hard scope reports the places it excluded.
	 */
	scopeCountryRetrieval: SwitchPin
	/**
	 * One of two `locality` spans resolves inside the other when the gazetteer contains it there.
	 */
	siblingLocalityContainment: SwitchPin
	/**
	 * The placetype-pair prior leaves separator pieces unbiased.
	 */
	pairPriorWordPieces: SwitchPin
	/**
	 * A segment child's placetype-pair bias leaves out its same-field postcode.
	 */
	pairPriorChildPostcodeStrip: SwitchPin
	/**
	 * The placetype-pair index applies only when the row's country is the index's country.
	 *
	 * A row routed to its own overlay states its country, as a chosen locale does.
	 * A row routed to the base package states none, and the locale head decides.
	 */
	pairIndexOwnCountry: SwitchPin
	/**
	 * A row parses with the gazetteer FST of the country the locale head reads, when one ships.
	 */
	fstCountryRouting: SwitchPin
	/**
	 * The capital-status ranking axis: bounded national-capital promotion on the bare-toponym
	 * class, read from the candidate `capital` table with a repo-file fallback.
	 */
	capitalTier: "production" | CapitalTier
	/**
	 * Whether own-name `variant` aliases are exempt from the cross-country primary-preference penalty.
	 *
	 * The stamp lives in the candidate build's own-name detector, so against a
	 * candidate.db without it the exemption matches no row.
	 */
	variantAliasExemption: "production" | VariantAliasExemption
	/**
	 * The venue tier: upgrade a venue-led address's admin or street answer to the
	 * poi.db entity with the venue's name near the resolved anchor.
	 *
	 * `"on"` degrades to the incumbent answer on a machine without poi.db.
	 */
	poiVenueTier: SwitchPin
	/**
	 * The venue-head emission prior, read from the head-word table of each row's session country.
	 */
	venueHeadPrior: SwitchPin
	/**
	 * Multiplier on the venue-head table's biases.
	 * `"production"` takes the session default.
	 */
	venueHeadBiasScale: "production" | number
	/**
	 * The street-morphology emission prior on a segment that opens with a house number.
	 */
	streetMorphologyPrior: SwitchPin
	/**
	 * Which reading of a weak resolution lifts the span-rescore brake.
	 *
	 * Three readings exist and the shipped brake is the absence of all of them, so there's no off pin.
	 */
	spanRescoreWeakResolution: "production" | WeakResolutionReading
}

/**
 * The pin set that grades production everywhere.
 */
export const PRODUCTION_RESOLVER_PINS: Readonly<GauntletResolverPins> = {
	postcodeCountryCoherence: "production",
	gazetteerPrior: "production",
	adminContainmentRerank: "production",
	dependentLocalityContainment: "production",
	countyDesignatorFallback: "production",
	formerDivisions: "production",
	scopeCountryRetrieval: "production",
	siblingLocalityContainment: "production",
	pairPriorWordPieces: "production",
	pairPriorChildPostcodeStrip: "production",
	pairIndexOwnCountry: "production",
	fstCountryRouting: "production",
	capitalTier: "production",
	variantAliasExemption: "production",
	poiVenueTier: "production",
	venueHeadPrior: "production",
	venueHeadBiasScale: "production",
	streetMorphologyPrior: "production",
	spanRescoreWeakResolution: "production",
}

/**
 * The geocode session options a pin set turns into.
 *
 * A `"production"` pin contributes no option, so the session's own default decides.
 * Pure and exported so the pin-reaches-the-session interface is testable without the full database set.
 */
export function resolverPinSessionOptions(pins: GauntletResolverPins): NonNullable<GeocodeBatchConfig["session"]> {
	return {
		...switchPinEntry("pairPriorWordPieces", pins.pairPriorWordPieces),
		...switchPinEntry("pairPriorChildPostcodeStrip", pins.pairPriorChildPostcodeStrip),
		...switchPinEntry("pairIndexOwnCountry", pins.pairIndexOwnCountry),
		...switchPinEntry("fstCountryRouting", pins.fstCountryRouting),
		...switchPinEntry("postcodeCountryCoherence", pins.postcodeCountryCoherence),
		...switchPinEntry("adminContainmentRerank", pins.adminContainmentRerank),
		...switchPinEntry("dependentLocalityContainment", pins.dependentLocalityContainment),
		...switchPinEntry("countyDesignatorFallback", pins.countyDesignatorFallback),
		...switchPinEntry("formerDivisions", pins.formerDivisions),
		...switchPinEntry("scopeCountryRetrieval", pins.scopeCountryRetrieval),
		...switchPinEntry("siblingLocalityContainment", pins.siblingLocalityContainment),
		...switchPinEntry("poiVenueTier", pins.poiVenueTier),
		...(pins.spanRescoreWeakResolution === "production"
			? {}
			: { spanRescoreWeakResolution: pins.spanRescoreWeakResolution }),
		...switchPinEntry("gazetteerPrior", pins.gazetteerPrior),
		...(pins.capitalTier === "production" ? {} : { capitalTier: pins.capitalTier }),
		...(pins.variantAliasExemption === "production" ? {} : { variantAliasExemption: pins.variantAliasExemption }),
		...switchPinEntry("venueHeadPrior", pins.venueHeadPrior),
		...(pins.venueHeadBiasScale === "production" ? {} : { venueHeadBiasScale: pins.venueHeadBiasScale }),
		...switchPinEntry("streetMorphologyPrior", pins.streetMorphologyPrior),
	}
}

/**
 * One-line description of the pins for the run banner.
 *
 * It prints on the unpinned run too, so two gauntlet logs can be told apart,
 * because an off/on pair whose logs are indistinguishable isn't evidence about the pin.
 * Only pins away from `"production"` are listed, a switch as `ON` or `OFF` and any other pin by its value.
 */
export function describeResolverPins(pins: GauntletResolverPins): string {
	const entries: string[] = Object.entries(resolverPinSessionOptions(pins)).map(([key, value]) => {
		if (typeof value === "boolean") return `${key}=${value ? "ON" : "OFF"}`

		if (key === "variantAliasExemption") return `${key}=${value === "applied" ? "ON" : "OFF"}`

		return `${key}=${String(value)}`
	})

	if (!entries.length) return "resolver pins: (none pinned — production defaults)"

	return `resolver pins: ${entries.join(", ")}`
}

/**
 * The configuration the gauntlet's geocode sessions are built from,
 * on the calling thread or in a bulk geocode's workers.
 *
 * A row is scoped only by the default country its case states, never by the locale's country,
 * and a row's country selects the weights overlay its parse reads.
 * A candidate model given by path has no overlay of its own, so every row parses under the base locale.
 */
export function gauntletBatchConfig(
	opts: Pick<GauntletDepsOptions, "weightsCacheRoot" | "candidateDB" | "pins" | "modelPath" | "tokenizerPath">
): GeocodeBatchConfig {
	return {
		dataRoot: dataRootPath().toString(),
		session: {
			...(opts.weightsCacheRoot ? { weightsCacheRoot: opts.weightsCacheRoot } : {}),
			...(opts.candidateDB ? { candidateDB: opts.candidateDB } : {}),
			countryScope: "none",
			...resolverPinSessionOptions(opts.pins ?? PRODUCTION_RESOLVER_PINS),
		},
		localeByCountry: opts.modelPath || opts.tokenizerPath ? {} : OVERLAY_LOCALE_BY_COUNTRY,
	}
}

/**
 * Per-query resolution priors a case can pass to the geocode.
 */
export interface GauntletGeocodeOpts {
	/**
	 * The case's country scope: the session's default country for the row.
	 */
	defaultCountry?: string
	/**
	 * The case's country (ISO-3166 alpha-2) selects the per-locale weights overlay the classifier loads.
	 *
	 * GB selects en-GB's pair-index.
	 * NZ selects en-NZ's pair-index.
	 *
	 * An absent country selects en-US.
	 * The bare en-US package silently drops the dependent-locality prior when it grades every row.
	 */
	caseCountry?: string
	/**
	 * The locale hint's country for the typo-fuzzy tier, derived from a row's `locale` field
	 * and forwarded verbatim as the request's `fuzzyCountryScope`.
	 */
	fuzzyCountryScope?: string
}

/**
 * Drift guard: the materialized model the check is about to grade must match the en-us
 * model-card's `files_md5["model.onnx"]`, throwing on mismatch so the release `before:release`
 * step blocks the ship, soft-returning when the card or the field is absent.
 * The check only examines the shipped default.
 *
 * The md5 it receives is of the model `resolveWeights` returned rather than of a path
 * spelled out here, because the guard must check the artifact the run will grade.
 */
async function assertShippedModelMatchesCard(materializedMd5: string): Promise<void> {
	const cardPath = resolvePath("packages/neural-weights-en-us/model-card.json")

	if (!(await pathExists(cardPath))) return

	// Soft-return on an unparseable card too: a card-format problem isn't this guard's job.
	const card = tryParsingJSON<{ version?: string; files_md5?: Record<string, string> }>(
		await readLocalTextFile(cardPath)
	)

	if (!card) {
		console.error(`[gauntlet] model-card ${cardPath} is not valid JSON — skipping the #1024 md5 guard`)

		return
	}

	const expected = card.files_md5?.["model.onnx"]

	if (typeof expected !== "string") return

	if (materializedMd5 !== expected) {
		throw new Error(
			`[gauntlet] materialized model md5 ${materializedMd5} ≠ model-card files_md5["model.onnx"] ${expected} ` +
				`(neural-weights-en-us/model-card.json, v${card.version ?? "?"}). The card is the source of truth; ` +
				`release.config.json / the dev-weights symlink has DRIFTED from it (#1024). Re-materialize the card's model ` +
				`(lib/release-kit/weights/copy-weights.ts) or fix release.config.json weights.model before verifying/shipping.`
		)
	}
}

/**
 * Assert that every locale this run can route to has the anchor binary its own weights card declares.
 *
 * A grading environment states its artifact expectations up front because a
 * missing `postcode-us.bin` doesn't error.
 * The anchor channel resolves to off and the operator reads a model regression.
 *
 * Expectations come from each package's own card, never a hardcoded list,
 * so en-gb's deliberate absence and en-nz's missing source are not called broken. a
 * package that doesn't resolve at all is graded base-only instead.
 */
export async function assertDeclaredAnchorBins(locales: readonly string[], cacheRoot?: PathBuilderLike): Promise<void> {
	const missing: string[] = []

	for (const locale of locales) {
		let packageDir: PathBuilder | null

		try {
			packageDir = (await resolveWeights({ locale, ...(cacheRoot ? { cacheRoot } : {}) })).packageDir ?? null
		} catch {
			continue
		}

		const declared = await readDeclaredArtifactFile(packageDir)

		if (!declared || declared.present) continue

		missing.push(
			`  ✗ ${locale}: ${declared.file} — declared by ${packageDir}/model-card.json (files.${declared.key}), not on disk\n` +
				`      link it: node ${packageDir}/scripts/link-dev-weights.ts`
		)
	}

	if (!missing.length) return

	throw new Error(
		`[gauntlet] refusing to grade: a weights package is missing the anchor artifact its own card declares.\n` +
			`${missing.join("\n")}\n` +
			`  The anchor channel would resolve OFF for those locales and the run would score LOW with no error ` +
			`(#1516). Materialize the artifacts above, or grade a candidate with --weights-cache pointing at a ` +
			`complete bundle.`
	)
}

/**
 * Loads a candidate model given by path: the ONNX with the shipped tokenizer,
 * or with a splice candidate's tokenizer and card.
 */
async function loadCandidateClassifier(opts: GauntletDepsOptions): Promise<NeuralAddressClassifier> {
	const suppressGazetteerNearPostcode = opts.suppressGazetteerNearPostcode ?? "declared"

	if (!opts.tokenizerPath) {
		return NeuralAddressClassifier.loadFromWeights({
			locale: "en-US",
			modelPath: resolvePath(opts.modelPath!),
			suppressGazetteerNearPostcode,
		})
	}

	return createScorer({
		// An override of only the tokenizer still takes the model from the resolver rather than a package literal.
		modelPath: opts.modelPath ? resolvePath(opts.modelPath) : (await resolveWeights({ locale: "en-us" })).modelPath,
		tokenizerPath: resolvePath(opts.tokenizerPath),
		modelCardPath: resolvePath(opts.modelCardPath ?? "packages/neural-weights-en-us/model-card.json"),
		locale: "en-us",
	})
}

/**
 * Substitutes the services the options' ablations replace on one locale's scope: a candidate
 * model given by path, the near-postcode gazetteer choreography, and the forced query kind.
 */
function prepareGauntletLocale(scope: ServiceRegistry, locale: string, opts: GauntletDepsOptions): void {
	if (opts.modelPath || opts.tokenizerPath) {
		// A candidate given by path has no package-shaped sibling for another script's family,
		// so every input parses on the candidate.
		scope.define(ClassifierService, {
			build: async () =>
				new ScriptRoutedClassifier({
					primary: await loadCandidateClassifier(opts),
					loadFamily: () => Promise.reject(new Error("a candidate model given by path routes no script family")),
				}),
		})
	} else if (opts.suppressGazetteerNearPostcode && opts.suppressGazetteerNearPostcode !== "declared") {
		registerClassifierService(scope, {
			locale,
			dataRoot: dataRootPath(),
			...(opts.weightsCacheRoot ? { weightsCacheRoot: opts.weightsCacheRoot } : {}),
			suppressGazetteerNearPostcode: opts.suppressGazetteerNearPostcode,
		})
	}

	const forced = opts.forceQueryKind

	if (forced) {
		// Only `kind` moves.
		// A confidence, alternative or intent-marker rewrite would change more than the verdict under test.
		scope.define(GenerationServices.classifyKind, {
			build: async () => {
				const classify = await createLocaleKindClassifier(locale)

				return async (input, shape) => ({ ...(await classify(input, shape)), kind: forced })
			},
		})
	}
}

/**
 * Build the gauntlet's geocoder.
 *
 * `modelPath` swaps only the ONNX, so the held-out check can grade a candidate
 * against production with every other input held equal.
 * Omit it for the shipped default.
 *
 * `tokenizerPath` (+ optional `modelCardPath`) additionally swaps the vocab, required for a
 * tokenizer-splice candidate whose model has extra embedding rows that a plain `modelPath`
 * swap can never exercise, because the shipped tokenizer emits no ids for the new pieces.
 */
export async function buildGauntletDeps(opts: GauntletDepsOptions = {}): Promise<GauntletDeps> {
	const pins = opts.pins ?? PRODUCTION_RESOLVER_PINS
	const candidateModel = !!(opts.modelPath || opts.tokenizerPath)

	// A package-shaped candidate weights dir.
	// Prefer this over `modelPath` when the vocab differs, because it resolves the model,
	// tokenizer, card and anchor/gazetteer siblings as production does, while a bare
	// `modelPath` swap feeds no soft channels and keeps the shipped tokenizer.
	const cacheModel = opts.weightsCacheRoot
		? resolvePath(weightsCachePackageDir(opts.weightsCacheRoot, "en-us"), "model.onnx")
		: null

	// Stamp the model under test so a stale dev symlink is never silent.
	// The default path asks `resolveWeights`, which answers with the file the classifier
	// will open, rather than naming a package directory that may not be materialized.
	const resolvedModel = opts.modelPath ? undefined : (await resolveWeights({ locale: "en-us" })).modelPath
	const effModel = cacheModel ?? (opts.modelPath ? resolvePath(opts.modelPath) : resolvedModel!)

	if (await pathExists(effModel)) {
		const md5 = md5Hex(await readLocalBuffer(effModel))

		console.error(`[gauntlet] model under test: ${effModel.split("/").slice(-2).join("/")} (md5 ${md5.slice(0, 8)})`)

		// The shipped default must match the model-card's `files_md5` (the card's hash decides);
		// a `--candidate` run intentionally grades a different artifact, so it is exempt.
		if (!opts.modelPath && !opts.tokenizerPath && !opts.weightsCacheRoot) {
			await assertShippedModelMatchesCard(md5)
		}
	}

	// Checked for the base locale plus every overlay the corpus can route to,
	// because the anchor artifact is per-package.
	if (!candidateModel) {
		await assertDeclaredAnchorBins(["en-US", ...Object.values(OVERLAY_LOCALE_BY_COUNTRY)], opts.weightsCacheRoot)
	}

	console.error(`[gauntlet] ${describeResolverPins(pins)}`)

	// A missing overlay grades its rows base-only with one loud warning per locale, because base-only
	// grading silently drops the dependent-locality prior and the row looks like a model failure.
	const sessions = createBatchGeocodeSessions(gauntletBatchConfig(opts), {
		prepareLocale: (scope, locale) => prepareGauntletLocale(scope, locale, opts),
		onLocaleUnavailable: (locale, error) =>
			console.error(
				// oxlint-disable-next-line mailwoman/prefer-spliterator -- An Error message rather than a data file.
				`[gauntlet] ⚠ ${locale} overlay unavailable (${(error as Error).message.split("\n")[0]}) — ` +
					`grading its cases BASE-ONLY (no pair-index/deploc prior). ` +
					`For production-true grading, include @mailwoman/neural-weights-${locale.toLowerCase()} in the weights cache.`
			),
	})

	try {
		// The base session builds here, so a missing database fails the build rather than the first row.
		const base = await sessions.sessionFor()

		// `@mailwoman/osm` is an optional peer of `mailwoman`, which the session opens lazily.
		// The gauntlet grades with the OpenStreetMap tier, so its absence is an error here.
		if (!base.services.osm) {
			throw new Error("the gauntlet grades the OpenStreetMap tier and needs @mailwoman/osm installed")
		}
	} catch (error) {
		await sessions[Symbol.asyncDispose]()

		throw error
	}

	const routeOf = (geoOpts: GauntletGeocodeOpts | undefined): GeocodeRoute => ({
		...(geoOpts?.caseCountry ? { country: geoOpts.caseCountry } : {}),
		...(geoOpts?.defaultCountry ? { defaultCountry: geoOpts.defaultCountry } : {}),
	})

	// Unset on every shipping path, so the register comes from the verdict as production derives it.
	const inputMode = opts.forceQueryKind ? deriveInputMode("auto", opts.forceQueryKind) : null

	const requestOf = (geoOpts: GauntletGeocodeOpts | undefined): GeocodeRequestOptions => ({
		...(geoOpts?.fuzzyCountryScope ? { fuzzyCountryScope: geoOpts.fuzzyCountryScope } : {}),
		...(inputMode ? { inputMode } : {}),
	})

	return {
		geocode: async (input, geoOpts) => (await sessions.geocode(input, routeOf(geoOpts), requestOf(geoOpts))).result,
		geocodeTraced: async (input, geoOpts) => {
			const run = await sessions.geocode(input, { ...routeOf(geoOpts), trace: true }, requestOf(geoOpts))

			return { result: run.result, resolver: run.trace?.resolver ?? [] }
		},
		diagnoseParse: async (input, geoOpts, wrapFST, decoderSettings) => {
			const session = await sessions.sessionFor(routeOf(geoOpts))
			const parseDeps = { ...session.parseDeps, ...decoderSettings, ...(inputMode ? { inputMode } : {}) }
			const parseFST = parseDeps.fst && wrapFST ? wrapFST(parseDeps.fst) : parseDeps.fst

			const { parseInput, opts: parseOpts } = geocodeParseInputs(input, {
				...parseDeps,
				...(parseFST ? { fst: parseFST } : {}),
			})

			return {
				trace: await parseDeps.classifier.traceParse(parseInput, parseOpts),
				classifier: await parseDeps.classifier.forInput(parseInput),
				...(parseDeps.fst ? { fst: parseDeps.fst } : {}),
			}
		},
		gradedBaseOnly: (caseCountry) => gradedBaseOnly(caseCountry, sessions.unavailableLocales),
		[Symbol.asyncDispose]: () => sessions[Symbol.asyncDispose](),
	}
}

/**
 * The projection of the assembled result the Gauntlet asserts on.
 */
export interface GauntletResult {
	/**
	 * All parsed components, including locale-specific tags that have no legacy result field.
	 */
	components: GeocodeResult["components"]
	lat: number | null
	lon: number | null
	tier: GeocodeResult["resolution_tier"]
	locality: string | null
	region: string | null
	country: string | null
	postcode: string | null
	/**
	 * The parsed spans, populated regardless of tier, asserted by venue/name-trap cases.
	 */
	house_number: string | null
	street: string | null
	venue: string | null
	dependent_locality: string | null
	/**
	 * The parsed unit / sub-venue span, asserted by the sub-venue cases.
	 *
	 * No result field exposed it before, so `componentOf` threw until it was added.
	 */
	unit: string | null
	/**
	 * The country the coherence pass scoped this row to, or null when it overrode no country.
	 * not asserted by any case, it is the firing count so a pinned run can count activity
	 * instead of inferring it from an unchanged verdict.
	 */
	postcode_country_scope: string | null
	/**
	 * The capital promotion's firing receipt, projected verbatim: the promoted candidate's
	 * country, or null unless the promotion changed some node's leading candidate,
	 * carrying the same firing-count posture as {@linkcode postcode_country_scope}.
	 */
	capital_promotion: string | null
	/**
	 * The variant-exemption firing receipt, projected verbatim: `applied` when the exemption
	 * spared the winning candidate the cross-country alias penalty, and `not_applied` otherwise.
	 */
	variant_alias_exemption: VariantAliasExemption
	/**
	 * The resolved admin chain, locality → country, verbatim from
	 * {@linkcode GeocodeResult.hierarchy}; Cases do not assert this value.
	 *
	 * The ablation layer's degradation ladder is synthesized from the gazetteer `placeID`s.
	 * An empty array means the run resolved no admin-grade entry.
	 */
	hierarchy: Array<{ tag: string; name: string; placeID: string | null; lat: number | null; lon: number | null }>
	/**
	 * The stage-1 admin-coherence verdicts, verbatim from {@linkcode GeocodeResult.admin_coherence};
	 * Cases do not assert these flag-only measurements.
	 *
	 * A dev-mcp row can count verdicts per component across a board run.
	 * The field is null when the geocode resolved no winner to check.
	 */
	admin_coherence: AdminCoherenceReport | null
}

export async function runOne(input: string, deps: GauntletDeps, opts?: GauntletGeocodeOpts): Promise<GauntletResult> {
	return toGauntletResult(await deps.geocode(input, opts))
}

/**
 * Project an assembled geocode into the projection the graders assert on. separate
 * from {@linkcode runOne} so a caller holding its own warm session grades
 * through this mapping rather than a second copy, because a field renamed here
 * and not there would make two graders disagree about the same run.
 */
export function toGauntletResult(g: GeocodeResult): GauntletResult {
	return {
		components: g.components,
		lat: g.lat,
		lon: g.lon,
		tier: g.resolution_tier,
		locality: g.locality,
		region: g.region,
		country: g.hierarchy.find((h) => h.tag === "country")?.value ?? null,
		postcode: g.postcode,
		house_number: g.house_number,
		street: g.street,
		venue: g.venue,
		dependent_locality: g.dependent_locality,
		unit: g.unit,
		postcode_country_scope: g.postcode_country_scope,
		capital_promotion: g.capital_promotion ?? null,
		variant_alias_exemption: g.variant_alias_exemption,
		admin_coherence: g.admin_coherence ?? null,
		hierarchy: g.hierarchy.map((h) => ({
			tag: h.tag,
			name: h.name,
			placeID: h.placeID || null,
			lat: h.lat ?? null,
			lon: h.lon ?? null,
		})),
	}
}
