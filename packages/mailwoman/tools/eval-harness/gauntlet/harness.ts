/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Shared Gauntlet harness: build the full-pipeline geocode deps (optionally with a candidate model, so an eval can compare candidate-vs-production on the same inputs) and run one address end-to-end. The Gauntlet grades the assembled output — coordinate + tier — not raw parse F1.
 */

import { dataRootPath } from "@mailwoman/core/data-root"
import { pathExists, readLocalBuffer, readLocalTextFile } from "@mailwoman/core/fs/readers"
import { md5Hex } from "@mailwoman/core/hash"
import { tryParsingJSON } from "@mailwoman/core/json"
import { deriveInputMode, type QueryKind } from "@mailwoman/core/pipeline"
import type { ResolveNodeTrace, WeakResolutionReading } from "@mailwoman/core/resolver"
import { createKindClassifier } from "@mailwoman/kind-classifier"
import { createScorer, NeuralAddressClassifier, type NeuralParseTrace } from "@mailwoman/neural"
import type { FSTMatcherLike } from "@mailwoman/neural/fst-prior"
import { resolveWeights, weightsCachePackageDir } from "@mailwoman/neural/weights"
import { readDeclaredArtifactFile } from "@mailwoman/neural/weights/channels"
import { createWOFResolver } from "@mailwoman/resolver"
import { poiDatabasePath, wofExtractPaths } from "@mailwoman/resolver-wof-sqlite/paths"
import { resolvePath, type PathBuilder, type PathBuilderLike } from "path-ts"

import type { AdminCoherenceReport } from "#admin-coherence"
import { geocodeAddress, geocodeParseInputs, type GeocodeDeps } from "#geocode/core"
import { USStateDatabaseProvider } from "#geocode/regions"
import type { GeocodeResult } from "#geocode/result"
import { poiTaxonomyLookup } from "#poi/intent"
import { createResolverBackend, loadCapitalIndex, resolveCandidateDBPath } from "#resolver-backend"
import { gradedBaseOnly, OVERLAY_LOCALE_BY_COUNTRY } from "#tools/eval-harness/gauntlet/routing"

export interface GauntletDeps extends Disposable {
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
	 * It performs no resolution and does not alter the check's geocode path.
	 */
	diagnoseParse(input: string, opts?: GauntletGeocodeOpts): Promise<{ trace: NeuralParseTrace; fst?: FSTMatcherLike }>
	/**
	 * Whether a row routed to `caseCountry` graded without that country's weights overlay. a
	 * base-only pass is not evidence that the production path passes, so a caller turning a passing
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
	modelCardPath?: string
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
	 * Override the card's near-postcode gazetteer choreography for this run.
	 *
	 * A declared ablation that pairs with the train-time half, so serving a model trained
	 * with it under `false` is a deliberate mismatch and never a shipping configuration.
	 */
	suppressGazetteerNearPostcode?: boolean
	/**
	 * Replace the kind classifier's top verdict on every input this deps object geocodes —
	 * a declared ablation, never a shipping configuration.
	 *
	 * The verdict is what selects the parse register, so `deps.inputMode` is set from
	 * {@link deriveInputMode} as well and wins over the pipeline's internal call.
	 */
	forceQueryKind?: QueryKind
	/**
	 * Resolver-side pins applied to every geocode this deps object performs.
	 */
	pins?: GauntletResolverPins
}

/**
 * Resolver-side pins a gauntlet run can PIN — the counterpart to the model-side
 * `modelPath`/`tokenizerPath` swaps.
 *
 * The `eval oa-resolver` idiom treats a pin as a default override rather than a new mechanism:
 * Every field maps 1:1 onto a {@linkcode geocodeAddress} dependency of the same name.
 * An absent field leaves the production default in force.
 * `undefined` also means the production default.
 */
