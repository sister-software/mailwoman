/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Shared Gauntlet harness: build the full-pipeline geocode deps (optionally with a CANDIDATE model, so a
 *   gate can compare candidate-vs-production on the same inputs) and run one address end-to-end. The
 *   Gauntlet grades the ASSEMBLED output — coordinate + tier — not raw parse F1, the lesson this project
 *   paid for once (#566 / reconcile-retirement).
 */

import { createHash } from "node:crypto"
import { existsSync, readFileSync } from "node:fs"
import { resolve } from "node:path"

import { tryParsingJSON } from "@mailwoman/core/objects"
import { dataRootPath } from "@mailwoman/core/utils"
import { createScorer, NeuralAddressClassifier } from "@mailwoman/neural"
import { readDeclaredArtifactFile, resolveWeights, weightsCachePackageDir } from "@mailwoman/neural/weights"
import { createWOFResolver } from "@mailwoman/resolver"

import { type GeocodeResult, geocodeAddress, ShardProvider, type GeocodeDeps } from "../../geocode-core.ts"
import { createResolverBackend, mailwomanDataRoot, wofShardPaths } from "../../resolver-backend.ts"

export interface GauntletDeps {
	geocode(input: string, opts?: GauntletGeocodeOpts): Promise<GeocodeResult>
	close(): void
}

/**
 * Everything {@linkcode buildGauntletDeps} needs: which MODEL to grade, and which RESOLVER configuration to grade it in.
 */
export interface GauntletDepsOptions {
	/**
	 * Candidate ONNX (swaps ONLY the model — see {@linkcode buildGauntletDeps}).
	 */
	modelPath?: string
	/**
	 * Candidate tokenizer (a SPLICE candidate's new vocab).
	 */
	tokenizerPath?: string
	/**
	 * Candidate model-card, paired with `tokenizerPath`.
	 */
	modelCardPath?: string
	/**
	 * Package-shaped candidate weights dir — the #718-safe path.
	 */
	weightsCacheRoot?: string
	/**
	 * Resolver-side lever pins applied to every geocode this deps object performs.
	 */
	levers?: GauntletResolverLevers
}

/**
 * RESOLVER-side levers a gauntlet run can PIN — the counterpart to the model-side `modelPath`/`tokenizerPath` swaps.
 * Both kinds of pin exist for the same reason: the gate has to be able to grade the exact configuration a ship would
 * use, and a lever that cannot be switched here has never been through the D-rule's standard instrument.
 *
 * The idiom is `eval oa-resolver`'s (`adminCoherence` / `postcodeCountryCoherence` boolean pins forwarded verbatim into
 * the resolve): a pin here is a DEFAULT-OVERRIDE, not a new mechanism — every field maps 1:1 onto a
 * {@linkcode geocodeAddress} dep of the same name, and an absent field leaves the production default in force.
 *
 * `undefined` means "production default", not "off": the library defaults are the thing under test, so the pin only
 * ever speaks when the runner set it.
 */
export interface GauntletResolverLevers {
	/**
	 * #42 postcode-country coherence — a (postcode, locality) pair coherent in exactly one country overrides a wrong
	 * `defaultCountry`. Library default ON since the 2026-08-05 promotion (this pin was the D-rule evidence path that got
	 * it there); the `false` pin now grades the pre-promotion configuration.
	 */
	postcodeCountryCoherence?: boolean
}

/**
 * The geocode deps a lever set turns into — spread into every {@linkcode geocodeAddress} call the run makes. Pure and
 * exported so the "the pin reaches the pipeline" contract is testable without building the ~9 GB shard set.
 */
export function resolverLeverDeps(levers: GauntletResolverLevers | undefined): { postcodeCountryCoherence?: boolean } {
	if (!levers) return {}

	// A key is emitted only when the runner SET it — an `undefined` value would still be an own property, and
	// `{postcodeCountryCoherence: undefined}` spread into the geocode deps reads as an explicit pin to a reader.
	return levers.postcodeCountryCoherence === undefined
		? {}
		: { postcodeCountryCoherence: levers.postcodeCountryCoherence }
}

/**
 * One-line description of the pinned levers for the run banner. Prints on EVERY run, including the unpinned one, so a
 * reader of two gauntlet logs can tell which configuration each graded — an OFF/ON pair whose logs are
 * indistinguishable is not evidence about the lever.
 */
export function describeResolverLevers(levers: GauntletResolverLevers | undefined): string {
	const deps = resolverLeverDeps(levers)
	const entries = Object.entries(deps)

	if (!entries.length) return "resolver levers: (none pinned — production defaults)"

	return `resolver levers: ${entries.map(([k, v]) => `${k}=${v ? "ON" : "OFF"}`).join(", ")}`
}

/**
 * Per-query resolution priors a case can carry (forwarded verbatim to {@linkcode geocodeAddress}).
 */
export interface GauntletGeocodeOpts {
	/**
	 * Resolver country prior (ISO-3166 alpha-2) — geocodeAddress's `defaultCountry`.
	 */
	defaultCountry?: string
	/**
	 * The case's country (ISO-3166 alpha-2) — selects the per-locale weights OVERLAY the classifier loads with (GB →
	 * en-GB's pair-index, NZ → en-NZ's). Production routes by locale-gate; a harness that grades every row through the
	 * bare en-US package silently drops the deploc prior (caught 2026-08-01: 53 operator probes read "dependent_locality
	 * never emitted" when the MECHANISM was fine and the INSTRUMENT was base-only). Absent → en-US.
	 */
	caseCountry?: string
	/**
	 * #1585 — the locale hint's country for the typo-fuzzy tier (geocodeAddress's `fuzzyCountryScope`). The runner
	 * derives it from a row's `locale` field; forwarded verbatim like `defaultCountry`.
	 */
	fuzzyCountryScope?: string
}

/**
 * #1024 drift guard: the materialized `neural-weights-en-us/model.onnx` the gate is about to grade MUST match the
 * model-card's `files_md5["model.onnx"]` — the card (source of truth) and `release.config.json` (what copy-weights.ts
 * materializes from) drifted once and the superseded model shipped past a silent gate. Throws loudly on mismatch so the
 * release before:release step (RELEASING.md) blocks the ship. Only the shipped default is checked; a `--candidate` run
 * grades a different artifact by design. Soft-returns when the card / field is absent (a card-format problem is not
 * this guard's job) — the model file itself is always present here (the caller `existsSync`-gated it).
 */
function assertShippedModelMatchesCard(materializedMd5: string): void {
	const cardPath = resolve("neural-weights-en-us/model-card.json")

	if (!existsSync(cardPath)) return
	// Soft-return on an UNPARSEABLE card too — the docstring's contract is that a card-format problem is
	// not this guard's job (the model file itself is always existsSync-gated by the caller).
	const card = tryParsingJSON<{ version?: string; files_md5?: Record<string, string> }>(readFileSync(cardPath, "utf8"))

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
				`(scripts/copy-weights.ts) or fix release.config.json weights.model before gating/shipping.`
		)
	}
}

