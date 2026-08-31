/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Model-card channel declarations and per-tag capability reading — which evidence channels a weights bundle
 *   REQUIRES, which it merely ships, and what the runtime must warn about when one goes unfed. Split from
 *   `weights.ts`, which answers the different question of WHERE the artifacts are.
 */

import { pathExists, readLocalBuffer, readLocalJSONFile, readLocalTextFile } from "@mailwoman/core/fs/readers"
import { tryParsingJSON } from "@mailwoman/core/objects"
import { type PathBuilderLike, resolvePath } from "path-ts"

import { type AnchorLookup, type AnchorSpanMode, parseAnchorLookup } from "#anchor-inference"
import { PostcodeBinaryResolver } from "#postcode-binary-resolver"

// The graph-input inference lives in ort-feeds.ts (pure, so the browser loader shares it); re-exported
// here because this module is where every other channel-requirement reader lives.
export { inferRequiredChannelsFromInputs } from "#ort-feeds"

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
 * The card's `files` block is the package's manifest of intent and the only per-package statement of what SHOULD be on
 * disk — `requires` describes the trained ENCODER, which is a different claim and is shared across every overlay that
 * inherits the base model. Conflating the two is the #1516 defect: en-gb's card declares `requires.anchor.required:
 * true` (a true statement about the encoder) while deliberately shipping no `postcode-gb.bin` under the #1476
 * mitigation, so a guard keyed on `requires` alone calls a supported configuration broken, and — because the old
 * warning fired once per PROCESS and named no package — the operator reads that as the PRIMARY locale's bin being
 * missing.
 *
 * Reads the package's own card only, never the `baseWeights` fallback: an overlay that ships no card of its own is
 * making no claim about its files, and inheriting the base's manifest would attribute `postcode-us.bin` to it.
 *
 * @returns `undefined` when the package has no card, the card has no `files` block, or none of `keys` appears there —
 * all three meaning "this package declares no such artifact", which is a legal posture, not a fault.
 */
export async function readDeclaredArtifactFile(
	packageDir: PathBuilderLike | undefined,
	keys: readonly string[] = ANCHOR_ARTIFACT_CARD_KEYS
): Promise<DeclaredArtifact | undefined> {
	if (!packageDir) return undefined

	const cardPath = resolvePath(packageDir, "model-card.json")

	if (!(await pathExists(cardPath))) return undefined

	let parsed: unknown

	try {
		parsed = tryParsingJSON(await readLocalTextFile(cardPath))
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

		const path = resolvePath(packageDir, file)

		return { key, file, path, present: await pathExists(path) }
	}

	return undefined
}

/**
 * Read + parse a `model-card.json` into a plain object, or `undefined` when the card is absent, unreadable, or not an
 * object — the shared DEFENSIVE preamble of every card reader below. Each reader keeps its own "present but corrupt"
 * checks: a malformed declared contract is a loud artifact bug, not a silent re-default.
 */
async function readModelCardObject(
	modelCardPath: PathBuilderLike | undefined
): Promise<Record<string, unknown> | undefined> {
	if (!modelCardPath || !(await pathExists(modelCardPath))) return undefined
	let raw: string

	try {
		raw = await readLocalTextFile(modelCardPath)
	} catch {
		return undefined
	}

	const parsed = tryParsingJSON(raw)

	if (typeof parsed !== "object" || parsed === null) return undefined

	return parsed as Record<string, unknown>
}

/**
 * Load an `AnchorLookup` from either a PCB1 binary or a JSON pilot lookup (#718 D1) — the two on-disk shapes a weights
 * package's postcode→anchor artifact takes. Shared by the Node classifier loader and the ProductionScorer.
 */
export async function loadAnchorLookup(source: { path: PathBuilderLike; binary: boolean }): Promise<AnchorLookup> {
	return source.binary
		? new PostcodeBinaryResolver(new Uint8Array(await readLocalBuffer(source.path))).toAnchorLookup()
		: parseAnchorLookup(await readLocalJSONFile(source.path))
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
export async function unfedAnchorDetail(packageDir: PathBuilderLike | undefined): Promise<string | undefined> {
	const declared = await readDeclaredArtifactFile(packageDir)

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
export async function readRequiredChannels(
	modelCardPath: PathBuilderLike | undefined
): Promise<RequiredChannels | undefined> {
	const card = await readModelCardObject(modelCardPath)

	if (!card) return undefined
	const requires = card.requires

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
export async function readCapabilityManifest(
	modelCardPath: PathBuilderLike | undefined
): Promise<CapabilityManifest | undefined> {
	const card = await readModelCardObject(modelCardPath)

	if (!card) return undefined
	const capabilities = card.capabilities

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
export async function readCRFTransitions(crfPath: PathBuilderLike | undefined): Promise<CRFTransitions | undefined> {
	if (!crfPath || !(await pathExists(crfPath))) return undefined
	let raw: string

	try {
		raw = await readLocalTextFile(crfPath)
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
export async function readLabelsFromModelCard(
	modelCardPath: PathBuilderLike | undefined
): Promise<readonly string[] | undefined> {
	const card = await readModelCardObject(modelCardPath)

	if (!card) return undefined
	const labels = card.labels

	if (labels === undefined) return undefined

	if (!Array.isArray(labels) || !labels.length || !labels.every((l) => typeof l === "string")) {
		throw new Error(
			`model-card.json at ${modelCardPath} has a malformed \`labels\` field — ` +
				`expected a non-empty array of strings, got ${JSON.stringify(labels)}.`
		)
	}

	return Object.freeze(labels.slice()) as readonly string[]
}