export interface GauntletResolverPins {
	/**
	 * Postcode-country coherence — a (postcode, locality) pair coherent in exactly
	 * one country overrides a wrong `defaultCountry`.
	 *
	 * The default is on.
	 * `false` grades the off arm.
	 */
	postcodeCountryCoherence?: boolean
	/**
	 * Feed the gazetteer FST prior to the parse.
	 *
	 * Unlike the boolean pins this one selects an artifact, so the harness loads it
	 * rather than `resolverPinDeps`, and only an explicit `false` withholds it.
	 */
	gazetteerPrior?: boolean
	/**
	 * The admin-containment re-rank: a parsed region qualifier participates in
	 * locality-candidate selection through the candidate gazetteer's ancestors
	 * sidecar. default off, so `true` enables the evidence.
	 */
	adminContainmentRerank?: boolean
	/**
	 * The capital-status ranking axis: bounded national-capital promotion on the bare-toponym class,
	 * carrying an artifact (the candidate `capital` table with a repo-file fallback) that
	 * the harness loads rather than `resolverPinDeps`; default on, `false` pins the off arm.
	 *
	 * An unset value uses the default and degrades on a reference-less artifact.
	 */
	capitalTier?: boolean
	/**
	 * Exempt own-name `variant` aliases from the cross-country primary-preference
	 * penalty. the stamp lives in the candidate build's own-name detector,
	 * so against a candidate.db without it the exemption matches no row.
	 */
	variantAliasExemption?: boolean
	/**
	 * The opt-in venue tier: upgrade a venue-led address's admin or street answer to
	 * the poi.db entity with the venue's name near the resolved anchor.
	 *
	 * The default is off.
	 * `true` degrades to the incumbent answer on a machine without poi.db.
	 */
	poiVenueTier?: boolean
	/**
	 * A span-rescore sub-span may drop context but never a word of the name. default off,
	 * so `true` enables the evidence.
	 */
	spanRescoreRequireContextRemainder?: boolean
	/**
	 * Which reading of a weak resolution lifts the span-rescore brake. three readings exist
	 * and the shipped brake is the absence of all of them, so `undefined` is the
	 * production arm and there is no off pin.
	 */
	spanRescoreWeakResolution?: WeakResolutionReading
}

/**
 * The geocode deps a pin set turns into, spread into every {@linkcode geocodeAddress} call the run makes.
 *
 * Pure and exported so the pin-reaches-the-pipeline interface is testable without the full database set.
 */
export function resolverPinDeps(pins?: GauntletResolverPins | null): {
	postcodeCountryCoherence?: boolean
	adminContainmentRerank?: boolean
	poiVenueTier?: boolean
	spanRescoreRequireContextRemainder?: boolean
	spanRescoreWeakResolution?: WeakResolutionReading
} {
	if (!pins) return {}

	// A key is emitted only when the runner set it: an `undefined` value would still
	// be an own property and reads as an explicit pin.
	return {
		...(pins.postcodeCountryCoherence === undefined ? {} : { postcodeCountryCoherence: pins.postcodeCountryCoherence }),
		...(pins.adminContainmentRerank === undefined ? {} : { adminContainmentRerank: pins.adminContainmentRerank }),
		...(pins.poiVenueTier === undefined ? {} : { poiVenueTier: pins.poiVenueTier }),
		...(pins.spanRescoreRequireContextRemainder === undefined
			? {}
			: { spanRescoreRequireContextRemainder: pins.spanRescoreRequireContextRemainder }),
		...(pins.spanRescoreWeakResolution === undefined
			? {}
			: { spanRescoreWeakResolution: pins.spanRescoreWeakResolution }),
	}
}

/**
 * One-line description of the pins for the run banner.
 *
 * It prints on the unpinned run too, so two gauntlet logs can be told apart,
 * because an off/on pair whose logs are indistinguishable is not evidence about the pin.
 */
export function describeResolverPins(pins?: GauntletResolverPins | null): string {
	// `resolverPinDeps` is pure and cannot see the artifact-carrying pins,
	// so this list includes every pin rather than only the boolean ones.
	// A non-boolean pin prints its value instead of collapsing three different configurations to `on`.
	const entries: string[] = Object.entries(resolverPinDeps(pins)).map(([k, v]) =>
		typeof v === "boolean" ? `${k}=${v ? "ON" : "OFF"}` : `${k}=${v}`
	)

	// Printed only when pinned away from the production default.
	// An unset pin prints no line, so "no flag" reads as "grade whatever production does".
	if (pins?.gazetteerPrior !== undefined) {
		entries.push(`gazetteerPrior=${pins.gazetteerPrior ? "ON" : "OFF"}`)
	}

	if (pins?.capitalTier !== undefined) {
		entries.push(`capitalTier=${pins.capitalTier ? "ON" : "OFF"}`)
	}

	if (pins?.variantAliasExemption !== undefined) {
		entries.push(`variantAliasExemption=${pins.variantAliasExemption ? "ON" : "OFF"}`)
	}

	if (!entries.length) return "resolver pins: (none pinned — production defaults)"

	return `resolver pins: ${entries.join(", ")}`
}

/**
 * Per-query resolution priors a case can pass to {@linkcode geocodeAddress}.
 */
