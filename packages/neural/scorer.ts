/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The canonical ProductionScorer (#718) — the ONE place that constructs a `NeuralAddressClassifier`
 *   the way the SHIPPED model expects to be fed. Every eval, harness, and (eventually) the serving
 *   path should route through here instead of re-deriving the anchor/gazetteer/conventions feed
 *   from per-script flags. The history this closes: the #566/#685 trap — a model TRAINED with a
 *   channel, scored WITHOUT it, silently goes out-of-distribution and the eval grades a handicapped
 *   model. The flat per-script construction (`score-country-homograph.ts`, `per-locale-f1.ts`) each
 *   re-invented the feed and each could silently drop a channel.
 *
 *   The fix: the model-card declares its required channels (`requires` block — see
 *   `readRequiredChannels`), and `createScorer` FAILS CLOSED when a declared channel isn't actually
 *   fed. Deliberate ablations are still legal — pass an explicit `override` and the scorer warns
 *   loudly instead of throwing (silent OOD is the bug, not the ablation).
 *
 *   **Node-only.** Reads the model card, anchor lookup, and gazetteer lexicon from disk and
 *   constructs the `ONNXRunner` (onnxruntime-node). Subpath `./scorer`; never import from the
 *   browser bundle.
 */

import { ADDRESS_SYSTEM_CONVENTIONS, type SystemCode } from "@mailwoman/codex"
import { pathExists, readLocalBuffer, readLocalJSONFile } from "@mailwoman/core/fs/readers"
import { dataRootPath } from "@mailwoman/core/utils"

import {
	parseAnchorLookup,
	shapedKeyerObligationViolation,
	type AnchorLookup,
	type AnchorSpanMode,
} from "./anchor-inference.ts"
import { NeuralAddressClassifier } from "./classifier.ts"
import { parseCountryLexicon, type CountryLexicon } from "./country-inference.ts"
import { parseGazetteerLexicon, type GazetteerLexicon } from "./gazetteer-inference.ts"
import { ONNXRunner } from "./onnx-runner.ts"
import { PostcodeBinaryResolver } from "./postcode-binary-resolver.ts"
import { MailwomanTokenizer } from "./tokenizer.ts"
import {
	inferRequiredChannelsFromInputs,
	lookupTagCapability,
	readCapabilityManifest,
	readLabelsFromModelCard,
	readRequiredChannels,
	type RequiredChannels,
} from "./weights-channels.ts"
import { resolveWeights } from "./weights.ts"

/**
 * Delta threshold for the capability-manifest gate (#718/#719): a conventions row may forbid a tag only if the mask
 * does NOT provably destroy a real capability — i.e. `maskOffF1 − maskOnF1 ≤ 5pp`. A DELTA, not an absolute floor: a
 * tag the model emits at 0.80 is protected if the mask drops it to 0.0, but a tag the mask leaves intact (small/zero
 * delta) is legal regardless of its absolute F1.
 */
export const CAPABILITY_DELTA_THRESHOLD = 0.05

/**
 * Default postcode→anchor lookup (the pilot lookup the shipped en-us model trained against).
 */
export const DEFAULT_ANCHOR_LOOKUP = dataRootPath("anchor", "pilot-anchor-lookup.json")

/**
 * Default gazetteer-anchor lexicon (codex-generated, repo-relative).
 */
export const DEFAULT_GAZETTEER_LEXICON = "data/gazetteer/anchor-lexicon-v1.json"

/**
 * Default country-surface lexicon (codex-generated, repo-relative, #1104).
 */
export const DEFAULT_COUNTRY_LEXICON = "data/gazetteer/country-surface-lexicon-v1.json"

/**
 * Resolve the anchor lookup source the scorer feeds (#718 D1). A caller-pinned path wins; otherwise prefer the
 * operator's local pilot JSON (the eval's historical default — unchanged when present), else the soft-feed sibling the
 * weights package SHIPS (`postcode-<cc>.bin` / `anchor-lookup.json`), so eval + serving read the SAME artifact. Returns
 * `undefined` when neither exists (the scorer then fails closed on a declared-required anchor, as before).
 *
 * The one exception is a `shaped` card, which inverts the default order — see the comment on that branch.
 */
async function resolveAnchorSource(
	pinned: string | undefined,
	locale: string | undefined,
	spanMode: AnchorSpanMode | undefined
): Promise<{ path: string; binary: boolean } | undefined> {
	// A caller-pinned path wins, and its FORMAT is read off the extension: a `.bin` is PCB1, anything
	// else is the JSON pilot dump. The option used to be documented "always JSON" and pointing it at a
	// candidate's own `postcode-<cc>.bin` threw a parse error — which left no way to grade a candidate
	// against the anchor artifact it actually ships.
	if (pinned) return { path: pinned, binary: pinned.endsWith(".bin") }

	// A `shaped` card INVERTS the preference below, and this is not a style choice. `pilot-anchor-lookup.json`
	// holds 67,708 keys, ZERO of them letter-bearing (US/DE/FR five-digit only) — measured, and the whole
	// reason the anchor-v2 retrain exists. A model that declares `shaped` was trained against a lookup
	// with letter-bearing keys, so preferring the pilot file for it grades the candidate against a lookup
	// that CANNOT carry the spans it learned. Silent, and the failure looks like "the retrain did nothing".
	if (spanMode !== "shaped" && (await pathExists(DEFAULT_ANCHOR_LOOKUP))) {
		return { path: DEFAULT_ANCHOR_LOOKUP, binary: false }
	}

	try {
		return (await resolveWeights({ locale })).anchorLookupPath ?? { path: DEFAULT_ANCHOR_LOOKUP, binary: false }
	} catch {
		return (await pathExists(DEFAULT_ANCHOR_LOOKUP)) ? { path: DEFAULT_ANCHOR_LOOKUP, binary: false } : undefined
	}
}

/**
 * Resolve the gazetteer lexicon path the scorer feeds when the caller passes no `gazetteerLexiconPath` (#718 D1):
 * prefer the repo-relative codex lexicon (the eval default — unchanged when present), else the soft-feed sibling
 * shipped in the weights package.
 */
async function defaultGazetteerLexicon(locale: string | undefined): Promise<string | undefined> {
	if (await pathExists(DEFAULT_GAZETTEER_LEXICON)) return DEFAULT_GAZETTEER_LEXICON

	try {
		return (await resolveWeights({ locale })).gazetteerLexiconPath
	} catch {
		return undefined
	}
}

/**
 * Resolve the country lexicon path the scorer feeds when the caller passes no `countryLexiconPath` (#1104): prefer the
 * repo-relative codex lexicon (the eval default), else the soft-feed sibling shipped in the weights package.
 */
async function defaultCountryLexicon(locale: string | undefined): Promise<string | undefined> {
	if (await pathExists(DEFAULT_COUNTRY_LEXICON)) return DEFAULT_COUNTRY_LEXICON

	try {
		return (await resolveWeights({ locale })).countryLexiconPath
	} catch {
		return undefined
	}
}

/**
 * Resolve the evidence-bundle lexicon paths (Option-A Phase 3): street-type prefers the committed repo artifact; the
 * locality-surface lexicon (13 MB, never in git) resolves from the weights package only.
 *
 * The repo preference is CARD-SCOPED (#1510). `data/gazetteer/` carries every generation of the street-type lexicon
 * side by side (v1, v2, v3 today), so a bare "prefer the repo copy" rule pins whichever filename this function was
 * written against and silently outranks the card — the same train/serve downgrade `resolveWeights` just stopped doing.
 * So when the card names a generation, the repo candidate is THAT filename; only an undeclared card falls back to the
 * historical literal.
 */
async function defaultStreetTypeLexicon(
	locale: string | undefined,
	modelCardPath: string
): Promise<string | undefined> {
	const declared = (await readRequiredChannels(modelCardPath))?.street_type?.lexicon
	const repoDefault = `data/gazetteer/${declared ?? "street-type-lexicon-v3.json"}`

	if (await pathExists(repoDefault)) return repoDefault

	try {
		return (await resolveWeights({ locale })).streetTypeLexiconPath
	} catch {
		return undefined
	}
}

/**
 * Spread-in for the optional FST path.
 *
 * A module-level helper rather than an inline `...(x ? {k: x} : {})` because `createScorer` sits one branch under the
 * complexity ceiling (86 against a maximum of 85 with the ternary inlined), and a lint error is a worse place to learn
 * that than here.
 */
function fstPathEntry(fstPath: string | undefined): { fstPath?: string } {
	return fstPath ? { fstPath } : {}
}

async function defaultLocalitySurfaceLexicon(locale: string | undefined): Promise<string | undefined> {
	try {
		return (await resolveWeights({ locale })).localitySurfaceLexiconPath
	} catch {
		return undefined
	}
}

/**
 * The anchor span mode the card declares (2026-08-05 train-parity fix). Card-declared ONLY — never inferred from the
 * graph, because the ONNX inputs are identical either way. An undeclared card (every bundle shipped before that date)
 * yields `undefined`, and the channel keeps the alnum-run scan, so those bundles score byte-identically.
 */
function declaredAnchorSpanMode(declared: RequiredChannels): AnchorSpanMode | undefined {
	return declared.anchor?.span_mode
}

/**
 * {@linkcode shapedKeyerObligationViolation}, wired to {@linkcode fail}. A one-call wrapper so `createScorer` gains no
 * branch — it sits one step under the complexity ceiling (see {@linkcode fstPathEntry}).
 */
function assertShapedKeyerObligation(
	lookup: AnchorLookup | undefined,
	spanMode: AnchorSpanMode | undefined,
	anchorSourcePath: string | undefined,
	strict: boolean
): void {
	const violation = shapedKeyerObligationViolation(lookup, spanMode, anchorSourcePath)

	if (violation) {
		fail(strict, violation)
	}
}

/**
 * Load an `AnchorLookup` from either a PCB1 binary or a JSON pilot lookup (#718 D1).
 */
async function loadAnchorLookup(source: { path: string; binary: boolean }): Promise<AnchorLookup> {
	return source.binary
		? new PostcodeBinaryResolver(new Uint8Array(await readLocalBuffer(source.path))).toAnchorLookup()
		: parseAnchorLookup(await readLocalJSONFile(source.path))
}

/**
 * Per-channel overrides for a deliberate, DECLARED ablation. Setting any of these to a value diverts the scorer from
 * the model-card's declared SHIP-CONFIG; the scorer honors it but emits a loud `console.error` warning (a stated
 * ablation is legal — silent OOD is not, #566/#685).
 */
export interface ScorerOverrides {
	/**
	 * `false` to ablate the anchor channel even when the card declares it required.
	 */
	anchor?: boolean
	/**
	 * `false` to ablate the gazetteer channel even when the card declares it required.
	 */
	gazetteer?: boolean
	/**
	 * `false` to ablate the street-type evidence channel (Option-A bundle).
	 */
	streetType?: boolean
	/**
	 * `false` to ablate the locality-surface evidence channel (Option-A bundle).
	 */
	localitySurface?: boolean
	/**
	 * `false` to ablate the country-lexicon channel even when the card declares it required (#1104).
	 */
	country?: boolean
	/**
	 * Pin / disable the conventions mode (`"auto"` | a `SystemCode` | `false` to disable) regardless of the card's
	 * declaration.
	 */
	conventions?: "auto" | string | false
	/**
	 * Override the bridge declaration.
	 */
	bridge?: boolean
	/**
	 * Override the near-postcode gazetteer choreography.
	 */
	suppressGazetteerNearPostcode?: boolean
}

export interface CreateScorerOpts {
	/**
	 * Path to the `model.onnx`.
	 */
	modelPath: string
	/**
	 * Path to the `tokenizer.model`.
	 */
	tokenizerPath: string
	/**
	 * Path to the `model-card.json` (label vocab + the `requires` ship-config).
	 */
	modelCardPath: string
	/**
	 * Per-locale FST gazetteer path (`fst-<locale>.bin`), surfaced on the built classifier as
	 * {@link NeuralAddressClassifier.fstPath} so a caller assembling `createRuntimePipeline` gets the decode-time
	 * gazetteer bias.
	 *
	 * PATH ONLY — `neural` carries no `resolver-wof-sqlite` dependency, so the deserialize happens in the caller's layer,
	 * exactly as it does for the `loadFromWeights` route.
	 *
	 * WHY THIS EXISTS (#1497). `loadFromWeights` sets `fstPath` from the resolved weights package; `createScorer` builds
	 * a classifier from EXPLICIT artifact paths and had no way to say which FST goes with them. Every eval that pins a
	 * candidate model goes through this constructor, so every one of them was assembling a pipeline whose gazetteer prior
	 * was silently OFF — which is why an FST change could not be measured by any eval in the tree.
	 */
	fstPath?: string
	/**
	 * Postcode→anchor lookup path — a JSON pilot lookup, or a PCB1 `.bin` (recognized by extension, so a candidate's own
	 * `postcode-<cc>.bin` can be pinned; before that it was JSON-only and pointing at a binary threw a parse error).
	 *
	 * Default: {@link DEFAULT_ANCHOR_LOOKUP} when it exists, else the soft-feed sibling shipped in the
	 * `@mailwoman/neural-weights-<locale>` package (#718 D1) — EXCEPT for a card declaring `span_mode: "shaped"`, which
	 * inverts the order. See {@link resolveAnchorSource}.
	 */
	anchorLookupPath?: string
	/**
	 * Gazetteer-anchor lexicon path. Default {@link DEFAULT_GAZETTEER_LEXICON} when it exists, else the soft-feed sibling
	 * shipped in the weights package (#718 D1).
	 */
	gazetteerLexiconPath?: string
	/**
	 * Street-type evidence lexicon path (Option-A bundle). Default: repo artifact, else the weights sibling.
	 */
	streetTypeLexiconPath?: string
	/**
	 * Locality-surface evidence lexicon path (Option-A bundle). Default: the weights-package sibling.
	 */
	localitySurfaceLexiconPath?: string
	/**
	 * Country-surface lexicon path (#1104). Default {@link DEFAULT_COUNTRY_LEXICON} when it exists, else the soft-feed
	 * sibling shipped in the weights package.
	 */
	countryLexiconPath?: string
	/**
	 * Locale tag (e.g. `"en-us"`) used to resolve the weights-package soft-feed siblings when the default `/mnt` /
	 * repo-relative paths are absent (#718 D1). Only consulted for that fallback; the model/tokenizer/card are always
	 * explicit on this path.
	 */
	locale?: string
	/**
	 * Fail CLOSED (throw) when the model-card declares a channel required but it isn't actually fed. Default `true`. Set
	 * `false` only for throwaway debugging — a below-config scorer is the trap this module exists to catch.
	 */
	strict?: boolean
	/**
	 * Serving tier whose certified capabilities the load-time delta-gate (#718/#719) reads from the card's `capabilities`
	 * block: `"server"` (anchor+gazetteer — the production default) or `"pocket"` (anchor-only). Default `"server"`. A
	 * tier the card doesn't certify → the gate has no capability claims to consult and is a no-op (legal).
	 */
	tier?: string
	/**
	 * Deliberate, DECLARED ablations (warn-not-throw). See {@link ScorerOverrides}.
	 */
	overrides?: ScorerOverrides
}

/**
 * A loud, descriptive fail-closed error for a declared-but-unfed channel.
 */
class UnfedChannelError extends Error {
	constructor(message: string) {
		super(message)
		this.name = "UnfedChannelError"
	}
}

/**
 * A loud, descriptive fail-closed error for a conventions mask that would destroy a CERTIFIED capability (#718/#719).
 * Thrown by {@link assertConventionsRespectCapabilities} — the structural guard that makes the D2/#719 bug-class (a
 * `forbiddenTags` row suppressing a tag the model demonstrably emits) impossible to ship.
 */
class CapabilityViolationError extends Error {
	constructor(message: string) {
		super(message)
		this.name = "CapabilityViolationError"
	}
}

/**
 * The load-time delta-gate (#718/#719). Iterate the codex `ADDRESS_SYSTEM_CONVENTIONS`; for every `forbiddenTags`
 * entry, look up the loaded tier's certified capability for that (system, tag). The forbid is ILLEGAL — the mask
 * provably destroys a real capability — when the model is certified to emit the tag (`maskOffF1` present) and the mask
 * measurably drops it:
 *
 *     maskOffF1 − (maskOnF1 ?? 0) > CAPABILITY_DELTA_THRESHOLD
 *
 * A forbidden tag with NO capability entry (model not certified there), or one whose `maskOnF1` shows the mask leaves
 * it intact (small/zero/negative delta), is LEGAL. When `maskOnF1` is ABSENT for a certified tag, the mask's effect was
 * never measured — and since the mask is a hard −1e9 emission ban, we conservatively assume full destruction (delta =
 * maskOffF1 − 0). That's the #719 shape: FR `street_prefix` certified at maskOff 80.0, no benign mask-on measurement →
 * forbidding it is rejected at load time.
 *
 * Back-compat: a card with no `capabilities` block (pre-#718) has no claims to consult, so the gate is a one-time-warn
 * no-op and the model still loads.
 */
let warnedNoCapabilities = false

async function assertConventionsRespectCapabilities(
	modelCardPath: string,
	tier: string,
	strict: boolean
): Promise<void> {
	const manifest = await readCapabilityManifest(modelCardPath)

	if (!manifest) {
		// No certified capabilities → nothing to protect. Old cards still load (warn ONCE per process).
		if (!warnedNoCapabilities) {
			warnedNoCapabilities = true

			console.error(
				`[createScorer] model-card has no \`capabilities\` block — the conventions capability-gate ` +
					`(#718/#719) is SKIPPED. Regenerate the card via \`mailwoman eval capability-manifest\` to ` +
					`certify per-tag capability and enable the gate.`
			)
		}

		return
	}

	for (const [system, conventions] of Object.entries(ADDRESS_SYSTEM_CONVENTIONS)) {
		for (const tag of conventions?.forbiddenTags ?? []) {
			const cap = lookupTagCapability(manifest, tier, system, tag)

			if (!cap) continue // model not certified to emit this tag here → the mask can't destroy it.
			const delta = cap.maskOffF1 - (cap.maskOnF1 ?? 0)

			if (delta > CAPABILITY_DELTA_THRESHOLD) {
				const maskOn = cap.maskOnF1 === undefined ? "unmeasured (assumed 0 — hard −1e9 ban)" : String(cap.maskOnF1)

				fail(
					strict,
					`conventions forbids \`${tag}\` for system \`${system}\` but the model is certified to emit it ` +
						`(tier \`${tier}\`: maskOff F1 ${cap.maskOffF1} vs maskOn ${maskOn}; Δ=${delta.toFixed(2)} > ` +
						`${CAPABILITY_DELTA_THRESHOLD}); this mask would destroy a real capability — #718/#719. ` +
						`Either remove \`${tag}\` from the codex forbiddenTags for \`${system}\`, or re-certify the ` +
						`model and prove the mask is benign (record a maskOnF1 within ${CAPABILITY_DELTA_THRESHOLD} of maskOff).`,
					CapabilityViolationError
				)
			}
		}
	}
}

/**
 * Construct a `NeuralAddressClassifier` wired to the model-card's declared SHIP-CONFIG (anchor + gazetteer +
 * conventions + bridge + near-postcode suppression), failing closed in `strict` mode when a declared channel can't
 * actually be fed.
 *
 * Resolution of "what's required": the card's `requires` block when present; otherwise INFERRED from the ONNX graph's
 * input names (back-compat for every pre-#718 bundle). Explicit `overrides` divert from the declaration with a loud
 * warning rather than a throw.
 */
export async function createScorer(opts: CreateScorerOpts): Promise<NeuralAddressClassifier> {
	const strict = opts.strict ?? true
	const overrides = opts.overrides ?? {}

	if (!(await pathExists(opts.modelPath))) throw new Error(`createScorer: modelPath does not exist: ${opts.modelPath}`)

	if (!(await pathExists(opts.tokenizerPath))) {
		throw new Error(`createScorer: tokenizerPath does not exist: ${opts.tokenizerPath}`)
	}

	if (!(await pathExists(opts.modelCardPath))) {
		throw new Error(`createScorer: modelCardPath does not exist: ${opts.modelCardPath}`)
	}

	const labels = await readLabelsFromModelCard(opts.modelCardPath)

	const [tokenizer, runner] = await Promise.all([
		MailwomanTokenizer.loadFromFile(opts.tokenizerPath),
		ONNXRunner.create(opts.modelPath),
	])

	// What the model DECLARES it needs. Card `requires` block is authoritative; older cards (no block)
	// fall back to the ONNX graph's declared inputs — a model exporting anchor_features/gazetteer_features
	// trained with those channels mandatory. Conventions/bridge are card-only (not graph-observable).
	const declared: RequiredChannels =
		(await readRequiredChannels(opts.modelCardPath)) ?? inferRequiredChannelsFromInputs(await runner.inputNames())

	// --- Capability-manifest delta-gate (#718/#719) -----------------------------------------------
	// BEFORE wiring the conventions mask, prove the shipped codex `forbiddenTags` don't destroy a tag
	// this model is CERTIFIED to emit (per the card's `capabilities` block for the loaded tier). This
	// is a property of the model-card + codex pairing, independent of any per-instance `overrides` —
	// an ablation scorer still loads the same shipped conventions table production will use, so the
	// gate runs unconditionally. Makes the D2/#719 bug-class structurally impossible to ship.
	await assertConventionsRespectCapabilities(opts.modelCardPath, opts.tier ?? "server", strict)

	// --- Anchor channel ---------------------------------------------------------------------------
	// Caller-pinned path wins (explicit `--anchor-lookup`, always JSON); else fall back to the
	// operator pilot JSON or, failing that, the weights-package soft-feed sibling (PCB1 or JSON, #718).
	const declaredSpanMode = declaredAnchorSpanMode(declared)

	const anchorSource = await resolveAnchorSource(opts.anchorLookupPath, opts.locale, declaredSpanMode)

	const anchorRequired = declared.anchor?.required ?? false
	let postcodeAnchorLookup: AnchorLookup | undefined

	if (overrides.anchor === false) {
		if (anchorRequired) {
			console.error(
				`[createScorer] OVERRIDE: anchor channel ABLATED (override anchor:false) but the model-card ` +
					`declares it REQUIRED. Deliberate OOD — the model was TRAINED with the anchor channel.`
			)
		}
	} else {
		postcodeAnchorLookup =
			anchorSource && (await pathExists(anchorSource.path)) ? await loadAnchorLookup(anchorSource) : undefined

		// Fail closed: declared-required but the lookup is missing or parsed empty → the model would be
		// fed zeros (the anchor-off identity) and silently go OOD. That's the #566/#685 trap.
		if (anchorRequired && !(postcodeAnchorLookup && postcodeAnchorLookup.size)) {
			const reason = postcodeAnchorLookup
				? `parsed lookup is EMPTY (size 0)`
				: `lookup not found (tried ${anchorSource?.path ?? DEFAULT_ANCHOR_LOOKUP} + weights-package sibling)`

			fail(
				strict,
				`anchor channel is declared REQUIRED by the model-card but cannot be fed: ${reason}. ` +
					`Provide a valid --anchor-lookup, or pass overrides.anchor=false for a deliberate ablation.`
			)
		}
	}

	// --- Gazetteer channel ------------------------------------------------------------------------
	const gazetteerLexiconPath = opts.gazetteerLexiconPath ?? (await defaultGazetteerLexicon(opts.locale))
	const gazetteerRequired = declared.gazetteer?.required ?? false
	let gazetteerLexicon: GazetteerLexicon | undefined

	if (overrides.gazetteer === false) {
		if (gazetteerRequired) {
			console.error(
				`[createScorer] OVERRIDE: gazetteer channel ABLATED (override gazetteer:false) but the ` +
					`model-card declares it REQUIRED. Deliberate OOD — the model was TRAINED with the gazetteer clue.`
			)
		}
	} else {
		gazetteerLexicon =
			gazetteerLexiconPath && (await pathExists(gazetteerLexiconPath))
				? parseGazetteerLexicon(await readLocalJSONFile(gazetteerLexiconPath))
				: undefined

		if (gazetteerRequired && !gazetteerLexicon) {
			fail(
				strict,
				`gazetteer channel is declared REQUIRED by the model-card but the lexicon file was not found ` +
					`at ${gazetteerLexiconPath ?? DEFAULT_GAZETTEER_LEXICON}. Provide a valid --gazetteer-lexicon, or pass ` +
					`overrides.gazetteer=false for a deliberate ablation.`
			)
		}
	}

	// --- Country-lexicon channel (#1104) ----------------------------------------------------------
	const countryLexiconPath = opts.countryLexiconPath ?? (await defaultCountryLexicon(opts.locale))
	const countryRequired = declared.country?.required ?? false
	let countryLexicon: CountryLexicon | undefined

	if (overrides.country === false) {
		if (countryRequired) {
			console.error(
				`[createScorer] OVERRIDE: country channel ABLATED (override country:false) but the ` +
					`model-card declares it REQUIRED. Deliberate OOD — the model was TRAINED with the country clue.`
			)
		}
	} else {
		countryLexicon =
			countryLexiconPath && (await pathExists(countryLexiconPath))
				? parseCountryLexicon(await readLocalJSONFile(countryLexiconPath))
				: undefined

		if (countryRequired && !countryLexicon) {
			fail(
				strict,
				`country channel is declared REQUIRED by the model-card but the lexicon file was not found ` +
					`at ${countryLexiconPath ?? DEFAULT_COUNTRY_LEXICON}. Provide a valid --country-lexicon, or pass ` +
					`overrides.country=false for a deliberate ablation.`
			)
		}
	}

	// --- Evidence-bundle channels (Option-A Phase 3) ------------------------------------------------
	// Same load + fail-closed + declared-ablation pattern as the gazetteer; both lexicons share its
	// JSON schema and parser. A bundle-trained card declares `street_type` + `locality_surface`.
	const streetTypeLexiconPath =
		opts.streetTypeLexiconPath ?? (await defaultStreetTypeLexicon(opts.locale, opts.modelCardPath))

	const streetTypeRequired = declared.street_type?.required ?? false
	let streetTypeLexicon: GazetteerLexicon | undefined

	if (overrides.streetType === false) {
		if (streetTypeRequired) {
			console.error(
				`[createScorer] OVERRIDE: street_type channel ABLATED (override streetType:false) but the ` +
					`model-card declares it REQUIRED. Deliberate OOD — the model was TRAINED with the bundle.`
			)
		}
	} else {
		streetTypeLexicon =
			streetTypeLexiconPath && (await pathExists(streetTypeLexiconPath))
				? parseGazetteerLexicon(await readLocalJSONFile(streetTypeLexiconPath))
				: undefined

		if (streetTypeRequired && !streetTypeLexicon) {
			fail(
				strict,
				`street_type channel is declared REQUIRED by the model-card but the lexicon was not found ` +
					`at ${streetTypeLexiconPath ?? "(unresolved)"}. Provide streetTypeLexiconPath, or pass ` +
					`overrides.streetType=false for a deliberate ablation.`
			)
		}
	}

	const localitySurfaceLexiconPath =
		opts.localitySurfaceLexiconPath ?? (await defaultLocalitySurfaceLexicon(opts.locale))

	const localitySurfaceRequired = declared.locality_surface?.required ?? false
	let localitySurfaceLexicon: GazetteerLexicon | undefined

	if (overrides.localitySurface === false) {
		if (localitySurfaceRequired) {
			console.error(
				`[createScorer] OVERRIDE: locality_surface channel ABLATED (override localitySurface:false) but ` +
					`the model-card declares it REQUIRED. Deliberate OOD — the model was TRAINED with the bundle.`
			)
		}
	} else {
		localitySurfaceLexicon =
			localitySurfaceLexiconPath && (await pathExists(localitySurfaceLexiconPath))
				? parseGazetteerLexicon(await readLocalJSONFile(localitySurfaceLexiconPath))
				: undefined

		if (localitySurfaceRequired && !localitySurfaceLexicon) {
			fail(
				strict,
				`locality_surface channel is declared REQUIRED by the model-card but the lexicon was not found ` +
					`at ${localitySurfaceLexiconPath ?? "(unresolved)"}. Provide localitySurfaceLexiconPath, or pass ` +
					`overrides.localitySurface=false for a deliberate ablation.`
			)
		}
	}

	// --- Conventions mode -------------------------------------------------------------------------
	const conventionsRequired = declared.conventions?.required ?? false
	const declaredConventionsMode = declared.conventions?.mode ?? "auto"
	let addressSystemConventions: "auto" | string | undefined

	if (overrides.conventions !== undefined) {
		if (overrides.conventions === false) {
			addressSystemConventions = undefined

			if (conventionsRequired) {
				console.error(
					`[createScorer] OVERRIDE: conventions DISABLED (override conventions:false) but the ` +
						`model-card declares them REQUIRED (mode "${declaredConventionsMode}").`
				)
			}
		} else {
			addressSystemConventions = overrides.conventions

			if (overrides.conventions !== declaredConventionsMode) {
				console.error(
					`[createScorer] OVERRIDE: conventions mode set to "${overrides.conventions}" (model-card ` +
						`declares "${declaredConventionsMode}").`
				)
			}
		}
	} else {
		// Declaration drives it: required → the declared mode; not required → leave undefined (byte-stable).
		addressSystemConventions = conventionsRequired ? declaredConventionsMode : undefined

		if (conventionsRequired && !addressSystemConventions) {
			fail(strict, `conventions are declared REQUIRED by the model-card but no mode could be resolved.`)
		}
	}

	// --- Bridge + near-postcode choreography ------------------------------------------------------
	const bridgePunctuationGaps = overrides.bridge ?? declared.bridge?.required ?? false

	const suppressGazetteerNearPostcode =
		overrides.suppressGazetteerNearPostcode ?? declared.suppress_gazetteer_near_postcode ?? false

	// The SHIP OBLIGATION fail-closed (A2): a lookup whose keys only the shaped keyer can reach, paired
	// with a card that does not declare it, is a silently-dead channel. Runs AFTER the lookup is loaded
	// because the artifact is the observable half — the mode alone is not checkable against the graph.
	assertShapedKeyerObligation(postcodeAnchorLookup, declaredSpanMode, anchorSource?.path, strict)

	return new NeuralAddressClassifier({
		tokenizer,
		runner,
		...fstPathEntry(opts.fstPath),
		...(labels ? { labels } : {}),
		...(postcodeAnchorLookup ? { postcodeAnchorLookup } : {}),
		...(declaredSpanMode ? { postcodeAnchorSpanMode: declaredSpanMode } : {}),
		...(gazetteerLexicon ? { gazetteerLexicon } : {}),
		...(countryLexicon ? { countryLexicon } : {}),
		...(streetTypeLexicon ? { streetTypeLexicon } : {}),
		...(localitySurfaceLexicon ? { localitySurfaceLexicon } : {}),
		suppressGazetteerNearPostcode,
		// The card's `mode` is an open string; a non-SystemCode value degrades to a null conventions row
		// downstream, never a throw. Overlay cards may pin a concrete system (en-gb pins "gb", #1275).
		...(addressSystemConventions ? { addressSystemConventions: addressSystemConventions as "auto" | SystemCode } : {}),
		bridgePunctuationGaps,
	})
}

/**
 * Throw in strict mode; otherwise warn loudly and continue (deliberate below-config debugging). `ErrorClass` defaults
 * to {@link UnfedChannelError} (the channel-feed traps); the capability-gate passes {@link CapabilityViolationError} so
 * the two fail-closed families are distinguishable.
 */
function fail(strict: boolean, message: string, ErrorClass: new (message: string) => Error = UnfedChannelError): void {
	const full = `[createScorer] ${message}`

	if (strict) throw new ErrorClass(full)

	console.error(`${full}\n[createScorer] strict=false — continuing despite the violation.`)
}