/**
 * Assert that every locale this run can route to actually HAS the anchor binary its own weights card declares.
 *
 * The instrument-integrity claim (#1516): a grading environment states its artifact expectations up front, because the
 * failure it is guarding against has no signal of its own. A missing `postcode-us.bin` does not error — the anchor
 * channel resolves OFF, the run scores 3-4 baseline cases lower, and the operator reads a model regression. The
 * classifier's own warning cannot cover this: at load time nothing knows whether THIS run needs GB anchors.
 *
 * EXPECTATIONS COME FROM EACH PACKAGE'S OWN CARD (`files.postcode_anchor`), never from a list kept here. en-gb
 * deliberately ships no binary under the #1476 mitigation until the A4 assembly lands, and en-nz has no WOF NZ postcode
 * shard to build one from; a hardcoded list would call both of those supported states broken, and would need editing
 * every time a locale's posture changed — which is the same drift the card exists to prevent.
 *
 * A package that does not RESOLVE at all is not this guard's business: that is `classifierFor`'s loud base-only
 * fallback, a different failure with a different repair (install the overlay, vs. materialize its artifact).
 *
 * Exported for `anchor-presence.test.ts`, which poses both postures against fixture packages — the real ones cannot
 * express "declared and missing" without mutating the workspace.
 */
