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

import { existsSync, readFileSync } from "node:fs"
import { createRequire } from "node:module"
import { homedir } from "node:os"
import { dirname, resolve } from "node:path"

const req = createRequire(import.meta.url)

/**
 * The user-level npm-prefix cache the CLI weights guard installs into (`mailwoman parse --download-weights`, plan 3).
 * Laid out by `npm install --prefix`, so a cached package dir sits at
 * `<cache>/node_modules/@mailwoman/neural-weights-<locale>` and resolves sibling artifacts exactly like an installed
 * package.
 */
export function weightsCacheDir(): string {
	return resolve(homedir(), ".cache", "mailwoman", "weights")
}

/** The weights package for a locale tag, normalized to the all-lowercase BCP-47 package convention. */
export function weightsPackageName(locale?: string): string {
	return `@mailwoman/neural-weights-${(locale ?? "en-us").toLowerCase()}`
}

export interface ResolveWeightsOpts {
	/** BCP-47-ish locale tag, e.g. "en-us" or "fr-fr". Used to pick the weights package. */
	locale?: string
	/** Explicit model.onnx path; takes precedence over package auto-resolve. */
	modelPath?: string
	/** Explicit tokenizer.model path; takes precedence over package auto-resolve. */
	tokenizerPath?: string
	/**
	 * Explicit `model-card.json` path (for the label vocab) on the explicit model+tokenizer path. When omitted, falls
	 * back to a `model-card.json` co-located with `modelPath`. Without a card, labels default to `STAGE2_BIO_LABELS` —
	 * which silently mis-decodes a STAGE3 (33-label) model into empty/garbage parses. Pass this (or co-locate the card)
	 * when evaluating a custom STAGE3 checkpoint via explicit paths.
	 */
	modelCardPath?: string
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
	 * Path to `crf-transitions.json` alongside the resolved model. `undefined` when the file doesn't exist (pre-v0.6.0
	 * bundles or CE-only training).
	 */
	crfTransitionsPath?: string
	/**
	 * Path to `semi-crf-transitions.json` alongside the resolved model — the #727 stage-2 segment-transition grammar the
	 * span head's k-best decode consumes. `undefined` on a pre-v3 bundle (no span head). Read by `loadFromWeights` to
	 * expose {@link NeuralAddressClassifier.spanGrammar} for the phase-4c name-evidence rerank.
	 */
	semiCrfTransitionsPath?: string
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
	/** "explicit" if both paths came from opts; "package:<name>" if resolved via require.resolve. */
	source: string
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

		return { modelPath: opts.modelPath, tokenizerPath: opts.tokenizerPath, modelCardPath, source: "explicit" }
	}

	// Package names follow the all-lowercase BCP-47 convention (`neural-weights-en-us`,
	// `neural-weights-fr-fr`). The CLI's locale validation accepts canonical `en-US` / `fr-FR`
	// casing, so we normalize here rather than at the callsite.
	const locale = (opts.locale ?? "en-us").toLowerCase()
	const packageName = weightsPackageName(locale)

	const cacheDir = resolve(opts.cacheRoot ?? weightsCacheDir(), "node_modules", packageName)
	const cacheHasBinaries = () =>
		existsSync(resolve(cacheDir, "model.onnx")) && existsSync(resolve(cacheDir, "tokenizer.model"))

	// 0. An EXPLICIT cacheRoot is authoritative — it names a candidate/package dir the caller wants
	// graded (eval harnesses laying out a candidate bundle). In-repo the workspace weights package
	// always resolves, so a fallback-ordered cache could never be reached for grading; the explicit
	// override exists precisely for that. The IMPLICIT default cache stays a fallback (step 2).
	if (opts.cacheRoot && cacheHasBinaries()) {
		return resolveFromPackageDir(cacheDir, locale, opts, `cache:${packageName}`, tried)
	}

	// 1. Installed package (workspace or node_modules).
	try {
		const pkgJsonPath = req.resolve(`${packageName}/package.json`)

		return resolveFromPackageDir(dirname(pkgJsonPath), locale, opts, `package:${packageName}`, tried)
	} catch (error) {
		// A resolvable package with missing model files stays LOUD (the metadata-only dev-checkout
		// trap) — only a failed module resolution falls through to the cache probe.
		if (error instanceof Error && error.message.includes("missing model files")) throw error
	}

	// 2. The user-level weights cache (npm-prefix layout written by `mailwoman parse
	// --download-weights`, plan 3). Requires both binaries — a metadata-only cache install must NOT
	// resolve (it would load nothing); it falls through to the actionable not-found error below.
	if (cacheHasBinaries()) {
		return resolveFromPackageDir(cacheDir, locale, opts, `cache:${packageName}`, tried)
	}

	throw new Error(
		`Could not resolve ${packageName}. Install it via: npm install ${packageName}\n` +
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
	const modelPath = opts.modelPath ?? resolve(packageDir, "model.onnx")
	const tokenizerPath = opts.tokenizerPath ?? resolve(packageDir, "tokenizer.model")
	tried.push(modelPath, tokenizerPath)

	if (!existsSync(modelPath) || !existsSync(tokenizerPath)) {
		throw new Error(
			`Weights package resolved at ${packageDir} but is missing model files.\n` +
				`Tried:\n  ${tried.join("\n  ")}\n` +
				`Run \`scripts/link-dev-weights.ts\` inside the package to symlink dev weights, ` +
				`or pass --model + --tokenizer with explicit paths.`
		)
	}

	const modelCardCandidate = resolve(packageDir, "model-card.json")
	const modelCardPath = existsSync(modelCardCandidate) ? modelCardCandidate : undefined

	const crfCandidate = resolve(packageDir, "crf-transitions.json")
	const crfTransitionsPath = existsSync(crfCandidate) ? crfCandidate : undefined

	const semiCrfCandidate = resolve(packageDir, "semi-crf-transitions.json")
	const semiCrfTransitionsPath = existsSync(semiCrfCandidate) ? semiCrfCandidate : undefined

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

	return {
		modelPath,
		tokenizerPath,
		modelCardPath,
		crfTransitionsPath,
		...(semiCrfTransitionsPath ? { semiCrfTransitionsPath } : {}),
		...(anchorLookupPath ? { anchorLookupPath } : {}),
		...(gazetteerLexiconPath ? { gazetteerLexiconPath } : {}),
		...(countryLexiconPath ? { countryLexiconPath } : {}),
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
	let parsed: unknown

	try {
		parsed = JSON.parse(raw)
	} catch {
		return undefined
	}

	if (typeof parsed !== "object" || parsed === null) return undefined
	const labels = (parsed as { labels?: unknown }).labels

	if (labels === undefined) return undefined

	if (!Array.isArray(labels) || labels.length === 0 || !labels.every((l) => typeof l === "string")) {
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
	/** Postcode-anchor channel (#239/#240). */
	anchor?: { required: boolean }
	/** Gazetteer-anchor channel (#464). */
	gazetteer?: { required: boolean }
	/** Country-lexicon channel (#1104). */
	country?: { required: boolean }
	/** Address-system conventions (#511 Tier A). `mode` mirrors `ParseOpts.addressSystemConventions`. */
	conventions?: { required: boolean; mode?: "auto" | string }
	/** Punctuation-gap span bridge (v4.4.0 corrective). */
	bridge?: { required: boolean }
	/** Near-postcode gazetteer choreography (#464, v0.9.13). */
	suppress_gazetteer_near_postcode?: boolean
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
	let parsed: unknown

	try {
		parsed = JSON.parse(raw)
	} catch {
		return undefined
	}

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
	for (const channel of ["anchor", "gazetteer", "country", "conventions", "bridge"] as const) {
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
	}
}

/**
 * One tag's certified capability under a (tier × address-system) cell of the capability manifest (#718/#719).
 * `maskOffF1` is the model's measured per-tag exact-match F1 with the conventions mask OFF; `maskOnF1` is the same with
 * the mask ON — recorded ONLY for tags some codex `forbiddenTags` row suppresses, because that's the only place the
 * loader's delta-gate consults it.
 */
export interface TagCapability {
	/** Measured per-tag F1 (percent) with the conventions mask OFF — the model's real capability. */
	maskOffF1: number
	/** Measured per-tag F1 (percent) with the mask ON. Present only for codex-forbidden tags. */
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
	let parsed: unknown

	try {
		parsed = JSON.parse(raw)
	} catch {
		return undefined
	}

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

export interface CrfTransitions {
	transitions: number[][]
	startTransitions: number[]
	endTransitions: number[]
}

/**
 * Read learned CRF transition parameters from `crf-transitions.json`. Returns `undefined` when the file is missing or
 * malformed — callers fall back to the structural BIO mask only.
 */
export function readCrfTransitions(crfPath: string | undefined): CrfTransitions | undefined {
	if (!crfPath || !existsSync(crfPath)) return undefined
	let raw: string

	try {
		raw = readFileSync(crfPath, "utf8")
	} catch {
		return undefined
	}
	let parsed: unknown

	try {
		parsed = JSON.parse(raw)
	} catch {
		return undefined
	}

	if (typeof parsed !== "object" || parsed === null) return undefined
	const obj = parsed as Record<string, unknown>
	const transitions = obj.transitions
	const start = obj.start_transitions
	const end = obj.end_transitions

	if (!Array.isArray(transitions) || !Array.isArray(start) || !Array.isArray(end)) return undefined

	if (transitions.length === 0 || start.length === 0 || end.length === 0) return undefined

	return {
		transitions: transitions as number[][],
		startTransitions: start as number[],
		endTransitions: end as number[],
	}
}
