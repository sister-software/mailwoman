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
 *   constructs the `OnnxRunner` (onnxruntime-node). Subpath `./scorer`; never import from the
 *   browser bundle.
 */

import { existsSync, readFileSync } from "node:fs"

import { parseAnchorLookup, type AnchorLookup } from "./anchor-inference.js"
import { NeuralAddressClassifier } from "./classifier.js"
import { parseGazetteerLexicon, type GazetteerLexicon } from "./gazetteer-inference.js"
import { OnnxRunner } from "./onnx-runner.js"
import { MailwomanTokenizer } from "./tokenizer.js"
import {
	inferRequiredChannelsFromInputs,
	readLabelsFromModelCard,
	readRequiredChannels,
	type RequiredChannels,
} from "./weights.js"

/** Default postcode→anchor lookup (the pilot lookup the shipped en-us model trained against). */
export const DEFAULT_ANCHOR_LOOKUP = "/mnt/playpen/mailwoman-data/anchor/pilot-anchor-lookup.json"

/** Default gazetteer-anchor lexicon (codex-generated, repo-relative). */
export const DEFAULT_GAZETTEER_LEXICON = "data/gazetteer/anchor-lexicon-v1.json"

/**
 * Per-channel overrides for a deliberate, DECLARED ablation. Setting any of these to a value
 * diverts the scorer from the model-card's declared SHIP-CONFIG; the scorer honors it but emits a
 * loud `console.error` warning (a stated ablation is legal — silent OOD is not, #566/#685).
 */
export interface ScorerOverrides {
	/** `false` to ablate the anchor channel even when the card declares it required. */
	anchor?: boolean
	/** `false` to ablate the gazetteer channel even when the card declares it required. */
	gazetteer?: boolean
	/**
	 * Pin / disable the conventions mode (`"auto"` | a `SystemCode` | `false` to disable) regardless
	 * of the card's declaration.
	 */
	conventions?: "auto" | string | false
	/** Override the bridge declaration. */
	bridge?: boolean
	/** Override the near-postcode gazetteer choreography. */
	suppressGazetteerNearPostcode?: boolean
}

export interface CreateScorerOpts {
	/** Path to the `model.onnx`. */
	modelPath: string
	/** Path to the `tokenizer.model`. */
	tokenizerPath: string
	/** Path to the `model-card.json` (label vocab + the `requires` ship-config). */
	modelCardPath: string
	/** Postcode→anchor lookup path. Default {@link DEFAULT_ANCHOR_LOOKUP}. */
	anchorLookupPath?: string
	/** Gazetteer-anchor lexicon path. Default {@link DEFAULT_GAZETTEER_LEXICON}. */
	gazetteerLexiconPath?: string
	/**
	 * Fail CLOSED (throw) when the model-card declares a channel required but it isn't actually fed.
	 * Default `true`. Set `false` only for throwaway debugging — a below-config scorer is the trap
	 * this module exists to catch.
	 */
	strict?: boolean
	/** Deliberate, DECLARED ablations (warn-not-throw). See {@link ScorerOverrides}. */
	overrides?: ScorerOverrides
}

/** A loud, descriptive fail-closed error for a declared-but-unfed channel. */
class UnfedChannelError extends Error {
	constructor(message: string) {
		super(message)
		this.name = "UnfedChannelError"
	}
}

/**
 * Construct a `NeuralAddressClassifier` wired to the model-card's declared SHIP-CONFIG (anchor +
 * gazetteer + conventions + bridge + near-postcode suppression), failing closed in `strict` mode
 * when a declared channel can't actually be fed.
 *
 * Resolution of "what's required": the card's `requires` block when present; otherwise INFERRED
 * from the ONNX graph's input names (back-compat for every pre-#718 bundle). Explicit `overrides`
 * divert from the declaration with a loud warning rather than a throw.
 */
