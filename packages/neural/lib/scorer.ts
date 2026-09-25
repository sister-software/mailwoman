/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { ADDRESS_SYSTEM_CONVENTIONS, type SystemCode } from "@mailwoman/codex"
import { dataRootPath } from "@mailwoman/core/data-root"
import { pathExists, readLocalJSONFile } from "@mailwoman/core/fs/readers"
import type { PathBuilderLike } from "path-ts"

import { shapedKeyerObligationViolation, type AnchorLookup, type AnchorSpanMode } from "#anchor-inference"
import { NeuralAddressClassifier } from "#classifier/index"
import { parseCountryLexicon, type CountryLexicon } from "#country-inference"
import { parseGazetteerLexicon, type GazetteerLexicon } from "#gazetteer-inference"
import { ONNXRunner } from "#onnx-runner"
import { MailwomanTokenizer } from "#tokenizer"
import { resolveWeights, type ResolvedWeights } from "#weights"
import {
	inferRequiredChannelsFromInputs,
	loadAnchorLookup,
	lookupTagCapability,
	readCapabilityManifest,
	readLabelsFromModelCard,
	readRequiredChannels,
	type RequiredChannels,
} from "#weights/channels"
import { EVIDENCE_LEXICON_FAMILIES } from "#weights/lexicon"

/**
 * Sets the largest F1 drop, `maskOffF1 − maskOnF1`, a conventions mask may cause on a
 * tag the model card certifies before {@link createScorer} rejects it.
 *
 * It is a delta rather than an absolute floor, so a mask that leaves a tag
 * intact is legal whatever that tag's F1.
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
 * Points to the repo-relative, codex-generated country-surface lexicon,
 * which {@link createScorer} tries before the weights package's copy.
 */
export const DEFAULT_COUNTRY_LEXICON = "data/gazetteer/country-surface-lexicon-v1.json"

function createWeightsMemo(locale: string | undefined): () => Promise<ResolvedWeights | null> {
	let memo: Promise<ResolvedWeights | null> | undefined

	return () => (memo ??= resolveWeights({ locale }).catch(() => null))
}

async function resolveDefaultLexicon(
	weightsOnce: () => Promise<ResolvedWeights | null>,
	repoCandidate: string | undefined,
	pick: (weights: ResolvedWeights) => string | undefined
): Promise<string | undefined> {
	if (repoCandidate && (await pathExists(repoCandidate))) return repoCandidate

	const resolved = await weightsOnce()

	return resolved ? pick(resolved) : undefined
}

async function resolveAnchorSource(
	pinned: PathBuilderLike | undefined,
	weightsOnce: () => Promise<ResolvedWeights | null>,
	spanMode: AnchorSpanMode | undefined
): Promise<{ path: PathBuilderLike; binary: boolean } | undefined> {
	if (pinned) return { path: pinned, binary: pinned.endsWith(".bin") }

	if (spanMode !== "shaped" && (await pathExists(DEFAULT_ANCHOR_LOOKUP))) {
		return { path: DEFAULT_ANCHOR_LOOKUP, binary: false }
	}

	const resolved = await weightsOnce()

	if (resolved) return resolved.anchorLookupPath ?? { path: DEFAULT_ANCHOR_LOOKUP, binary: false }

	return (await pathExists(DEFAULT_ANCHOR_LOOKUP)) ? { path: DEFAULT_ANCHOR_LOOKUP, binary: false } : undefined
}

function streetTypeRepoCandidate(declared: RequiredChannels): string {
	return `data/gazetteer/${declared.street_type?.lexicon ?? EVIDENCE_LEXICON_FAMILIES.street_type.legacy}`
}

function fstPathEntry(fstPath: PathBuilderLike | undefined): { fstPath?: PathBuilderLike } {
	return fstPath ? { fstPath } : {}
}

function declaredAnchorSpanMode(declared: RequiredChannels): AnchorSpanMode | undefined {
	return declared.anchor?.span_mode
}

function assertShapedKeyerObligation(
	lookup: AnchorLookup | undefined,
	spanMode: AnchorSpanMode | undefined,
	anchorSourcePath: PathBuilderLike | undefined,
	strict: boolean
): void {
	const violation = shapedKeyerObligationViolation(lookup, spanMode, anchorSourcePath)

	if (violation) {
		fail(strict, violation)
	}
}