export interface GauntletGeocodeOpts {
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
	 * and forwarded verbatim to `geocodeAddress`'s `fuzzyCountryScope`.
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
 * spelled out here, because the guard must check the artifact the run will actually grade.
 */
async function assertShippedModelMatchesCard(materializedMd5: string): Promise<void> {
	const cardPath = resolvePath("packages/neural-weights-en-us/model-card.json")

	if (!(await pathExists(cardPath))) return

	// Soft-return on an unparseable card too: a card-format problem is not this guard's job.
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
 * missing `postcode-us.bin` does not error.
 * The anchor channel resolves to off and the operator reads a model regression.
 *
 * Expectations come from each package's own card, never a hardcoded list, so en-gb's
 * deliberate absence and en-nz's missing source are not called broken. a package that
 * does not resolve at all is `classifierFor`'s base-only fallback instead.
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
 * Build the geocode deps.
 *
 * `modelPath` swaps only the ONNX, so the held-out check can grade a candidate against production fairly.
 * Omit it for the shipped default.
 *
 * `tokenizerPath` (+ optional `modelCardPath`) additionally swaps the vocab, required for a
 * tokenizer-splice candidate whose model has extra embedding rows that a plain `modelPath`
 * swap can never exercise, because the shipped tokenizer emits no ids for the new pieces.
 */
export async function buildGauntletDeps(opts: GauntletDepsOptions = {}): Promise<GauntletDeps> {
	const resolverMod = await import("@mailwoman/resolver-wof-sqlite")

	// A package-shaped candidate weights dir.
	// Prefer this over `modelPath` when the vocab differs, because `loadFromWeights({cacheRoot})`
	// resolves the model, tokenizer, card and anchor/gazetteer siblings as production does,
	// while a bare `modelPath` swap feeds no soft channels and keeps the shipped tokenizer.
	const cacheModel = opts.weightsCacheRoot
		? resolvePath(weightsCachePackageDir(opts.weightsCacheRoot, "en-us"), "model.onnx")
		: undefined

	// Stamp the model under test so a stale dev symlink is never silent.
	// The default path asks `resolveWeights`, which answers with the file `loadFromWeights`
	// will actually open, rather than naming a package directory that may not be materialized.
	const resolvedModel = opts.modelPath ? undefined : (await resolveWeights({ locale: "en-us" })).modelPath
	const effModel = cacheModel ?? (opts.modelPath ? resolvePath(opts.modelPath) : resolvedModel!)

	if (await pathExists(effModel)) {
		const md5 = md5Hex(await readLocalBuffer(effModel))

		console.error(`[gauntlet] model under test: ${effModel.split("/").slice(-2).join("/")} (md5 ${md5.slice(0, 8)})`)

		// The shipped default must match the model-card's `files_md5` (the card is the source of truth);
		// a `--candidate` run intentionally grades a different artifact, so it is exempt.
		if (!opts.modelPath && !opts.tokenizerPath && !opts.weightsCacheRoot) {
			await assertShippedModelMatchesCard(md5)
		}
	}

	const ablation =
		opts.suppressGazetteerNearPostcode === undefined
			? {}
			: { suppressGazetteerNearPostcode: opts.suppressGazetteerNearPostcode }

	const classifier = opts.weightsCacheRoot
		? await NeuralAddressClassifier.loadFromWeights({
				locale: "en-US",
				cacheRoot: opts.weightsCacheRoot,
				...ablation,
			})
		: opts.tokenizerPath
			? await createScorer({
					// Same rule as the stamp above: an override of only the tokenizer still takes
					// the model from the resolver rather than a package literal.
					modelPath: opts.modelPath
						? resolvePath(opts.modelPath)
						: (await resolveWeights({ locale: "en-us" })).modelPath,
					tokenizerPath: resolvePath(opts.tokenizerPath),
					modelCardPath: resolvePath(opts.modelCardPath ?? "packages/neural-weights-en-us/model-card.json"),
					locale: "en-us",
				})
			: opts.modelPath
				? await NeuralAddressClassifier.loadFromWeights({
						locale: "en-US",
						modelPath: resolvePath(opts.modelPath),
						...ablation,
					})
				: await NeuralAddressClassifier.loadFromWeights({ locale: "en-US", ...ablation })

	// Per-country overlay classifiers: a case's country selects the weights overlay
	// so GB rows grade with en-GB's pair-index + transition-beta as production's
	// locale-hint routes them, lazily and memoized.
	// A missing overlay package falls back to the base classifier with one loud warning
	// per locale, because base-only grading silently drops the dependent-locality prior
	// and the row looks like a model failure.
	// Checked for the base locale plus every overlay the corpus can route to,
	// because the anchor artifact is per-package.
	if (!opts.modelPath && !opts.tokenizerPath) {
		await assertDeclaredAnchorBins(["en-US", ...Object.values(OVERLAY_LOCALE_BY_COUNTRY)], opts.weightsCacheRoot)
	}

	const overlayClassifiers = new Map<string, typeof classifier>()
	const warnedOverlays = new Set<string>()
	// Overlay locales that failed to load, keyed by locale rather than country because the fallback is
	// memoized per locale and a second country routing to the same overlay never reaches the catch.
	const baseOnlyLocales = new Set<string>()

	async function classifierFor(caseCountry?: string): Promise<typeof classifier> {
		const overlayLocale = caseCountry ? OVERLAY_LOCALE_BY_COUNTRY[caseCountry] : undefined

		// Scorer/modelPath legacy modes have no package-shaped sibling resolution — base only.
		if (!overlayLocale || opts.tokenizerPath || opts.modelPath) return classifier

		const cached = overlayClassifiers.get(overlayLocale)

		if (cached) return cached

		try {
			const overlay = await NeuralAddressClassifier.loadFromWeights({
				locale: overlayLocale,
				...(opts.weightsCacheRoot ? { cacheRoot: opts.weightsCacheRoot } : {}),
			})

			overlayClassifiers.set(overlayLocale, overlay)

			return overlay
		} catch (error) {
			baseOnlyLocales.add(overlayLocale)

			if (!warnedOverlays.has(overlayLocale)) {
				warnedOverlays.add(overlayLocale)

				console.error(
					// oxlint-disable-next-line mailwoman/prefer-spliterator -- An Error message rather than a data file.
					`[gauntlet] ⚠ ${overlayLocale} overlay unavailable (${(error as Error).message.split("\n")[0]}) — ` +
						`grading ${caseCountry} cases BASE-ONLY (no pair-index/deploc prior). ` +
						`For production-true grading, include @mailwoman/neural-weights-${overlayLocale.toLowerCase()} in the weights cache.`
				)
			}

			overlayClassifiers.set(overlayLocale, classifier)

			return classifier
		}
	}

	const kindClassifierWithLexicon = createKindClassifier({ poiLexicon: poiTaxonomyLookup })

	// en-US is the CLI's default locale — the harness grades the production-default arm.
	const poiKindClassifier: NonNullable<GeocodeDeps["classifyKind"]> = async (input, shape) => {
		const verdict = await kindClassifierWithLexicon(input, shape, {
			locale: "en-US",
			confidence: 1,
			alternatives: [],
			source: "caller",
		})

		if (!opts.forceQueryKind) return verdict

		// Only `kind` moves.
		// A confidence, alternative or intent-marker rewrite would change more than the verdict under test.
		// The coordinator routes on only the top kind.
		return { ...verdict, kind: opts.forceQueryKind }
	}

	// The database set is the paths that exist.
	// Presence is materialized up front so the filter below stays a synchronous
	// read over facts already gathered.
	const wofDatabasePresence = await Promise.all(
		wofExtractPaths().map(async (path) => ({ path, present: await pathExists(path) }))
	)

	const presentWofDatabases = wofDatabasePresence.filter((entry) => entry.present).map((entry) => entry.path)

	const resolver = createWOFResolver(
		await createResolverBackend(resolverMod, {
			wofPaths: presentWofDatabases,
			...(opts.candidateDB ? { candidateDB: opts.candidateDB } : {}),
			...(opts.pins?.variantAliasExemption === false ? { variantAliasExemption: false } : {}),
		})
	)

	// The reference loads here and becomes the per-candidate `capitalLevel` closure,
	// matching `createGeocodeSession`.
	// `false` pins the off arm.
	// Explicit `true` requires the reference.
	// An unset value uses the default (on) and degrades on a reference-less artifact.
	const capitalIndex =
		opts.pins?.capitalTier === false
			? undefined
			: await loadCapitalIndex({
					candidateDB: (await resolveCandidateDBPath(opts.candidateDB)) ?? undefined,
					missing: opts.pins?.capitalTier === true ? "throw" : "degrade",
				})

	const capitalLevel = capitalIndex
		? (place: { name: string; country?: string; lat: number; lon: number }): number =>
				capitalIndex.levelOfPlace(place.name, place.country ?? null, place.lat, place.lon)
		: undefined

	const regionDatabaseProvider = await USStateDatabaseProvider.create(resolverMod, dataRootPath())
	// Load this module lazily, like the resolver module above.
	// `@mailwoman/osm` is unpublished.
	// A static import would break the published `mailwoman` CLI as well as this maintainer-run check.
	const { OSMRegionDatabaseProvider } = await import("@mailwoman/osm/region-database-provider")
	const osmProvider = await OSMRegionDatabaseProvider.create(dataRootPath)
	// The BAN national-register tier sits ahead of OSM in production, so without it the
	// gauntlet would grade an OSM-first cascade production never runs.
	const { BANRegionDatabaseProvider } = await import("@mailwoman/ban/region-database-provider")
	const banProvider = await BANRegionDatabaseProvider.create(dataRootPath)

	const pinDeps = resolverPinDeps(opts.pins)

	// This pin selects an artifact rather than a boolean value.
	// The artifact is PER classifier.
	// The FST ships beside the weights: the en-GB package includes `fst-en-gb.bin`,
	// and the base package includes `fst-en-us.bin`.
	// They hold different places: reading the path off the base classifier would feed every
	// overlay case a gazetteer for the wrong country, a pairing production never runs.
	// Cached per resolved path, because the overlay classifiers are themselves cached
	// and several countries share one.
	const priorDepsByPath = new Map<string, Pick<GeocodeDeps, "fst" | "streetMorphology">>()
	const warnedMissingPriorFST = new Set<string>()

	async function priorDepsFor(
		forClassifier: typeof classifier,
		label: string
	): Promise<Pick<GeocodeDeps, "fst" | "streetMorphology">> {
		// Default-on: only an explicit `false` withholds the prior.
		if (opts.pins?.gazetteerPrior === false) return {}

		// A string, because it keys `priorDepsByPath`; a builder would key by object identity.
		const fstPath = (forClassifier as { fstPath?: PathBuilderLike }).fstPath?.toString()

		if (!fstPath) {
			// Loud, once per locale: a prior-on run against an overlay with no FST silently
			// grades the base model for those rows while the pins line still records `on`.
			if (!warnedMissingPriorFST.has(label)) {
				warnedMissingPriorFST.add(label)

				console.error(
					`[gauntlet] ⚠ gazetteerPrior=ON but the ${label} weights package ships no FST — every ${label} row is ` +
						"graded WITHOUT the prior. The pins line will still say ON; this is the only place that says otherwise."
				)
			}

			return {}
		}

		const cached = priorDepsByPath.get(fstPath)

		if (cached) return cached

		const [{ deserializeFST }, { loadStreetMorphologyFST: loadMorph }] = await Promise.all([
			import("@mailwoman/resolver-wof-sqlite/fst"),
			import("@mailwoman/resolver-wof-sqlite/street"),
		])

		let deps: Pick<GeocodeDeps, "fst" | "streetMorphology"> = {}

		try {
			deps = { fst: deserializeFST(await readLocalBuffer(fstPath)), streetMorphology: (await loadMorph()).matcher }
		} catch (error) {
			// A missing or unreadable artifact degrades to no prior, with its reason recorded
			// because a silent absent prior scores lower and reads as a model difference.
			console.error(
				`[gauntlet] gazetteer prior unavailable at ${fstPath}: ${(error as Error).message} — grading without it`
			)
		}

		priorDepsByPath.set(fstPath, deps)

		return deps
	}

	console.error(`[gauntlet] ${describeResolverPins(opts.pins)}`)

	// The fork→entity probe's two signals — both or neither, tolerate-and-degrade like every
	// optional artifact and mirroring the CLI's wiring so the board grades what production runs.
	let forkEntityDeps: Pick<GeocodeDeps, "poiLookup" | "isStreetGeneric"> = {}
	const poiDBPath = poiDatabasePath("poi.db")

	if (await pathExists(poiDBPath)) {
		const [{ POILookup }, { loadStreetMorphologyFST }] = await Promise.all([
			import("@mailwoman/resolver-wof-sqlite/poi"),
			import("@mailwoman/resolver-wof-sqlite/street"),
		])

		const morphology = await loadStreetMorphologyFST()

		forkEntityDeps = {
			poiLookup: new POILookup({ databasePath: poiDBPath }),
			isStreetGeneric: (token: string) => morphology.matcher.walk([token]) !== null,
		}
	}

	/**
	 * The one geocode call both public entry points make; `extra` is spread last so a trace sink cannot
	 * be shadowed, keeping the two entry points from drifting into different dependency assemblies.
	 */
	const runGeocode = async (
		input: string,
		geoOpts: GauntletGeocodeOpts | null,
		extra: Pick<GeocodeDeps, "resolveTraceSink">
	): Promise<GeocodeResult> => {
		const { caseCountry, ...forwarded } = geoOpts ?? {}
		const caseClassifier = await classifierFor(caseCountry)

		return geocodeAddress(input, {
			classifier: caseClassifier,
			// Same lexicon-aware kind classifier the CLI session wires, so the harness grades the user's path.
			classifyKind: poiKindClassifier,
			// Unset on every shipping path, so the register comes from the verdict as production derives it.
			...(opts.forceQueryKind ? { inputMode: deriveInputMode(opts.forceQueryKind) } : {}),
			resolver,
			databases: regionDatabaseProvider.for,
			nationalDatabases: banProvider.for,
			osmDatabases: osmProvider.for,
			...pinDeps,
			...(capitalLevel ? { capitalLevel } : {}),
			...(await priorDepsFor(caseClassifier, OVERLAY_LOCALE_BY_COUNTRY[caseCountry ?? ""] ?? "base")),
			...forkEntityDeps,
			...forwarded,
			...extra,
		})
	}

	return {
		diagnoseParse: async (input: string, geoOpts?: GauntletGeocodeOpts) => {
			const { caseCountry } = geoOpts ?? {}
			const caseClassifier = await classifierFor(caseCountry)
			const priorDeps = await priorDepsFor(caseClassifier, OVERLAY_LOCALE_BY_COUNTRY[caseCountry ?? ""] ?? "base")
			const { parseInput, opts: parseOpts } = geocodeParseInputs(input, priorDeps)

			return {
				trace: await caseClassifier.traceParse(parseInput, parseOpts),
				...(priorDeps.fst ? { fst: priorDeps.fst } : {}),
			}
		},
		gradedBaseOnly: (caseCountry: string | null) => gradedBaseOnly(caseCountry, baseOnlyLocales),
		geocode: (input: string, geoOpts?: GauntletGeocodeOpts) => runGeocode(input, geoOpts ?? null, {}),
		geocodeTraced: async (input: string, geoOpts?: GauntletGeocodeOpts) => {
			const resolverTrace: ResolveNodeTrace[] = []

			const result = await runGeocode(input, geoOpts ?? null, {
				resolveTraceSink: (record) => resolverTrace.push(record),
			})

			return { result, resolver: resolverTrace }
		},
		[Symbol.dispose]: () => {
			regionDatabaseProvider[Symbol.dispose]()
			banProvider[Symbol.dispose]()
			osmProvider[Symbol.dispose]()
		},
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
	 * country, present only when the promotion changed some node's leading candidate,
	 * carrying the same firing-count posture as {@linkcode postcode_country_scope}.
	 */
	capital_promotion?: string
	/**
	 * The variant-exemption firing receipt, projected verbatim and present (`true`) only when the
	 * winning candidate reached the top because the exemption spared it the cross-country alias penalty.
	 */
	variant_alias_exemption?: true
	/**
	 * The resolved admin chain, locality → country, verbatim from
	 * {@linkcode GeocodeResult.hierarchy}; Cases do not assert this value.
	 *
	 * The ablation layer's degradation ladder is synthesized from the gazetteer `placeID`s.
	 * An empty array means the run resolved no admin-grade entry.
	 */
	hierarchy: Array<{ tag: string; name: string; placeID?: string; lat?: number; lon?: number }>
	/**
	 * The stage-1 admin-coherence verdicts, verbatim from {@linkcode GeocodeResult.admin_coherence};
	 * Cases do not assert these flag-only measurements.
	 *
	 * A dev-mcp row can count verdicts per component across a board run.
	 * The field is absent when the geocode resolved no winner to check.
	 */
	admin_coherence?: AdminCoherenceReport
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
		...(g.capital_promotion === undefined ? {} : { capital_promotion: g.capital_promotion }),
		...(g.variant_alias_exemption === true ? { variant_alias_exemption: true as const } : {}),
		...(g.admin_coherence ? { admin_coherence: g.admin_coherence } : {}),
		hierarchy: g.hierarchy.map((h) => ({
			tag: h.tag,
			name: h.name,
			...(h.placeID ? { placeID: h.placeID } : {}),
			...(h.lat != null ? { lat: h.lat, lon: h.lon! } : {}),
		})),
	}
}