export function assertDeclaredAnchorBins(locales: readonly string[], cacheRoot?: string): void {
	const missing: string[] = []

	for (const locale of locales) {
		let packageDir: string | undefined

		try {
			packageDir = resolveWeights({ locale, ...(cacheRoot ? { cacheRoot } : {}) }).packageDir
		} catch {
			continue
		}

		const declared = readDeclaredArtifactFile(packageDir)

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
 * Build the geocode deps. `modelPath` swaps ONLY the ONNX (same tokenizer/card/anchor/gazetteer soft-feed), so the
 * held-out gate can grade a candidate against production fairly; omit it for the shipped default.
 *
 * `tokenizerPath` (+ optional `modelCardPath`) additionally swaps the VOCAB — required to grade a tokenizer-SPLICE
 * candidate (#444/#884/#912), whose model has extra embedding rows a plain `modelPath` swap can never exercise (the
 * shipped tokenizer emits no ids for the new pieces, so the candidate would score byte-identical to production and the
 * splice would be invisible). When a tokenizer is given the classifier is built via `createScorer` (which wires the
 * anchor + gazetteer soft-feeds the model requires); pair it with the matching shipped trio on the production side so
 * the ONLY variables are the ONNX + the vocab (see holdout.ts).
 */
export async function buildGauntletDeps(opts: GauntletDepsOptions = {}): Promise<GauntletDeps> {
	const resolverMod = await import("@mailwoman/resolver-wof-sqlite")

	// A candidate laid out as a package-shaped weights dir (`<cacheRoot>/node_modules/@mailwoman/neural-weights-en-us`).
	// PREFER THIS over modelPath for a candidate with a DIFFERENT vocab (splice/multisplice): `loadFromWeights({cacheRoot})`
	// resolves the model + tokenizer + card + anchor/gazetteer siblings package-shaped, exactly as production does — the
	// #718-safe path, identical to `eval parity --weights-cache`. A bare `modelPath` swap feeds NO soft channels (the
	// zero-fill trap) AND keeps the shipped tokenizer, so a multisplice candidate would score byte-identical to prod.
	const cacheModel = opts.weightsCacheRoot
		? resolve(weightsCachePackageDir(opts.weightsCacheRoot, "en-us"), "model.onnx")
		: undefined

	// Transparency: stamp the model under test so a stale dev symlink (the d6812bc7 trap — the default
	// loadFromWeights symlink can point at an old training base, not the shipped model) is never silent.
	const effModel = cacheModel ?? (opts.modelPath ? resolve(opts.modelPath) : resolve("neural-weights-en-us/model.onnx"))

	if (existsSync(effModel)) {
		const md5 = createHash("md5").update(readFileSync(effModel)).digest("hex")

		console.error(`[gauntlet] model under test: ${effModel.split("/").slice(-2).join("/")} (md5 ${md5.slice(0, 8)})`)

		// #1024: the transparency stamp exposed a config↔card drift once (release.config.json still pointed at
		// v220 a64ad2e6 while the v5.4.0 promote shipped v230 ea785a70), so copy-weights.ts materialized the
		// SUPERSEDED model and this gate SILENTLY graded it — a full bisect detour. Make the stamp ASSERT: the
		// shipped default must match the model-card's files_md5 (the card is the source of truth). A `--candidate`
		// run intentionally grades a different artifact, so it is exempt. This gate is wired as the release
		// before:release step (RELEASING.md), so failing here guards BOTH the gate and the ship.
		if (!opts.modelPath && !opts.tokenizerPath && !opts.weightsCacheRoot) {
			assertShippedModelMatchesCard(md5)
		}
	}

	const classifier = opts.weightsCacheRoot
		? await NeuralAddressClassifier.loadFromWeights({ locale: "en-US", cacheRoot: opts.weightsCacheRoot })
		: opts.tokenizerPath
			? await createScorer({
					modelPath: resolve(opts.modelPath ?? "neural-weights-en-us/model.onnx"),
					tokenizerPath: resolve(opts.tokenizerPath),
					modelCardPath: resolve(opts.modelCardPath ?? "neural-weights-en-us/model-card.json"),
					locale: "en-us",
				})
			: opts.modelPath
				? await NeuralAddressClassifier.loadFromWeights({ locale: "en-US", modelPath: resolve(opts.modelPath) })
				: await NeuralAddressClassifier.loadFromWeights({ locale: "en-US" })

	// Per-country overlay classifiers (2026-08-01): a case's country selects the weights OVERLAY so
	// GB rows grade with en-GB's pair-index + transition-beta exactly as production's locale-gate
	// routes them. Lazy + memoized; a missing overlay package (e.g. a candidate weights-cache built
	// without neural-weights-en-gb) falls back to the base classifier with ONE loud warning per
	// locale — base-only grading must never be silent again (the meaning-of-zero rule).
	// Every locale that ships its own weights overlay belongs here. A case whose country is absent grades through the
	// BASE en-US package, which carries no pair index for that country — so its dependent locality silently never
	// fires and the row looks like a model failure. That exact artifact burned an afternoon in R1, when 53 operator
	// probes read "dependent_locality never emitted" while the mechanism was fine and the INSTRUMENT was base-only.
	const OVERLAY_LOCALE_BY_COUNTRY: Record<string, string> = {
		GB: "en-GB",
		NZ: "en-NZ",
		DE: "de-DE",
		IN: "en-IN",
		ES: "es-ES",
		IT: "it-IT",
	}

	// #1516 second half: a grading environment must STATE its artifact expectations, not discover them in a
	// degraded number. A missing `postcode-us.bin` costs 3-4 baseline cases and produces no failure of its own —
	// the run simply scores lower, and the operator reads a model regression. Checked for the base locale plus
	// every overlay the corpus can route to (the map above), because the anchor artifact is per-package.
	if (!opts.modelPath && !opts.tokenizerPath) {
		assertDeclaredAnchorBins(["en-US", ...Object.values(OVERLAY_LOCALE_BY_COUNTRY)], opts.weightsCacheRoot)
	}

	const overlayClassifiers = new Map<string, typeof classifier>()
	const warnedOverlays = new Set<string>()

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
			if (!warnedOverlays.has(overlayLocale)) {
				warnedOverlays.add(overlayLocale)

				console.error(
					// oxlint-disable-next-line mailwoman/prefer-spliterator -- An Error message, not a data file.
					`[gauntlet] ⚠ ${overlayLocale} overlay unavailable (${(error as Error).message.split("\n")[0]}) — ` +
						`grading ${caseCountry} cases BASE-ONLY (no pair-index/deploc prior). ` +
						`For production-true grading, include @mailwoman/neural-weights-${overlayLocale.toLowerCase()} in the weights cache.`
				)
			}

			overlayClassifiers.set(overlayLocale, classifier)

			return classifier
		}
	}

	const resolver = createWOFResolver(
		createResolverBackend(resolverMod, { wofPaths: wofShardPaths().filter(existsSync) })
	)

	const shardProvider = new ShardProvider(resolverMod, mailwomanDataRoot())
	// Lazy like the resolver module above: `@mailwoman/osm` is an in-repo (unpublished) workspace, and
	// Pastel imports every command module at CLI startup — a static import here would break the
	// published `mailwoman` CLI outright rather than only this maintainer-run gate.
	const { OSMShardProvider } = await import("@mailwoman/osm/sdk")
	const osmProvider = new OSMShardProvider(mailwomanDataRoot())
	// The BAN national-register tier (#1012) sits AHEAD of OSM in production (geocode.tsx wires it the
	// same way) — without it here the gauntlet graded an OSM-first cascade production never runs, and
	// the fr-chevaleret-bare pin silently guarded the wrong tier (caught 2026-07-10 when the BAN tier's
	// missing bbox fall-through regressed the bare form in production while this gate stayed green).
	const { BANShardProvider } = await import("@mailwoman/ban/sdk")
	const banProvider = new BANShardProvider(mailwomanDataRoot())

	const leverDeps = resolverLeverDeps(opts.levers)

	console.error(`[gauntlet] ${describeResolverLevers(opts.levers)}`)

	// The fork→entity probe's two signals — both or neither, tolerate-and-degrade like every optional
	// artifact (a machine without poi.db grades the incumbent behavior; the fork-entity board rows are
	// improvement_target until it is present). Mirrors the CLI's wiring exactly, so the board grades
	// what production runs.
	let forkEntityDeps: Pick<GeocodeDeps, "poiLookup" | "isStreetGeneric"> = {}
	const poiDBPath = String(dataRootPath("poi", "poi.db"))

	if (existsSync(poiDBPath)) {
		const [{ POILookup }, { loadStreetMorphologyFST }] = await Promise.all([
			import("@mailwoman/resolver-wof-sqlite/poi-lookup"),
			import("@mailwoman/resolver-wof-sqlite/street-morphology-fst-loader"),
		])

		const morphology = loadStreetMorphologyFST()

		forkEntityDeps = {
			poiLookup: new POILookup({ databasePath: poiDBPath }),
			isStreetGeneric: (token: string) => morphology.matcher.walk([token]) !== null,
		}
	}

	return {
		geocode: async (input: string, geoOpts?: GauntletGeocodeOpts) => {
			const { caseCountry, ...forwarded } = geoOpts ?? {}

			return geocodeAddress(input, {
				classifier: await classifierFor(caseCountry),
				resolver,
				shards: shardProvider.for,
				nationalShards: banProvider.for,
				osmShards: osmProvider.for,
				...leverDeps,
				...forkEntityDeps,
				...forwarded,
			})
		},
		close: () => {
			shardProvider.close()
			banProvider.close()
			osmProvider.close()
		},
	}
}