/**
 * Overrides individual scorer channels for a deliberate ablation, departing from the model
 * card's declared configuration. {@link createScorer} honors an override but logs a warning
 * when it disables a channel the card declares required or changes the conventions mode.
 */
export interface ScorerOverrides {
	/**
	 * Set `false` to ablate the postcode anchor channel even when the card declares it required.
	 */
	anchor?: boolean

	/**
	 * Set `false` to ablate the gazetteer lexicon channel even when the card declares it required.
	 */
	gazetteer?: boolean

	/**
	 * Set `false` to ablate the street-type evidence channel even when the card declares it required.
	 */
	streetType?: boolean

	/**
	 * Set `false` to ablate the locality-surface evidence channel even when the card declares it required.
	 */
	localitySurface?: boolean

	/**
	 * Set `false` to ablate the country-lexicon channel even when the card declares it required.
	 */
	country?: boolean

	/**
	 * Replaces the card's conventions mode with `"auto"`, a system code, or `false` to disable conventions.
	 */
	conventions?: "auto" | string | false

	/**
	 * Turns punctuation-gap bridging on or off, replacing the card's `bridge` declaration.
	 */
	bridge?: boolean

	/**
	 * Turns suppression of gazetteer evidence near a postcode on or off,
	 * replacing the card's `suppress_gazetteer_near_postcode`.
	 */
	suppressGazetteerNearPostcode?: boolean
}

/**
 * Configures {@link createScorer}, where omitted lexicon paths resolve to repo defaults and
 * then the weights package, and `strict` (default true) throws on an unfed required channel.
 */
export interface CreateScorerOpts {
	modelPath: PathBuilderLike

	tokenizerPath: PathBuilderLike

	/**
	 * Points to the model card that supplies the label vocabulary, the `requires`
	 * channel declaration and the certified capabilities.
	 */
	modelCardPath: PathBuilderLike

	/**
	 * Points to the per-locale FST gazetteer, such as `fst-<locale>.bin`,
	 * which {@link NeuralAddressClassifier.fstPath} exposes so a runtime pipeline
	 * applies the decode-time gazetteer bias.
	 *
	 * Only the path is carried because `neural` does not depend on `resolver-wof-sqlite`,
	 * and omitting it leaves that bias off.
	 */
	fstPath?: PathBuilderLike

	/**
	 * Points to the postcode anchor lookup, read as a PCB1 binary when the path
	 * ends in `.bin` and as JSON otherwise.
	 *
	 * It defaults to {@link DEFAULT_ANCHOR_LOOKUP} when that exists and then the weights
	 * package's lookup, in the reverse order for a card declaring `span_mode: "shaped"`.
	 */
	anchorLookupPath?: PathBuilderLike

	/**
	 * Points to the gazetteer-anchor lexicon, defaulting to {@link DEFAULT_GAZETTEER_LEXICON}
	 * when it exists and then the weights package's copy.
	 */
	gazetteerLexiconPath?: PathBuilderLike

	/**
	 * Points to the street-type evidence lexicon, defaulting to the card-named file under
	 * `data/gazetteer/` when it exists and then the weights package's copy.
	 */
	streetTypeLexiconPath?: string

	/**
	 * Points to the locality-surface evidence lexicon, defaulting to the weights package's copy.
	 */
	localitySurfaceLexiconPath?: string

	/**
	 * Points to the country-surface lexicon, defaulting to {@link DEFAULT_COUNTRY_LEXICON}
	 * when it exists and then the weights package's copy.
	 */
	countryLexiconPath?: string

	/**
	 * Selects the weights package that supplies default lexicons and the anchor lookup;
	 * the model, tokenizer and card are never resolved from it.
	 */
	locale?: string

	/**
	 * Throws when a required channel cannot be fed or a conventions mask would destroy
	 * a certified capability, and defaults to `true`.
	 *
	 * With `false`, the scorer logs the problem and runs below its declared configuration.
	 */
	strict?: boolean

