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
import { createScorer, NeuralAddressClassifier } from "@mailwoman/neural"
import { createWOFResolver } from "@mailwoman/resolver"

import { type GeocodeResult, geocodeAddress, ShardProvider } from "../../geocode-core.ts"
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
	 * `defaultCountry`. Library default OFF; this pin is the D-rule evidence path to default-on.
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
		? resolve(opts.weightsCacheRoot, "node_modules/@mailwoman/neural-weights-en-us/model.onnx")
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
}

export async function runOne(input: string, deps: GauntletDeps, opts?: GauntletGeocodeOpts): Promise<GauntletResult> {
	const g = await deps.geocode(input, opts)

	return {
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
	}
}