export async function createScorer(opts: CreateScorerOpts): Promise<NeuralAddressClassifier> {
	const strict = opts.strict ?? true
	const overrides = opts.overrides ?? {}

	if (!existsSync(opts.modelPath)) throw new Error(`createScorer: modelPath does not exist: ${opts.modelPath}`)
	if (!existsSync(opts.tokenizerPath)) {
		throw new Error(`createScorer: tokenizerPath does not exist: ${opts.tokenizerPath}`)
	}
	if (!existsSync(opts.modelCardPath)) {
		throw new Error(`createScorer: modelCardPath does not exist: ${opts.modelCardPath}`)
	}

	const labels = readLabelsFromModelCard(opts.modelCardPath)
	const [tokenizer, runner] = await Promise.all([
		MailwomanTokenizer.loadFromFile(opts.tokenizerPath),
		OnnxRunner.create(opts.modelPath),
	])

	// What the model DECLARES it needs. Card `requires` block is authoritative; older cards (no block)
	// fall back to the ONNX graph's declared inputs — a model exporting anchor_features/gazetteer_features
	// trained with those channels mandatory. Conventions/bridge are card-only (not graph-observable).
	const declared: RequiredChannels =
		readRequiredChannels(opts.modelCardPath) ?? inferRequiredChannelsFromInputs(await runner.inputNames())

	// --- Anchor channel ---------------------------------------------------------------------------
	const anchorLookupPath = opts.anchorLookupPath ?? DEFAULT_ANCHOR_LOOKUP
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
		postcodeAnchorLookup = existsSync(anchorLookupPath)
			? parseAnchorLookup(JSON.parse(readFileSync(anchorLookupPath, "utf8")))
			: undefined
		// Fail closed: declared-required but the lookup is missing or parsed empty → the model would be
		// fed zeros (the anchor-off identity) and silently go OOD. That's the #566/#685 trap.
		if (anchorRequired && !(postcodeAnchorLookup && postcodeAnchorLookup.size > 0)) {
			const reason = postcodeAnchorLookup
				? `parsed lookup is EMPTY (size 0)`
				: `lookup file not found at ${anchorLookupPath}`
			fail(
				strict,
				`anchor channel is declared REQUIRED by the model-card but cannot be fed: ${reason}. ` +
					`Provide a valid --anchor-lookup, or pass overrides.anchor=false for a deliberate ablation.`
			)
		}
	}

	// --- Gazetteer channel ------------------------------------------------------------------------
	const gazetteerLexiconPath = opts.gazetteerLexiconPath ?? DEFAULT_GAZETTEER_LEXICON
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
		gazetteerLexicon = existsSync(gazetteerLexiconPath)
			? parseGazetteerLexicon(JSON.parse(readFileSync(gazetteerLexiconPath, "utf8")))
			: undefined
		if (gazetteerRequired && !gazetteerLexicon) {
			fail(
				strict,
				`gazetteer channel is declared REQUIRED by the model-card but the lexicon file was not found ` +
					`at ${gazetteerLexiconPath}. Provide a valid --gazetteer-lexicon, or pass overrides.gazetteer=false ` +
					`for a deliberate ablation.`
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

	return new NeuralAddressClassifier({
		tokenizer,
		runner,
		...(labels ? { labels } : {}),
		...(postcodeAnchorLookup ? { postcodeAnchorLookup } : {}),
		...(gazetteerLexicon ? { gazetteerLexicon } : {}),
		suppressGazetteerNearPostcode,
		...(addressSystemConventions ? { addressSystemConventions: addressSystemConventions as "auto" } : {}),
		bridgePunctuationGaps,
	})
}

/** Throw in strict mode; otherwise warn loudly and continue (deliberate below-config debugging). */
function fail(strict: boolean, message: string): void {
	const full = `[createScorer] ${message}`
	if (strict) throw new UnfedChannelError(full)
	console.error(`${full}\n[createScorer] strict=false — continuing with the channel UNFED (OOD).`)
}