	/**
	 * Names the serving tier whose certified capabilities the conventions check
	 * reads from the card, defaulting to `"server"`.
	 * A tier the card does not certify makes the check a no-op.
	 */
	tier?: string

	/**
	 * Declares deliberate ablations, which log a warning instead of throwing.
	 */
	overrides?: ScorerOverrides
}

class UnfedChannelError extends Error {
	constructor(message: string) {
		super(message)
		this.name = "UnfedChannelError"
	}
}

class CapabilityViolationError extends Error {
	constructor(message: string) {
		super(message)
		this.name = "CapabilityViolationError"
	}
}

let warnedNoCapabilities = false

async function assertConventionsRespectCapabilities(
	modelCardPath: PathBuilderLike,
	tier: string,
	strict: boolean
): Promise<void> {
	const manifest = await readCapabilityManifest(modelCardPath)

	if (!manifest) {
		if (!warnedNoCapabilities) {
			warnedNoCapabilities = true

			console.error(
				`[createScorer] model-card has no \`capabilities\` block — the conventions capability-check ` +
					`(#718/#719) is SKIPPED. Regenerate the card via \`mailwoman eval capability-manifest\` to ` +
					`certify per-tag capability and enable the check.`
			)
		}

		return
	}

	for (const [system, conventions] of Object.entries(ADDRESS_SYSTEM_CONVENTIONS)) {
		for (const tag of conventions?.forbiddenTags ?? []) {
			const cap = lookupTagCapability(manifest, tier, system, tag)

			if (!cap) continue
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
 * Creates a `NeuralAddressClassifier` fed the channels its model card declares,
 * inferring them from the ONNX input names when the card has no `requires` block.
 *
 * In `strict` mode it throws when a required channel cannot be fed or a conventions
 * mask would destroy a certified capability; otherwise it logs and continues.
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

	const declared: RequiredChannels =
		(await readRequiredChannels(opts.modelCardPath)) ?? inferRequiredChannelsFromInputs(await runner.inputNames())

	await assertConventionsRespectCapabilities(opts.modelCardPath, opts.tier ?? "server", strict)

	const declaredSpanMode = declaredAnchorSpanMode(declared)

	const weightsOnce = createWeightsMemo(opts.locale)

	const anchorSource = await resolveAnchorSource(opts.anchorLookupPath, weightsOnce, declaredSpanMode)

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

	const gazetteerLexiconPath =
		opts.gazetteerLexiconPath ??
		(await resolveDefaultLexicon(weightsOnce, DEFAULT_GAZETTEER_LEXICON, (weights) => weights.gazetteerLexiconPath))

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

	const countryLexiconPath =
		opts.countryLexiconPath ??
		(await resolveDefaultLexicon(weightsOnce, DEFAULT_COUNTRY_LEXICON, (weights) => weights.countryLexiconPath))

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

	const streetTypeLexiconPath =
		opts.streetTypeLexiconPath ??
		(await resolveDefaultLexicon(
			weightsOnce,
			streetTypeRepoCandidate(declared),
			(weights) => weights.streetTypeLexiconPath
		))

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
		opts.localitySurfaceLexiconPath ??
		(await resolveDefaultLexicon(weightsOnce, undefined, (weights) => weights.localitySurfaceLexiconPath))

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
		addressSystemConventions = conventionsRequired ? declaredConventionsMode : undefined

		if (conventionsRequired && !addressSystemConventions) {
			fail(strict, `conventions are declared REQUIRED by the model-card but no mode could be resolved.`)
		}
	}

	const bridgePunctuationGaps = overrides.bridge ?? declared.bridge?.required ?? false

	const suppressGazetteerNearPostcode =
		overrides.suppressGazetteerNearPostcode ?? declared.suppress_gazetteer_near_postcode ?? false

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

		...(addressSystemConventions ? { addressSystemConventions: addressSystemConventions as "auto" | SystemCode } : {}),
		bridgePunctuationGaps,
	})
}

function fail(strict: boolean, message: string, ErrorClass: new (message: string) => Error = UnfedChannelError): void {
	const full = `[createScorer] ${message}`

	if (strict) throw new ErrorClass(full)

	console.error(`${full}\n[createScorer] strict=false — continuing despite the violation.`)
}