/**
 * The slice of the assembled result the Gauntlet asserts on.
 */
export interface GauntletResult {
	/**
	 * All parsed components, including locale-specific tags that have no legacy named result slot.
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
	 * The parsed spans, populated regardless of tier (geocode-core #1041) — asserted by venue/name-trap cases.
	 */
	house_number: string | null
	street: string | null
	venue: string | null
	dependent_locality: string | null
	/**
	 * The parsed unit / sub-venue span — asserted by the 2026-08-01 sub-venue cases, which had never once been graded: no
	 * result field carried it, so `componentOf` threw the instant the corpus was rebuilt from its own seed.
	 */
	unit: string | null
	/**
	 * The country #42's coherence pass scoped this row to, or null when nothing was overridden. Not asserted by any case
	 * — it is the FIRING COUNT, so a lever-pinned run can say how many rows the mechanism actually spoke on rather than
	 * leaving an unchanged verdict to mean either "harmless" or "never ran".
	 */
	postcode_country_scope: string | null
	/**
	 * The RESOLVED admin chain, locality → country, verbatim from {@linkcode GeocodeResult.hierarchy}. Not asserted by any
	 * case: it carries the gazetteer `placeID`s, which is what the ablation layer's graceful-degradation ladder is
	 * synthesized FROM (the undeleted case's resolved place → its WOF ancestry). Only entries the resolver actually
	 * decorated appear here, so an empty array means the run resolved nothing admin-grade — absence, not a flat world.
	 */
	hierarchy: Array<{ tag: string; name: string; placeID?: string; lat?: number; lon?: number }>
}

export async function runOne(input: string, deps: GauntletDeps, opts?: GauntletGeocodeOpts): Promise<GauntletResult> {
	const g = await deps.geocode(input, opts)

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
		hierarchy: g.hierarchy.map((h) => ({
			tag: h.tag,
			name: h.name,
			...(h.placeID ? { placeID: h.placeID } : {}),
			...(h.lat != null ? { lat: h.lat, lon: h.lon! } : {}),
		})),
	}
}
