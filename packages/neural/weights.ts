/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Weight-package resolution.
 *
 *   The `@mailwoman/neural-weights-<locale>` packages ship the `model.onnx` + `tokenizer.model` files
 *   declared in their `files` array. At install time npm bundles those files alongside the
 *   package.json; at runtime we locate them by resolving the package.json then walking sideways.
 *
 *   Local development gotcha: the weights packages in the monorepo carry only metadata (package.json
 *
 *   - README.md + model-card.json). The actual binary files are produced by Phase 2 training and copied
 *       in at publish time. To run the neural classifier locally without publishing, either:
 *
 *   1. Pass explicit `modelPath` + `tokenizerPath` to `loadFromWeights`, or
 *   2. Symlink the dev model files into the weights package directory — see
 *        `scripts/link-dev-weights.ts` in each weights package.
 *
 *   The resolver checks for both files and throws a single actionable error when neither is findable,
 *   naming all the paths it tried.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { basename, dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import { tryParsingJSON } from "@mailwoman/core/objects"
import { dataRootPath, weightsOverlayPath } from "@mailwoman/core/utils"

import type { AnchorSpanMode } from "./anchor-inference.ts"
import { PlacetypeCensusResolver } from "./placetype-census.ts"

/**
 * A weights package's own directory, located with Node's native ESM resolver.
 *
 * WHY THE `package.json` SUBPATH AND NOT `findPackageJSON`. `node:module`'s `findPackageJSON` reads like the obvious
 * tool for "give me a package's root", and it is the one that keeps working if a weights package ever grows an
 * `exports` map that omits `./package.json` (none has one today — they are data-only packages with no `exports` at all,
 * which is why the subpath resolves). But measured in this yarn workspace it returns the node_modules SYMLINK path
 * (`node_modules/@mailwoman/neural-weights-en-us`) where `import.meta.resolve` — like the `require.resolve` this
 * replaced — realpaths through to the workspace directory (`neural-weights-en-us`). That string is not internal: it
 * lands in {@link ResolvedWeights.modelPath}, in the "missing model files" error, and (via the caller) in `mailwoman
 * doctor` output. So the subpath form is the one that is byte-identical to the previous behavior.
 *
 * Throws `ERR_MODULE_NOT_FOUND` when the package is not installed (the CJS twin threw `MODULE_NOT_FOUND`; no caller
 * branches on the code — both sites catch broadly and fall through).
 */
function resolvePackageDirectory(packageName: string): string {
	return dirname(fileURLToPath(import.meta.resolve(`${packageName}/package.json`)))
}

/**
 * The user-level npm-prefix cache the CLI weights guard installs into (`mailwoman parse --download-weights`, plan 3).
 * Laid out by `npm install --prefix`, so a cached package dir sits at
 * `<cache>/node_modules/@mailwoman/neural-weights-<locale>` and resolves sibling artifacts exactly like an installed
 * package.
 */
export function weightsCacheDir(): string {
	return resolve(homedir(), ".cache", "mailwoman", "weights")
}

/**
 * The data-root weights overlay: `$MAILWOMAN_DATA_ROOT/weights/<locale>/`, laid out with the SHIPPED filenames.
 *
 * A dev checkout carries no `model.onnx` — the binaries are not in git — so the workspace package always resolves and
 * is always empty, and before this probe existed that was terminal. Measured on a git worktree: the engine could not be
 * built at all.
 *
 * The layout is the shipped one deliberately, so {@link resolveFromPackageDir} needs no branch for it. What populates
 * the directory is a dev concern (`release.config.json` names the artifacts); this package knows only the CONVENTION,
 * because it ships to npm and must not carry a recipe consumers cannot use.
 */
export function weightsOverlayRoot(): string {
	return String(dataRootPath("weights"))
}

/**
 * The overlay directory for one locale — the same path the dev linkers write, via the same helper.
 */
export function weightsOverlayDir(locale: string): string {
	return String(weightsOverlayPath(locale))
}

/**
 * The weights package for a locale tag, normalized to the all-lowercase BCP-47 package convention.
 */
export function weightsPackageName(locale?: string): string {
	return `@mailwoman/neural-weights-${(locale ?? "en-us").toLowerCase()}`
}

/**
 * The package directory a weights CACHE root holds for a locale — `<cacheRoot>/node_modules/@mailwoman/neural-weights-
 * <locale>`.
 *
 * THE ONE PLACE THAT LAYOUT IS SPELLED OUT (2026-08-06 triage). Hand-assembling a `node_modules/...` path is normally
 * the smell that says a package should have been located with `import.meta.resolve` or an exports subpath; this is the
 * one site in the tree where it is the correct answer, and it earns that by being the inverse of a resolution rather
 * than a substitute for one. The directory does not exist yet at the moment the layout is needed — `mailwoman parse
 * --download-weights` runs `npm install --prefix <cacheRoot>`, and an eval harness lays a CANDIDATE bundle out with
 * `scripts/stage-weights-cache.ts` — so there is nothing for a resolver to resolve. `import.meta.resolve` would also
 * answer from THIS module's graph (the monorepo), which is precisely the bundle the candidate is being graded against.
 *
 * Ten call sites across seven files had re-typed the literal (the promotion gate, the gauntlet harness,
 * `stage-weights-cache.ts`, and four test files); they now call this, so the day npm's prefix layout or the package
 * scope changes, one line moves. The one file that still spells it out is `neural/test/weights-cache.test.ts`, on
 * purpose — it is the ORACLE for this layout, and a fixture built with this helper could not fail when this helper is
 * wrong.
 *
 * Not `existsSync`-checked: callers want the path they are about to WRITE as often as one they mean to read.
 * {@linkcode resolveWeights} probes it for the two binaries before trusting it.
 */
export function weightsCachePackageDir(cacheRoot: string, locale?: string): string {
	return resolve(cacheRoot, "node_modules", weightsPackageName(locale))
}

export interface ResolveWeightsOpts {
	/**
	 * BCP-47-ish locale tag, e.g. "en-us" or "fr-fr". Used to pick the weights package.
	 */
	locale?: string
	/**
	 * Explicit model.onnx path; takes precedence over package auto-resolve.
	 */
	modelPath?: string
	/**
	 * Explicit tokenizer.model path; takes precedence over package auto-resolve.
	 */
	tokenizerPath?: string
	/**
	 * Explicit `model-card.json` path (for the label vocab) on the explicit model+tokenizer path. When omitted, falls
	 * back to a `model-card.json` co-located with `modelPath`. Without a card, labels default to `STAGE2_BIO_LABELS` —
	 * which silently mis-decodes a STAGE3 (33-label) model into empty/garbage parses. Pass this (or co-locate the card)
	 * when evaluating a custom STAGE3 checkpoint via explicit paths.
	 */
	modelCardPath?: string
	/**
	 * The BASE package's `model-card.json`, when this package declares `mailwoman.baseWeights` and the base is
	 * resolvable.
	 *
	 * An overlay card describes the OVERLAY (its version, its own artifacts) while the vocabulary belongs to the shared
	 * base model — so fields that describe the MODEL must fall back here rather than being copied per overlay, which is
	 * the duplication that goes stale on the first retrain.
	 */
	baseModelCardPath?: string
	/**
	 * Serving tier (#718 D1). `"server"` (default) = anchor + gazetteer channels; `"pocket"` = anchor-only (skip the
	 * gazetteer lexicon even when shipped). Selects which soft-feature sibling artifacts {@link resolveWeights} surfaces —
	 * the loader feeds only the resolved channels.
	 */
	tier?: "server" | "pocket"
	/**
	 * Override the user-level weights cache root probed after package resolution fails (plan 3 guard). Defaults to
	 * {@link weightsCacheDir}. Primarily a test seam.
	 */
	cacheRoot?: string
	/**
	 * Override the data-root weights overlay root probed when the package carries no binaries. Defaults to
	 * {@link weightsOverlayRoot}. Primarily a test seam.
	 */
	overlayRoot?: string
}

/**
 * Which directory an artifact was resolved from.
 *
 * Named rather than inferred from the path, because the four are indistinguishable by shape — every one of them is a
 * directory holding the same fixed filenames, which is what lets {@link resolveFromPackageDir} serve them all.
 */
export const WeightsOrigin = {
	/**
	 * A path the caller supplied outright.
	 */
	Explicit: "explicit",
	/**
	 * The resolved weights package's own directory.
	 */
	Package: "package",
	/**
	 * The BASE package, reached through `mailwoman.baseWeights` — an overlay sharing the base model rather than shipping
	 * its own copy.
	 */
	Base: "base",
	/**
	 * The data-root overlay ({@link weightsOverlayRoot}) — a dev checkout whose package carries no binaries.
	 */
	Overlay: "overlay",
	/**
	 * The user-level weights cache written by `mailwoman parse --download-weights`.
	 */
	Cache: "cache",
} as const

export type WeightsOrigin = (typeof WeightsOrigin)[keyof typeof WeightsOrigin]

/**
 * One artifact's resolution outcome. `path: null` with `origin: null` is ABSENCE — the artifact was looked for and not
 * found — and is reported rather than omitted, because an omitted entry cannot be told apart from a field this build
 * never had.
 */
export interface WeightsArtifactReport {
	name: string
	path: string | null
	origin: WeightsOrigin | null
}

export interface ResolvedWeights {
	modelPath: string
	tokenizerPath: string
	/**
	 * Path to `model-card.json` for the resolved model. On the package path, the card co-located in the package dir. On
	 * the explicit path, `opts.modelCardPath` or a card co-located with `modelPath`. `undefined` only when no card is
	 * found. Read by `loadFromWeights` to thread the trained label vocabulary into the classifier — see
	 * {@link readLabelsFromModelCard}.
	 */
	modelCardPath?: string
	/**
	 * The BASE package's `model-card.json`, when this package declares `mailwoman.baseWeights` and the base is
	 * resolvable.
	 *
	 * An overlay card describes the OVERLAY (its version, its own artifacts) while the vocabulary belongs to the shared
	 * base model — so fields that describe the MODEL must fall back here rather than being copied per overlay, which is
	 * the duplication that goes stale on the first retrain.
	 */
	baseModelCardPath?: string
	/**
	 * Path to `crf-transitions.json` alongside the resolved model. `undefined` when the file doesn't exist (pre-v0.6.0
	 * bundles or CE-only training).
	 */
	crfTransitionsPath?: string
	/**
	 * Path to `semi-crf-transitions.json` alongside the resolved model — the #727 stage-2 segment-transition grammar the
	 * span head's k-best decode consumes. `undefined` on a pre-v3 bundle (no span head). Read by `loadFromWeights` to
	 * expose {@link NeuralAddressClassifier.spanGrammar} for the phase-4c name-evidence rerank.
	 */
	semiCRFTransitionsPath?: string
	/**
	 * Path to the postcode→anchor source shipped beside the resolved model (#718 D1) — the soft-feed `loadFromWeights`
	 * reads to feed the anchor channel without a callsite change. Prefer the compact PCB1 binary (`postcode-<cc>.bin`,
	 * decoded via `PostcodeBinaryResolver.toAnchorLookup()`), else a JSON anchor lookup (`anchor-lookup.json`, parsed via
	 * `parseAnchorLookup`). `undefined` when the package ships neither (a plain/pre-#718 bundle) — the loader then runs
	 * anchor-OFF. The `binary` flag tells the loader which parser to use.
	 */
	anchorLookupPath?: { path: string; binary: boolean }
	/**
	 * Path to the gazetteer-anchor lexicon (`anchor-lexicon-v1.json`, #464) shipped beside the resolved model.
	 * `undefined` when the package doesn't ship it, OR when `opts.tier === "pocket"` (pocket is anchor-only — the
	 * gazetteer channel is deliberately skipped). Read by the `loadFromWeights` soft-feed via `parseGazetteerLexicon`.
	 */
	gazetteerLexiconPath?: string
	/**
	 * Path to the country-surface lexicon (`country-surface-lexicon-v1.json`, #1104) shipped beside the resolved model.
	 * `undefined` when the package doesn't ship it, OR when `opts.tier === "pocket"` (anchor-only). Read by the
	 * `loadFromWeights` soft-feed via `parseCountryLexicon`.
	 */
	countryLexiconPath?: string
	/**
	 * Street-type evidence lexicon sibling (Option-A bundle, Phase 2). The GENERATION comes from the card's
	 * `requires.street_type.lexicon` (#1510); a card that names none falls back to `street-type-lexicon-v3.json` with a
	 * warning. Server tier only; ships at the promote whose model requires the bundle channels.
	 */
	streetTypeLexiconPath?: string
	/**
	 * Locality-surface evidence lexicon sibling (Option-A bundle). Card-declared generation, same contract as
	 * {@link ResolvedWeights.streetTypeLexiconPath}; legacy fallback `locality-surface-lexicon-v6.json`.
	 */
	localitySurfaceLexiconPath?: string
	/**
	 * Path to the per-locale FST gazetteer (`fst-<locale>.bin`) shipped beside the resolved model. `undefined` when the
	 * package doesn't ship one (e.g. en-nz — byte-stable). PATH ONLY: `neural` deliberately carries no
	 * `@mailwoman/resolver-wof-sqlite` dependency (the FST prior consumes a structural `FSTMatcherLike`), so
	 * deserialization happens in the caller's layer — `loadFromWeights` surfaces the path on the classifier
	 * ({@link NeuralAddressClassifier.fstPath}) and the mailwoman runtime pipeline auto-loads it from there.
	 */
	fstPath?: string
	/**
	 * Path to the locale-GENERAL street-morphology FST (`fst-street-morphology.bin`) shipped beside the resolved model —
	 * the #1315 street-context gate's signal source, serialized at build time (`mailwoman gazetteer build
	 * street-morphology`) instead of rebuilt from the libpostal dictionaries per process. `undefined` when the package
	 * doesn't ship it (the runtime pipeline then falls back to the data-root staging artifact or a per-process dictionary
	 * build). PATH ONLY, same posture as {@link ResolvedWeights.fstPath}: deserialization happens in the caller's layer.
	 * Unlike the per-locale FST it may also resolve from the `baseWeights` package (the artifact is identical across
	 * locales, so a data-only overlay need not ship its own copy).
	 */
	streetMorphologyPath?: string
	/**
	 * Path to the placetype-pair index (`pair-index-<cc>.bin`, PIX1 format, placetype-pair-prior arc) shipped beside the
	 * resolved model. `undefined` when the package doesn't ship one. COUNTRY-SPECIFIC BY DESIGN — see
	 * {@link resolvePairIndexSibling}: unlike the model/tokenizer/model-card, this artifact never falls back to a
	 * `baseWeights` package (a shared base ships no locale-specific pairs to offer; en-us has none, en-gb ships its own
	 * locally). Read by `loadFromWeights` to construct a `PairIndexResolver` for the `placetypePair` prior default.
	 */
	pairIndexPath?: string
	/**
	 * "explicit" if both paths came from opts; "package:<name>" if located via {@link resolvePackageDirectory}.
	 */
	source: string
	/**
	 * The weights PACKAGE directory this resolution came from — `undefined` only for the fully-explicit
	 * (`modelPath`+`tokenizerPath`) path, which has no package.
	 *
	 * Every other field is a resolved artifact path, which cannot answer "what was this package supposed to ship?" — an
	 * absent artifact simply leaves its field `undefined`, and absence is exactly the question the anchor-presence guards
	 * ask ({@link readDeclaredArtifactFile}, `harness.ts`'s grading-environment assertion). Note it is NOT
	 * `dirname(modelPath)`: under `mailwoman.baseWeights` an overlay's model resolves from the BASE package while its
	 * data siblings and its own card stay local.
	 */
	packageDir?: string
	/**
	 * Every known sibling artifact, with where it came from — or `null` on both fields when it did not resolve.
	 *
	 * Load-bearing rather than diagnostic. Only `model.onnx` and `tokenizer.model` make resolution fail; the other ~11
	 * artifacts degrade to `undefined` by design, so a checkout that finds the two binaries parses successfully with no
	 * lexicons, no FST and no pair index — scoring worse, and silently. That silence is affordable only while the
	 * binaries and the siblings travel together, which the data-root overlay rung stopped guaranteeing. The report is
	 * what `mailwoman doctor` renders so "which half do I have" answers at the artifact level.
	 *
	 * The list is FIXED: every known artifact appears every time, so the denominator does not move with the answer.
	 */
	artifacts: WeightsArtifactReport[]
}

/**
 * Classify a resolved path by the directory it came from.
 *
 * A path comparison rather than threading an origin through every resolution site: the sites already differ in shape
 * (some check a base fallback, some deliberately do not), and adding a second return value to each is how the two
 * drift. `dirname` is exact here because every artifact is resolved as `resolve(<dir>, <fixed-name>)`.
 */
function originOf(
	path: string | undefined,
	dirs: Partial<Record<WeightsOrigin, string | undefined>>
): WeightsOrigin | null {
	if (!path) return null

	const parent = dirname(path)

	for (const [origin, dir] of Object.entries(dirs)) {
		if (dir && resolve(dir) === resolve(parent)) return origin as WeightsOrigin
	}

	// Resolved from somewhere none of the known directories names. Reporting the absence of a classification beats
	// guessing one — a wrong origin is worse than no origin, because it reads as a checked fact.
	return null
}

/**
 * Build the fixed artifact report. `entries` is every artifact this resolution KNOWS ABOUT, resolved or not, so the
 * report's denominator does not move with its answer.
 */
function buildArtifactReport(
	entries: ReadonlyArray<readonly [name: string, path: string | undefined]>,
	dirs: Partial<Record<WeightsOrigin, string | undefined>>
): WeightsArtifactReport[] {
	return entries.map(([name, path]) => ({ name, path: path ?? null, origin: originOf(path, dirs) }))
}

export function resolveWeights(opts: ResolveWeightsOpts): ResolvedWeights {
	const tried: string[] = []

	if (opts.modelPath && opts.tokenizerPath) {
		if (!existsSync(opts.modelPath)) throw new Error(`Explicit modelPath does not exist: ${opts.modelPath}`)

		if (!existsSync(opts.tokenizerPath)) throw new Error(`Explicit tokenizerPath does not exist: ${opts.tokenizerPath}`)
		// Resolve a model-card for the label vocab: explicit opt first, else one co-located with the
		// model. Omitting it makes the classifier fall back to STAGE2_BIO_LABELS, which mis-decodes a
		// STAGE3 (33-label) checkpoint into empty parses — the trap that broke eval-matrix --model-path.
		const coLocatedCard = resolve(dirname(opts.modelPath), "model-card.json")
		const modelCardPath = opts.modelCardPath ?? (existsSync(coLocatedCard) ? coLocatedCard : undefined)

		return {
			modelPath: opts.modelPath,
			tokenizerPath: opts.tokenizerPath,
			modelCardPath,
			source: "explicit",
			artifacts: buildArtifactReport(
				[
					["model.onnx", opts.modelPath],
					["tokenizer.model", opts.tokenizerPath],
					["model-card.json", modelCardPath],
				],
				{
					[WeightsOrigin.Explicit]: dirname(opts.modelPath),
					...(modelCardPath ? { [WeightsOrigin.Package]: dirname(modelCardPath) } : {}),
				}
			),
		}
	}

	// Package names follow the all-lowercase BCP-47 convention (`neural-weights-en-us`,
	// `neural-weights-fr-fr`). The CLI's locale validation accepts canonical `en-US` / `fr-FR`
	// casing, so we normalize here rather than at the callsite.
	const locale = (opts.locale ?? "en-us").toLowerCase()
	const packageName = weightsPackageName(locale)

	const cacheDir = weightsCachePackageDir(opts.cacheRoot ?? weightsCacheDir(), locale)

	const cacheHasBinaries = () =>
		existsSync(resolve(cacheDir, "model.onnx")) && existsSync(resolve(cacheDir, "tokenizer.model"))

	// 0. An EXPLICIT cacheRoot is authoritative — it names a candidate/package dir the caller wants
	// graded (eval harnesses laying out a candidate bundle). In-repo the workspace weights package
	// always resolves, so a fallback-ordered cache could never be reached for grading; the explicit
	// override exists precisely for that. The IMPLICIT default cache stays a fallback (step 2).
	// An explicit root is also authoritative for data-only overlays. Such a package deliberately has no binaries of its
	// own: resolveFromPackageDir follows its `mailwoman.baseWeights` declaration to the base package beside it. Checking
	// for binaries here used to skip that path and fall through to the installed package, mixing a candidate en-US model
	// with shipped foreign-locale artifacts. Let the package resolver either complete wholly inside this root or fail.
	if (opts.cacheRoot) {
		// A cache with NO install for this package gets its own error: resolveFromPackageDir's
		// "resolved at … but is missing model files" is written for a real-but-bare package dir (the
		// ordinary dev-checkout state), and is a false claim about a directory that does not exist.
		// The refusal itself is the point — an explicit cache never falls back — so say that.
		if (!existsSync(cacheDir)) {
			tried.push(cacheDir)

			throw new Error(
				`Could not resolve ${packageName} from the explicit weights cache.\n` +
					`The cache carries no ${packageName} install at ${cacheDir}, and an explicit cache is an ` +
					`isolation boundary — resolution never falls back to installed or workspace packages.\n` +
					`Install into the cache (npm --prefix layout, e.g. \`mailwoman parse --download-weights\`), ` +
					`or drop the explicit cache root.`
			)
		}

		return resolveFromPackageDir(cacheDir, locale, opts, `cache:${packageName}`, tried)
	}

	// 1. Installed package (workspace or node_modules).
	let emptyPackageDir: string | undefined

	try {
		return resolveFromPackageDir(resolvePackageDirectory(packageName), locale, opts, `package:${packageName}`, tried)
	} catch (error) {
		// A resolvable package with NO binaries used to be terminal here, on the reasoning that a
		// half-linked checkout must never silently load the wrong model. The reasoning held; the
		// conclusion did not, because it is also the ordinary state of a fresh worktree — the binaries
		// are not in git, so the workspace package always resolves and is always empty, and no later
		// rung was reachable. Falling through preserves the guarantee: nothing is loaded silently, and
		// the error below still names this directory first.
		if (error instanceof Error && error.message.includes("missing model files")) {
			emptyPackageDir = resolvePackageDirectory(packageName)
		}
	}

	// 2. The data-root overlay — a dev checkout's binaries, outside git and shared across every worktree
	// and clone on the machine. Both binaries required, for the same reason the cache probe requires
	// them: half an overlay resolves to a model with no tokenizer, and that failure surfaces inside the
	// ONNX session rather than here.
	const overlayDir = opts.overlayRoot ? resolve(opts.overlayRoot, locale) : weightsOverlayDir(locale)

	// Probed whenever the directory EXISTS, not only when it holds both binaries. An overlay for a locale
	// that declares `mailwoman.baseWeights` deliberately carries no model — en-nz's linker removes one to
	// prove the fallback engages — so a precondition demanding the binaries skips exactly the locales the
	// base mechanism exists for. `resolveFromPackageDir` resolves the base itself; a genuinely empty overlay
	// still throws "missing model files", which falls through to the cache below.
	if (existsSync(overlayDir)) {
		try {
			return resolveFromPackageDir(overlayDir, locale, opts, `overlay:${locale}`, tried)
		} catch (error) {
			if (!(error instanceof Error) || !error.message.includes("missing model files")) throw error
		}
	}

	// 3. The user-level weights cache (npm-prefix layout written by `mailwoman parse
	// --download-weights`, plan 3). Requires both binaries — a metadata-only cache install must NOT
	// resolve (it would load nothing); it falls through to the actionable not-found error below.
	if (cacheHasBinaries()) {
		return resolveFromPackageDir(cacheDir, locale, opts, `cache:${packageName}`, tried)
	}

	throw new Error(
		`Could not resolve ${packageName}.\n` +
			(emptyPackageDir
				? `The package IS installed at ${emptyPackageDir} but ships no model.onnx/tokenizer.model — the ` +
					"ordinary state of a dev checkout, where the binaries are not in git.\n"
				: `Install it via: npm install ${packageName}\n`) +
			`Also probed the data-root overlay: ${overlayDir}\n` +
			`Also probed the weights cache: ${cacheDir}\n` +
			`Or run \`mailwoman parse --download-weights\`, or pass --model + --tokenizer with explicit paths.`
	)
}

/**
 * Resolve the full artifact set from a weights package directory — the shipped layout is identical whether the dir came
 * from module resolution (`package:`) or the guard's cache prefix (`cache:`), so the sibling artifacts (model card, CRF
 * transitions, anchor binary, gazetteer lexicon) resolve the same way for both. Throws when the model files themselves
 * are missing.
 */
function resolveFromPackageDir(
	packageDir: string,
	locale: string,
	opts: ResolveWeightsOpts,
	source: string,
	tried: string[]
): ResolvedWeights {
	let modelPath = opts.modelPath ?? resolve(packageDir, "model.onnx")
	let tokenizerPath = opts.tokenizerPath ?? resolve(packageDir, "tokenizer.model")

	// #1177 base-overlay dedup: a data-only locale package may SHARE the base model instead of shipping its
	// own ~35.8 MB copy. fr-fr already ships en-us's model at publish time (publish.yml copies it), so the
	// copy is pure duplication. Declaring `mailwoman.baseWeights` lets the package drop model.onnx +
	// tokenizer.model from its `files` and resolve them from the base package, while its OWN data siblings
	// (model-card, postcode-<cc>.bin, lexicons) still resolve locally. Base takes precedence over any local
	// model copy — that is also what closes #1117 (fr-fr's link-dev-weights pinned a stale model).
	const baseDir = resolveBaseWeightsDir(packageDir, locale, opts.cacheRoot !== undefined)

	if (!opts.modelPath) {
		const baseModel = baseDir ? resolve(baseDir, "model.onnx") : undefined

		if (baseDir && baseModel && existsSync(baseModel)) {
			modelPath = baseModel

			if (!opts.tokenizerPath) {
				tokenizerPath = resolve(baseDir, "tokenizer.model")
			}

			source = `${source}+base`
		}
	}

	tried.push(modelPath, tokenizerPath)

	if (!existsSync(modelPath) || !existsSync(tokenizerPath)) {
		throw new Error(
			`Weights package resolved at ${packageDir} but is missing model files.\n` +
				`Tried:\n  ${tried.join("\n  ")}\n` +
				`Run \`scripts/link-dev-weights.ts\` inside the package to symlink dev weights, ` +
				`or pass --model + --tokenizer with explicit paths.`
		)
	}

	// Card-less overlay fallback: an overlay package that ships no model-card.json of its own (en-gb —
	// only its GB-specific data siblings) still needs the trained label vocabulary to decode correctly.
	// Without this, `readLabelsFromModelCard(undefined)` silently defaults to `STAGE2_BIO_LABELS` (21
	// labels) while the shared base model emits a wider STAGE3+ vocabulary (33 labels), and the first
	// parse throws in `assertEmissionWidth`. Mirrors the model/tokenizer base fallback above — same
	// `+base` source suffix convention.
	const modelCardCandidate = resolve(packageDir, "model-card.json")
	const baseModelCardCandidate = baseDir ? resolve(baseDir, "model-card.json") : undefined

	const modelCardPath = existsSync(modelCardCandidate)
		? modelCardCandidate
		: baseModelCardCandidate && existsSync(baseModelCardCandidate)
			? baseModelCardCandidate
			: undefined

	if (!existsSync(modelCardCandidate) && modelCardPath && !source.endsWith("+base")) {
		source = `${source}+base`
	}

	// Surfaced separately from `modelCardPath`: an overlay card that EXISTS can still omit model-level fields, and
	// presence is not the same question as completeness. The label vocabulary is the case that bites — a card without
	// `labels` silently yields STAGE2_BIO_LABELS (21) against a 33-logit base model, and the first parse throws.
	const resolvedBaseModelCardPath =
		baseModelCardCandidate && existsSync(baseModelCardCandidate) && baseModelCardCandidate !== modelCardPath
			? baseModelCardCandidate
			: undefined

	const crfCandidate = resolve(packageDir, "crf-transitions.json")
	const crfTransitionsPath = existsSync(crfCandidate) ? crfCandidate : undefined

	const semiCrfCandidate = resolve(packageDir, "semi-crf-transitions.json")
	const semiCRFTransitionsPath = existsSync(semiCrfCandidate) ? semiCrfCandidate : undefined

	// Soft-feature sibling artifacts (#718 D1): the anchor + gazetteer sources the package ships so
	// `loadFromWeights` can feed the channels the model was trained against — without a callsite
	// change. Resolved package-dir-relative via the same `existsSync → undefined` pattern as the CRF
	// transitions above. The locale tag's region subtag (`en-us` → `us`) names the PCB1 binary.
	const country = locale.split("-")[1] ?? ""
	const anchorLookupPath = resolveAnchorLookupSibling(packageDir, country)
	// Tier `"pocket"` is anchor-only — never surface the gazetteer lexicon (the loader then skips it).
	const gazetteerCandidate = resolve(packageDir, "anchor-lexicon-v1.json")

	const gazetteerLexiconPath =
		opts.tier === "pocket" ? undefined : existsSync(gazetteerCandidate) ? gazetteerCandidate : undefined

	// Country-lexicon sibling (#1104): ships with the server tier alongside the gazetteer; pocket is anchor-only.
	const countryCandidate = resolve(packageDir, "country-surface-lexicon-v1.json")

	const countryLexiconPath =
		opts.tier === "pocket" ? undefined : existsSync(countryCandidate) ? countryCandidate : undefined

	// Evidence-bundle lexicon siblings (Option-A, Phase 2): same posture as the gazetteer/country
	// lexicons — server tier only, degrade-absent (pre-bundle packages simply don't carry them) —
	// except that WHICH generation to resolve now comes from the CARD, not a hard-coded filename (#1510).
	const streetTypeLexiconPath =
		opts.tier === "pocket" ? undefined : resolveEvidenceLexicon("street_type", packageDir, modelCardPath)

	const localitySurfaceLexiconPath =
		opts.tier === "pocket" ? undefined : resolveEvidenceLexicon("locality_surface", packageDir, modelCardPath)

	// Placetype-pair index sibling (placetype-pair-prior arc) — resolved LOCALLY from packageDir
	// only, never from baseDir like the model/tokenizer/model-card above. See resolvePairIndexSibling.
	const pairIndexPath = resolvePairIndexSibling(packageDir, country)

	// Per-locale FST gazetteer sibling (`fst-<locale>.bin`) — path only; the caller's layer deserializes
	// (neural carries no resolver-wof-sqlite dependency). Country-scoped by construction: a locale model
	// parsing foreign addresses simply gets no gazetteer bias for those places (the pair-index posture).
	const fstCandidate = resolve(packageDir, `fst-${locale}.bin`)
	const fstPath = existsSync(fstCandidate) ? fstCandidate : undefined

	// Street-morphology FST sibling (`fst-street-morphology.bin`) — locale-GENERAL (built from the libpostal
	// street_types dictionaries, all locales), so unlike `fst-<locale>.bin` it also resolves from the base weights
	// package when a data-only overlay doesn't ship its own copy (same fallback family as the model card above).
	const morphologyCandidate = resolve(packageDir, "fst-street-morphology.bin")
	const baseMorphologyCandidate = baseDir ? resolve(baseDir, "fst-street-morphology.bin") : undefined

	const streetMorphologyPath = existsSync(morphologyCandidate)
		? morphologyCandidate
		: baseMorphologyCandidate && existsSync(baseMorphologyCandidate)
			? baseMorphologyCandidate
			: undefined

	// The overlay and cache rungs hand this function their own directory, so `packageDir` is whichever
	// directory actually answered. Origin is read off `source`, which already names the rung.
	const rungOrigin: WeightsOrigin = source.startsWith("overlay")
		? WeightsOrigin.Overlay
		: source.startsWith("cache")
			? WeightsOrigin.Cache
			: WeightsOrigin.Package

	const artifacts = buildArtifactReport(
		[
			["model.onnx", modelPath],
			["tokenizer.model", tokenizerPath],
			["model-card.json", modelCardPath],
			["crf-transitions.json", crfTransitionsPath],
			["semi-crf-transitions.json", semiCRFTransitionsPath],
			[anchorLookupPath ? basename(anchorLookupPath.path) : `postcode-${country}.bin`, anchorLookupPath?.path],
			["anchor-lexicon-v1.json", gazetteerLexiconPath],
			["country-surface-lexicon-v1.json", countryLexiconPath],
			[streetTypeLexiconPath ? basename(streetTypeLexiconPath) : "street-type-lexicon.json", streetTypeLexiconPath],
			[
				localitySurfaceLexiconPath ? basename(localitySurfaceLexiconPath) : "locality-surface-lexicon.json",
				localitySurfaceLexiconPath,
			],
			[`pair-index-${country}.bin`, pairIndexPath],
			[`fst-${locale}.bin`, fstPath],
			["fst-street-morphology.bin", streetMorphologyPath],
		],
		{ [rungOrigin]: packageDir, [WeightsOrigin.Base]: baseDir }
	)

	return {
		modelPath,
		tokenizerPath,
		modelCardPath,
		packageDir,
		artifacts,
		...(resolvedBaseModelCardPath ? { baseModelCardPath: resolvedBaseModelCardPath } : {}),
		crfTransitionsPath,
		...(semiCRFTransitionsPath ? { semiCRFTransitionsPath } : {}),
		...(anchorLookupPath ? { anchorLookupPath } : {}),
		...(gazetteerLexiconPath ? { gazetteerLexiconPath } : {}),
		...(countryLexiconPath ? { countryLexiconPath } : {}),
		...(pairIndexPath ? { pairIndexPath } : {}),
		...(fstPath ? { fstPath } : {}),
		...(streetMorphologyPath ? { streetMorphologyPath } : {}),
		...(streetTypeLexiconPath ? { streetTypeLexiconPath } : {}),
		...(localitySurfaceLexiconPath ? { localitySurfaceLexiconPath } : {}),
		source,
	}
}

/**
 * Locate the package's postcode→anchor source for the soft-feed (#718 D1), preferring the compact PCB1 binary
 * (`postcode-<cc>.bin`, ~0.66 MB) over the much larger JSON lookup (`anchor-lookup.json`, the 3.2 MB pilot dump).
 * Returns the path + a `binary` flag so the loader picks the right parser (`PostcodeBinaryResolver.toAnchorLookup()` vs
 * `parseAnchorLookup`). `undefined` when neither ships.
 */
function resolveAnchorLookupSibling(
	packageDir: string,
	country: string
): { path: string; binary: boolean } | undefined {
	if (country) {
		const binary = resolve(packageDir, `postcode-${country}.bin`)

		if (existsSync(binary)) return { path: binary, binary: true }
	}

	const json = resolve(packageDir, "anchor-lookup.json")

	if (existsSync(json)) return { path: json, binary: false }

	return undefined
}

/**
 * The evidence-bundle lexicon families, and the LEGACY filename each resolved by before the card named its own (#1510).
 *
 * WHY THIS EXISTS. `resolveWeights` used to probe two literal filenames — `street-type-lexicon-v3.json` and
 * `locality-surface-lexicon-v6.json` — while both the shipped v4.0.1 recipe and the v4.2.0 candidate TRAIN against
 * locality-surface **v7** (`/data/gazetteer/locality-surface-lexicon-v7.json`). Serving therefore fed the channel a
 * DIFFERENT lexicon generation than training painted, and nothing said so: the v6 file exists, the channel loads, the
 * parse works. The Run B gate had to stage v7's CONTENT under the v6 FILENAME to score the candidate faithfully — a
 * workaround that only exists because the filename, not the card, was the contract.
 *
 * The contract is now the card: `requires.<channel>.lexicon` NAMES the artifact the model trained against, and
 * {@linkcode resolveEvidenceLexicon} resolves that. The legacy filenames stay as the back-compat answer for a card that
 * declares no version — every bundle published before 2026-08-06 — and taking that path warns once.
 */
export const EVIDENCE_LEXICON_FAMILIES = {
	street_type: { prefix: "street-type-lexicon-v", legacy: "street-type-lexicon-v3.json" },
	locality_surface: { prefix: "locality-surface-lexicon-v", legacy: "locality-surface-lexicon-v6.json" },
} as const

export type EvidenceLexiconChannel = keyof typeof EVIDENCE_LEXICON_FAMILIES

/**
 * A train/serve lexicon MISMATCH (#1510): the card names one generation of an evidence lexicon and the weights package
 * ships a different one. Thrown at LOAD time, from {@linkcode resolveWeights}, naming BOTH versions — the whole point is
 * that this can never again be a silent downgrade.
 */
export class LexiconVersionMismatchError extends Error {
	constructor(message: string) {
		super(message)
		this.name = "LexiconVersionMismatchError"
	}
}

/**
 * Warn-once bookkeeping for the undeclared-lexicon back-compat path. Keyed by `channel:card` so a process that loads
 * two different bundles hears about both, while repeated loads of the SAME bundle warn once.
 */
const warnedUndeclaredLexicon = new Set<string>()

/**
 * Every generation of `family` a directory ships, e.g. `["locality-surface-lexicon-v6.json"]`. Used only to build the
 * mismatch message — naming what IS there is what makes the error actionable.
 */
function shippedLexiconGenerations(dir: string, prefix: string): string[] {
	try {
		return readdirSync(dir)
			.filter((name) => name.startsWith(prefix) && name.endsWith(".json"))
			.toSorted()
	} catch {
		return []
	}
}

/**
 * Resolve one evidence-bundle lexicon for a weights package, from the CARD's declaration rather than a hard-coded
 * filename (#1510). The ladder, and why each rung is shaped the way it is:
 *
 * 1. The card NAMES a generation and the package ships that exact file → resolve it. The train/serve congruent case.
 * 2. The card NAMES a generation, the package ships NONE of that family → `undefined`. Absence is absence: a pre-bundle
 *    package simply doesn't carry the channel, and `createScorer` already fails closed if the card also declares it
 *    REQUIRED. (`neural-weights-base-latn` is the live example — it symlinks en-us's card and ships no lexicons.)
 * 3. The card NAMES a generation, the package ships a DIFFERENT one → THROW. This is the #1510 defect exactly, and it is
 *    the only rung where guessing would be a silent downgrade rather than a plain absence.
 * 4. The card names NOTHING → the legacy filename, with a one-time warning. Every bundle published before 2026-08-06.
 *
 * PACKAGE-DIR ONLY — deliberately NOT the `baseWeights` fallback the model card and `fst-street-morphology.bin` take,
 * even though the lexicons are locale-general and the dedup would "work". Adding it was tried and reverted while
 * closing #1511: a data-only overlay that ships no lexicon of its own would start resolving the BASE package's, which
 * silently turns both evidence channels ON for every overlay in the repo (de-de, es-es, it-it, en-in, en-nz, fr-fr) in
 * one commit, on locales no board has graded. An overlay that wants the bundle links its own copy and says so in its
 * `files` array; that is one locale's measured decision, not seven unmeasured ones.
 */
function resolveEvidenceLexicon(
	channel: EvidenceLexiconChannel,
	packageDir: string,
	modelCardPath: string | undefined
): string | undefined {
	const { prefix, legacy } = EVIDENCE_LEXICON_FAMILIES[channel]
	const declared = readRequiredChannels(modelCardPath)?.[channel]?.lexicon

	if (!declared) {
		const candidate = resolve(packageDir, legacy)
		const found = existsSync(candidate) ? candidate : undefined

		const warnKey = `${channel}:${modelCardPath ?? "(no card)"}`

		if (found && !warnedUndeclaredLexicon.has(warnKey)) {
			warnedUndeclaredLexicon.add(warnKey)

			console.error(
				`[resolveWeights] the model-card${modelCardPath ? ` at ${modelCardPath}` : ""} does not name its ` +
					`\`requires.${channel}.lexicon\`, so the ${channel} channel falls back to the legacy filename ` +
					`${legacy}. That is a GUESS about which lexicon generation the model trained against — add the ` +
					`field to the card (#1510).`
			)
		}

		return found
	}

	const declaredPath = resolve(packageDir, declared)

	if (existsSync(declaredPath)) return declaredPath
	const shipped = shippedLexiconGenerations(packageDir, prefix)

	// Nothing of this family anywhere → plain absence, not a mismatch (rung 2).
	if (!shipped.length) return undefined

	throw new LexiconVersionMismatchError(
		`[resolveWeights] ${channel} lexicon MISMATCH between the model-card and the weights package. The card ` +
			`at ${modelCardPath} declares \`requires.${channel}.lexicon\` = ${JSON.stringify(declared)} — the ` +
			`generation the model TRAINED against — but the package at ${packageDir} ships ` +
			`${shipped.map((name) => JSON.stringify(name)).join(", ")}. Serving a different lexicon generation than ` +
			`training painted is a silent train/serve incongruence (#1510), so this refuses rather than downgrading. ` +
			`Stage ${JSON.stringify(declared)} into the package, or correct the card to name what it actually ships.`
	)
}

/**
 * Locate the package's placetype-pair index (`pair-index-<cc>.bin`, PIX1 format, placetype-pair-prior arc).
 * COUNTRY-SPECIFIC BY DESIGN: this artifact is resolved from `packageDir` ONLY, unlike the model/tokenizer/model-card
 * siblings above, which fall back to a `baseWeights` package — a shared base has no locale-specific place-pair data to
 * offer, so a base package without its own `pair-index-<cc>.bin` simply has none (no fallback attempted). `undefined`
 * when the package doesn't ship one for `country`.
 */
function resolvePairIndexSibling(packageDir: string, country: string): string | undefined {
	if (!country) return undefined
	const candidate = resolve(packageDir, `pair-index-${country}.bin`)

	return existsSync(candidate) ? candidate : undefined
}

/**
 * Locate the PCN1 placetype census for `country` — `placetype-census-<cc>.bin`, the artifact `mailwoman gazetteer
 * census` builds (`neural/placetype-census.ts` owns both ends of the format).
 *
 * WHY THIS ONE DOES NOT TAKE A `packageDir`, unlike every other resolver in this file. The census is a BUILD-LOCAL
 * artifact: it lives under `$MAILWOMAN_DATA_ROOT/wof/`, exactly where `fst-street-morphology.bin` and the pair-index
 * probe outputs live, and it ships in NO weights tarball. That is a deliberate deferral, not an oversight. The
 * 2026-08-04 wiring assessment ruled that the census gets no decode wiring until a calibration rung measures a δ (the
 * header's `delta` field is optional and every shipped artifact omits it), and until something at runtime READS it,
 * adding 137–165 KB per locale to a published package buys nothing. When a calibration rung earns that cost, this
 * function grows a package-sibling probe ahead of the data-root one — the same shape as
 * {@link resolveAnchorLookupSibling}'s binary-then-JSON ladder.
 *
 * What the artifact is FOR, today: OBSERVABILITY. `PlacetypeCensusResolver` answers "does this parent have children of
 * this KIND at all, and how much more often than the country at large" (presence + lift; within-parent share is ~100%
 * everywhere, so a share-proportional consumer would read a constant). The pair prior probes it alongside each parent
 * candidate and records what it found on the parse trace (`TracePrior` of kind `placetypeCensus`) — nothing else. The
 * calibration rung's job is to read those traces and decide whether a δ is worth shipping.
 *
 * What the NEXT rung needs, so nobody mistakes this for a finished mechanism: the census is SPAN-BLIND (the D-C4
 * ceiling). A node asserts something about a PARENT SURFACE, never about where a child span starts or ends, so census
 * evidence alone cannot tell "East Acton" the place from "East Acton" opening a venue name — it fails the same
 * venue-confound board that pinned window mode at a 52.1% false-positive rate and forced the pair prior's segment
 * default. Composition with span evidence (the parent-span probe chain this rides, plus whatever span-boundary signal
 * the calibration rung finds) is the open design question, not a δ sweep.
 *
 * `undefined` when the file is absent — the caller then wires no census and the feature is entirely inert, with no
 * warning: an absent build-local artifact is the NORMAL state for every consumer who never ran the build command.
 */
export function resolvePlacetypeCensusPath(country: string): string | undefined {
	if (!country) return undefined

	const candidate = String(dataRootPath("wof", `placetype-census-${country.toLowerCase()}.bin`))

	return existsSync(candidate) ? candidate : undefined
}

/**
 * Read the census for `country` into a {@link PlacetypeCensusResolver}, or `undefined` when there is nothing to read
 * (see {@link resolvePlacetypeCensusPath} for what this artifact is, why it is build-local, and what the next rung
 * needs). `explicitPath` overrides the data-root lookup — a harness that built a census to a scratch directory.
 *
 * Degrade rules, deliberately asymmetric: an ABSENT artifact is silent, because not having built one is the normal
 * state for everyone who never ran `mailwoman gazetteer census`, and a warning there would fire for every user of the
 * library. A present-but-unreadable file, or one whose header names a different country than the locale being parsed,
 * is LOUD — those are build mistakes, and the country one in particular would otherwise have a census describing the
 * wrong country's hierarchy quietly riding the trace a calibration rung reads.
 */
export function loadPlacetypeCensus(country: string, explicitPath?: string): PlacetypeCensusResolver | undefined {
	const path = explicitPath ?? resolvePlacetypeCensusPath(country)

	if (!path) return undefined

	try {
		const census = new PlacetypeCensusResolver(new Uint8Array(readFileSync(path)))

		if (census.country === country) return census

		console.warn(
			`[mailwoman/neural] placetype-census country "${census.country}" (${path}) does not match the resolved ` +
				`locale's country "${country}" — skipping the census observability probe.`
		)
	} catch (error) {
		console.error(`[mailwoman/neural] failed to parse ${path}: ${(error as Error).message}`)
	}

	return undefined
}

/**
 * #1177 base-overlay dedup: resolve the base weights package a locale package overlays. A data-only weights package
 * (fr-fr/en-gb/en-nz, and future CA/MX overlays) can declare `"mailwoman": { "baseWeights":
 * "@mailwoman/neural-weights-en-us" }` in its package.json to SHARE the base `model.onnx` + `tokenizer.model` rather
 * than ship a byte-identical copy. Returns the resolved base package dir, or `undefined` when the field is absent or
 * the base package can't be resolved (in which case the caller keeps the local model paths — no behavior change for a
 * self-contained package).
 */
function resolveBaseWeightsDir(packageDir: string, locale?: string, cacheRootIsExplicit = false): string | undefined {
	try {
		// An OVERLAY directory carries no package.json — it is a materialization target, not a package — so the
		// `baseWeights` declaration is read from the WORKSPACE for the same locale. Without this the #1177 dedup
		// stops working the moment the dev linkers write outside the package: an overlay locale that
		// deliberately removes its own model (en-nz does exactly that, to prove the fallback engages) would
		// resolve nothing at all.
		const declarationDir = existsSync(resolve(packageDir, "package.json"))
			? packageDir
			: locale
				? tryResolvePackageDirectory(weightsPackageName(locale))
				: undefined

		if (!declarationDir) return undefined

		const pkg = tryParsingJSON<{ mailwoman?: { baseWeights?: string } }>(
			readFileSync(resolve(declarationDir, "package.json"), "utf8")
		)

		const base = pkg?.mailwoman?.baseWeights

		if (typeof base !== "string" || !base) return undefined

		// npm installs scoped siblings beside one another. Prefer that sibling before global package resolution so an
		// explicit cache remains an isolation boundary: a candidate overlay must share the candidate base in the same
		// cache, never the installed/workspace base that happens to be visible to this process.
		const siblingBaseDir = resolve(dirname(packageDir), base.split("/").at(-1)!)

		if (existsSync(resolve(siblingBaseDir, "package.json"))) return siblingBaseDir

		if (cacheRootIsExplicit) return undefined

		const basePackageDir = tryResolvePackageDirectory(base)

		// Prefer the base's OVERLAY when the caller is itself resolving from one: a dev checkout's base package
		// is empty by construction, so falling back to it would find nothing.
		const baseLocale = base.replace("@mailwoman/neural-weights-", "")
		const baseOverlay = weightsOverlayDir(baseLocale)

		if (packageDir !== declarationDir && existsSync(resolve(baseOverlay, "model.onnx"))) return baseOverlay

		return basePackageDir
	} catch {
		return undefined
	}
}

/**
 * {@link resolvePackageDirectory}, returning `undefined` instead of throwing for a package that is not installed.
 */
function tryResolvePackageDirectory(packageName: string): string | undefined {
	try {
		return resolvePackageDirectory(packageName)
	} catch {
		return undefined
	}
}

/**
 * Read the `labels` array from a `model-card.json` file. Returns `undefined` when the file is missing, unreadable,
 * malformed, or has no `labels` field — callers should fall back to their compile-time default in that case (the loader
 * contract: the JS-side default tracks the most recent shipped stage, so a card without `labels` is always a pre-v0.4.0
 * card whose label vocab matches that default by construction).
 *
 * Validates shape: must be a non-empty array of strings. Throws on a present-but-malformed `labels` field — a card that
 * emits e.g. `labels: 21` rather than `labels: [...]` is a corrupted artifact and should be loud, not silently
 * re-defaulted.
 */
export function readLabelsFromModelCard(modelCardPath: string | undefined): readonly string[] | undefined {
	if (!modelCardPath || !existsSync(modelCardPath)) return undefined
	let raw: string

	try {
		raw = readFileSync(modelCardPath, "utf8")
	} catch {
		return undefined
	}

	const parsed = tryParsingJSON(raw)

	if (typeof parsed !== "object" || parsed === null) return undefined
	const labels = (parsed as { labels?: unknown }).labels

	if (labels === undefined) return undefined

	if (!Array.isArray(labels) || !labels.length || !labels.every((l) => typeof l === "string")) {
		throw new Error(
			`model-card.json at ${modelCardPath} has a malformed \`labels\` field — ` +
				`expected a non-empty array of strings, got ${JSON.stringify(labels)}.`
		)
	}

	return Object.freeze(labels.slice()) as readonly string[]
}

/**
 * The structured `requires` block of a `model-card.json` (#718) — the declared SHIP-CONFIG the model was trained
 * against. The ProductionScorer reads this and FAILS CLOSED when a declared channel isn't actually fed (silent OOD is
 * the #566/#685 trap). Each channel is optional; a missing channel means "not declared" (treated as not-required).
 */
export interface RequiredChannels {
	/**
	 * Postcode-anchor channel (#239/#240). `span_mode` declares WHICH substrings the runtime should look up — omit (or
	 * `alnum-run`) for every model trained before 2026-08-05, `shaped` for a model trained against a lookup with
	 * letter-bearing keys (see `neural/anchor-inference.ts`'s `AnchorSpanMode`). Declaring `shaped` on a model that never
	 * saw those keys changes the encoder's input for nothing; declaring `alnum-run` on one that did leaves its GB/NL
	 * postcodes unanchored.
	 */
	anchor?: { required: boolean; span_mode?: AnchorSpanMode }
	/**
	 * Gazetteer-anchor channel (#464).
	 */
	gazetteer?: { required: boolean }
	/**
	 * Country-lexicon channel (#1104).
	 */
	country?: { required: boolean }
	/**
	 * Address-system conventions (#511 Tier A). `mode` mirrors `ParseOpts.addressSystemConventions`.
	 */
	conventions?: { required: boolean; mode?: "auto" | string }
	/**
	 * Punctuation-gap span bridge (v4.4.0 corrective).
	 */
	bridge?: { required: boolean }
	/**
	 * Near-postcode gazetteer choreography (#464, v0.9.13).
	 */
	suppress_gazetteer_near_postcode?: boolean
	/**
	 * Street-type evidence channel (Option-A bundle, Phase 3). `lexicon` NAMES the artifact generation the model trained
	 * against — see {@linkcode EVIDENCE_LEXICON_FAMILIES}.
	 */
	street_type?: { required: boolean; lexicon?: string }
	/**
	 * Locality-surface evidence channel (Option-A bundle, Phase 3). `lexicon` NAMES the artifact generation the model
	 * trained against — see {@linkcode EVIDENCE_LEXICON_FAMILIES}.
	 */
	locality_surface?: { required: boolean; lexicon?: string }
}

/**
 * The `files` keys under which a weights card names its postcode→anchor artifact: the compact PCB1 binary first
 * (`postcode-<cc>.bin`), then the legacy JSON lookup.
 */
export const ANCHOR_ARTIFACT_CARD_KEYS = ["postcode_anchor", "anchor_lookup"] as const

/**
 * An artifact a package's own model-card DECLARES it ships, and whether it is actually there.
 */
export interface DeclaredArtifact {
	/**
	 * The `files` key that named it (`postcode_anchor`).
	 */
	key: string
	/**
	 * The declared filename, verbatim from the card (`postcode-us.bin`).
	 */
	file: string
	/**
	 * `packageDir`-relative resolution of {@link DeclaredArtifact.file}.
	 */
	path: string
	present: boolean
}

/**
 * What a weights package's OWN `model-card.json` declares it ships under `files`, for one family of keys.
 *
 * The card's `files` block is the package's manifest of intent, and it is the only per-package statement of what SHOULD
 * be on disk — `requires` describes the trained ENCODER, which is a different claim and is shared across every overlay
 * that inherits the base model. Conflating the two is the #1516 defect: en-gb's card declares
 * `requires.anchor.required: true` (a true statement about the encoder) while deliberately shipping no
 * `postcode-gb.bin` under the #1476 mitigation, so a guard keyed on `requires` alone calls a supported configuration
 * broken, and — because the old warning fired once per PROCESS and named no package — the operator reads that as the
 * PRIMARY locale's bin being missing.
 *
 * Reads the package's own card only, never the `baseWeights` fallback: an overlay that ships no card of its own is
 * making no claim about its files, and inheriting the base's manifest would attribute `postcode-us.bin` to it.
 *
 * @returns `undefined` when the package has no card, the card has no `files` block, or none of `keys` appears there —
 *   all three meaning "this package declares no such artifact", which is a legal posture, not a fault.
 */
export function readDeclaredArtifactFile(
	packageDir: string | undefined,
	keys: readonly string[] = ANCHOR_ARTIFACT_CARD_KEYS
): DeclaredArtifact | undefined {
	if (!packageDir) return undefined

	const cardPath = resolve(packageDir, "model-card.json")

	if (!existsSync(cardPath)) return undefined

	let parsed: unknown

	try {
		parsed = tryParsingJSON(readFileSync(cardPath, "utf8"))
	} catch {
		return undefined
	}

	const files = (parsed as { files?: unknown } | null)?.files

	if (typeof files !== "object" || files === null || Array.isArray(files)) return undefined

	for (const key of keys) {
		const file = (files as Record<string, unknown>)[key]

		// The cards keep `$comment_*` siblings in `files` to record a DELIBERATE absence (en-gb's
		// `$comment_postcode_anchor`), so only a plain filename counts as a declaration.
		if (typeof file !== "string" || !file || file.startsWith("$")) continue

		const path = resolve(packageDir, file)

		return { key, file, path, present: existsSync(path) }
	}

	return undefined
}

/**
 * A soft-feed channel `loadFromWeights` can find declared-but-unfed.
 */
export type UnfedChannel = "anchor" | "gazetteer" | "country" | "street_type" | "locality_surface"

/**
 * Process-wide dedupe keyed by `<channel>:<package>` — see {@linkcode unfedChannelWarner}.
 */
const warnedUnfedChannels = new Set<string>()

/**
 * Build the loud-degrade warner for one weights package (#718 D1) — the Node mirror of neural-web's
 * `warnOnUnfedTrainedChannels`. A card that declares a channel REQUIRED, paired with a package that didn't ship (or
 * could not parse) its data, runs that channel OFF. Structural fallback (the parse still works), loud console (a
 * silently anchor-OFF anchor-trained model is the #566/#685 OOD crater this exists to surface).
 *
 * BOUND TO A PACKAGE, and deduped per (channel, package) — it was once per channel per PROCESS until #1516. One process
 * routinely loads several packages (the gauntlet grades six locale overlays), so channel-only dedupe meant the first
 * degraded package spoke and every later one was suppressed, while the line named no package at all. Both halves
 * produced the same wrong reading: an operator whose `postcode-us.bin` was present and feeding, watching a different
 * overlay degrade, was told "no postcode-<cc>.bin found in the weights package".
 *
 * @param weightsPackage How to identify the package in the message — locale plus resolved directory.
 */
export function unfedChannelWarner(weightsPackage: string): (channel: UnfedChannel, detail: string) => void {
	return (channel, detail) => {
		const key = `${channel}:${weightsPackage}`

		if (warnedUnfedChannels.has(key)) return
		warnedUnfedChannels.add(key)

		console.error(
			`[mailwoman/neural] loadFromWeights ${weightsPackage}: the model-card declares the ${channel} channel ` +
				`REQUIRED but ${detail} — running ${channel}-OFF for THIS package, parses degraded (train/inference ` +
				`mismatch). Ship the ${channel} artifact in that weights package (postcode-<cc>.bin / ` +
				`anchor-lexicon-v1.json), or pass an explicit lookup.`
		)
	}
}

/**
 * Why an unfed anchor channel is worth a warning for THIS package, or `undefined` when it is not.
 *
 * The condition the #1516 fix turns on, in one place because it is the whole substance of the fix. The old test was
 * `requires.anchor.required && nothing loaded`, and `requires` describes the trained ENCODER — shared by every overlay
 * that inherits the base model. So the en-gb overlay, which ships no `postcode-gb.bin` on purpose under the #1476
 * mitigation, warned on every load; the line named no package and fired once per PROCESS, so an operator whose
 * `postcode-us.bin` was present and feeding read it as the primary locale's binary having gone missing.
 *
 * Declared-and-missing is a broken package and stays loud. Declared-nothing is a supported posture and is silent —
 * `buildGauntletDeps` asserts the presence a GRADING run needs, which is the only place that knows whether this
 * particular run needs GB anchors.
 */
export function unfedAnchorDetail(packageDir: string | undefined): string | undefined {
	const declared = readDeclaredArtifactFile(packageDir)

	if (!declared) return undefined

	return declared.present
		? `its declared files.${declared.key} (${declared.file}) parsed EMPTY`
		: `its card declares files.${declared.key} = ${declared.file}, which is NOT in the package`
}

/**
 * Read the structured `requires` block from a `model-card.json` (#718). DEFENSIVE: returns `undefined` when the card is
 * absent, unreadable, or has no `requires` field (callers then INFER the required channels from the ONNX graph — see
 * `inferRequiredChannelsFromInputs`). Throws ONLY when the field is PRESENT but corrupt (not an object, or a channel
 * entry with a non-boolean `required`) — a malformed declared contract is a loud artifact bug, not a silent
 * re-default.
 */
export function readRequiredChannels(modelCardPath: string | undefined): RequiredChannels | undefined {
	if (!modelCardPath || !existsSync(modelCardPath)) return undefined
	let raw: string

	try {
		raw = readFileSync(modelCardPath, "utf8")
	} catch {
		return undefined
	}

	const parsed = tryParsingJSON(raw)

	if (typeof parsed !== "object" || parsed === null) return undefined
	const requires = (parsed as { requires?: unknown }).requires

	if (requires === undefined) return undefined

	if (typeof requires !== "object" || requires === null || Array.isArray(requires)) {
		throw new Error(
			`model-card.json at ${modelCardPath} has a malformed \`requires\` field — ` +
				`expected an object, got ${JSON.stringify(requires)}.`
		)
	}

	const obj = requires as Record<string, unknown>

	// Channel entries must be `{ required: boolean, ... }`; a present-but-shapeless entry is corrupt.
	for (const channel of [
		"anchor",
		"gazetteer",
		"country",
		"conventions",
		"bridge",
		"street_type",
		"locality_surface",
	] as const) {
		const entry = obj[channel]

		if (entry === undefined) continue

		if (
			typeof entry !== "object" ||
			entry === null ||
			typeof (entry as { required?: unknown }).required !== "boolean"
		) {
			throw new Error(
				`model-card.json at ${modelCardPath} has a malformed \`requires.${channel}\` entry — ` +
					`expected { required: boolean }, got ${JSON.stringify(entry)}.`
			)
		}
	}

	// `requires.<evidence channel>.lexicon` NAMES the trained artifact generation (#1510). A non-string
	// there would resolve to nothing and silently fall back to the legacy filename — the exact downgrade
	// the field exists to prevent — so it is a loud artifact bug like the shapes above.
	for (const channel of ["street_type", "locality_surface"] as const) {
		const lexicon = (obj[channel] as { lexicon?: unknown } | undefined)?.lexicon

		if (lexicon !== undefined && typeof lexicon !== "string") {
			throw new Error(
				`model-card.json at ${modelCardPath} has a malformed \`requires.${channel}.lexicon\` — ` +
					`expected a filename string, got ${JSON.stringify(lexicon)}.`
			)
		}
	}

	// `requires.anchor.span_mode` is an enum, and a typo in it is silent OOD (the wrong spans get
	// anchored, nothing errors) — so an unrecognized value is a loud artifact bug, like the shapes above.
	const anchorSpanMode = (obj.anchor as { span_mode?: unknown } | undefined)?.span_mode

	if (anchorSpanMode !== undefined && anchorSpanMode !== "alnum-run" && anchorSpanMode !== "shaped") {
		throw new Error(
			`model-card.json at ${modelCardPath} has a malformed \`requires.anchor.span_mode\` — ` +
				`expected "alnum-run" or "shaped", got ${JSON.stringify(anchorSpanMode)}.`
		)
	}

	if (obj.suppress_gazetteer_near_postcode !== undefined && typeof obj.suppress_gazetteer_near_postcode !== "boolean") {
		throw new Error(
			`model-card.json at ${modelCardPath} has a malformed \`requires.suppress_gazetteer_near_postcode\` ` +
				`field — expected a boolean, got ${JSON.stringify(obj.suppress_gazetteer_near_postcode)}.`
		)
	}

	return requires as RequiredChannels
}

/**
 * Back-compat inference of the required soft-feature channels from an ONNX model's declared input names (#718). A model
 * that exports `anchor_features` / `gazetteer_features` declared those channels mandatory at train time — feeding zeros
 * is the channel-off identity, but a model TRAINED with the channel is OOD when scored without it. Cards without a
 * `requires` block (every pre-#718 bundle) route through here so the fail-closed guard still protects them.
 * Conventions/bridge are NOT graph-observable (no dedicated input), so they're left undeclared here — only the card
 * declares them.
 */
export function inferRequiredChannelsFromInputs(inputNames: readonly string[]): RequiredChannels {
	const names = new Set(inputNames)

	return {
		...(names.has("anchor_features") ? { anchor: { required: true } } : {}),
		...(names.has("gazetteer_features") ? { gazetteer: { required: true } } : {}),
		...(names.has("country_features") ? { country: { required: true } } : {}),
		...(names.has("street_type_features") ? { street_type: { required: true } } : {}),
		...(names.has("locality_surface_features") ? { locality_surface: { required: true } } : {}),
	}
}

/**
 * One tag's certified capability under a (tier × address-system) cell of the capability manifest (#718/#719).
 * `maskOffF1` is the model's measured per-tag exact-match F1 with the conventions mask OFF; `maskOnF1` is the same with
 * the mask ON — recorded ONLY for tags some codex `forbiddenTags` row suppresses, because that's the only place the
 * loader's delta-gate consults it.
 */
export interface TagCapability {
	/**
	 * Measured per-tag F1 (percent) with the conventions mask OFF — the model's real capability.
	 */
	maskOffF1: number
	/**
	 * Measured per-tag F1 (percent) with the mask ON. Present only for codex-forbidden tags.
	 */
	maskOnF1?: number
}

/**
 * The `capabilities` block of a `model-card.json` (#718/#719): per serving TIER (`server` = anchor+gazetteer; `pocket`
 * = anchor-only) × per codex address-system × per tag, the model's certified per-tag capability. The `createScorer`
 * loader reads this to FAIL CLOSED when a conventions mask would forbid a tag the model is certified to emit — the
 * structural fix that makes the D2/#719 bug-class (a mask destroying a demonstrated capability) impossible.
 *
 * Shape: `capabilities[tier][system][tag] = { maskOffF1, maskOnF1? }`. A `$comment` provenance key may sit alongside
 * the tier keys and is ignored by readers.
 */
export type CapabilityManifest = Record<string, Record<string, Record<string, TagCapability>>>

/**
 * Read the `capabilities` block from a `model-card.json` (#718/#719). DEFENSIVE, mirroring `readRequiredChannels`:
 * returns `undefined` when the card is absent, unreadable, or has no `capabilities` field (a pre-#718 card → the
 * loader's delta-gate is skipped, back-compat). Throws ONLY when the field is PRESENT but not an object — a corrupt
 * declared contract is a loud artifact bug, not a silent skip. Tier/system/tag sub-shapes are read leniently (a
 * malformed cell simply yields no capability claim — `undefined` from `lookupTagCapability`).
 */
export function readCapabilityManifest(modelCardPath: string | undefined): CapabilityManifest | undefined {
	if (!modelCardPath || !existsSync(modelCardPath)) return undefined
	let raw: string

	try {
		raw = readFileSync(modelCardPath, "utf8")
	} catch {
		return undefined
	}

	const parsed = tryParsingJSON(raw)

	if (typeof parsed !== "object" || parsed === null) return undefined
	const capabilities = (parsed as { capabilities?: unknown }).capabilities

	if (capabilities === undefined) return undefined

	if (typeof capabilities !== "object" || capabilities === null || Array.isArray(capabilities)) {
		throw new Error(
			`model-card.json at ${modelCardPath} has a malformed \`capabilities\` field — ` +
				`expected an object, got ${JSON.stringify(capabilities)}.`
		)
	}

	return capabilities as CapabilityManifest
}

/**
 * Resolve `capabilities[tier][system][tag]` to a `TagCapability`, returning `undefined` for any missing/malformed cell
 * (a tag the model is NOT certified for — the loader treats that as legal: the model can't emit it, so a mask can't
 * destroy it). Skips the `$comment` provenance key.
 */
export function lookupTagCapability(
	manifest: CapabilityManifest | undefined,
	tier: string,
	system: string,
	tag: string
): TagCapability | undefined {
	const tierCell = manifest?.[tier]

	if (!tierCell || typeof tierCell !== "object") return undefined
	const systemCell = tierCell[system]

	if (!systemCell || typeof systemCell !== "object") return undefined
	const cap = systemCell[tag]

	if (!cap || typeof cap !== "object" || typeof (cap as TagCapability).maskOffF1 !== "number") return undefined

	return cap as TagCapability
}

export interface CRFTransitions {
	transitions: number[][]
	startTransitions: number[]
	endTransitions: number[]
}

/**
 * Read learned CRF transition parameters from `crf-transitions.json`. Returns `undefined` when the file is missing or
 * malformed — callers fall back to the structural BIO mask only.
 */
export function readCRFTransitions(crfPath: string | undefined): CRFTransitions | undefined {
	if (!crfPath || !existsSync(crfPath)) return undefined
	let raw: string

	try {
		raw = readFileSync(crfPath, "utf8")
	} catch {
		return undefined
	}

	const parsed = tryParsingJSON(raw)

	if (typeof parsed !== "object" || parsed === null) return undefined
	const obj = parsed as Record<string, unknown>
	const transitions = obj.transitions
	const start = obj.start_transitions
	const end = obj.end_transitions

	if (!Array.isArray(transitions) || !Array.isArray(start) || !Array.isArray(end)) return undefined

	if (!transitions.length || !start.length || !end.length) return undefined

	return {
		transitions: transitions as number[][],
		startTransitions: start as number[],
		endTransitions: end as number[],
	}
}
