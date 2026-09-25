/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Reads a weights package's model card: required channels, declared files, capabilities and labels.
 */

import { pathExists, readLocalBuffer, readLocalJSONFile, readLocalTextFile } from "@mailwoman/core/fs/readers"
import { tryParsingJSON, stringifyJSON } from "@mailwoman/core/json"
import { type PathBuilderLike, resolvePath } from "path-ts"

import { type AnchorLookup, type AnchorSpanMode, parseAnchorLookup } from "#anchor-inference"
import { type EncoderDescriptor, encoderDescriptorFromCard } from "#char-encoder"
import { PostcodeBinaryResolver } from "#postcode/binary-resolver"

/**
 * Re-exports the inference of required channels from ONNX input names,
 * which lives in the browser-safe feed module.
 */
export { inferRequiredChannelsFromInputs } from "#ort-feeds"

/**
 * The `requires` block of a `model-card.json`, which declares the channel
 * configuration the model trained with.
 *
 * `createScorer` fails when a required channel cannot be fed.
 * A missing channel counts as not required.
 */
export interface RequiredChannels {
	/**
	 * The postcode-anchor channel.
	 *
	 * `span_mode` declares which substrings the runtime looks up.
	 * Omit it or use `alnum-run` for most models.
	 *
	 * Use `shaped` only for a model trained against a lookup with letter-containing
	 * keys (see `AnchorSpanMode`).
	 * A mismatch in either direction changes which postcodes get anchored.
	 */
	anchor?: { required: boolean; span_mode?: AnchorSpanMode }
	/**
	 * The gazetteer channel.
	 */
	gazetteer?: { required: boolean }
	/**
	 * The country channel.
	 */
	country?: { required: boolean }
	/**
	 * The address-system conventions.
	 * `mode` mirrors `ParseOpts.addressSystemConventions`.
	 */
	conventions?: { required: boolean; mode?: "auto" | string }
	/**
	 * The punctuation-gap span bridge.
	 */
	bridge?: { required: boolean }
	/**
	 * Whether the gazetteer channel is zeroed next to postcode-anchor hits.
	 */
	suppress_gazetteer_near_postcode?: boolean
	/**
	 * The street-type evidence channel.
	 *
	 * `lexicon` names the lexicon generation the model trained against.
	 * See {@linkcode EVIDENCE_LEXICON_FAMILIES}.
	 */
	street_type?: { required: boolean; lexicon?: string }
	/**
	 * The locality-surface evidence channel.
	 *
	 * `lexicon` names the lexicon generation the model trained against.
	 * See {@linkcode EVIDENCE_LEXICON_FAMILIES}.
	 */
	locality_surface?: { required: boolean; lexicon?: string }
}

/**
 * The `files` keys under which a model card lists its postcode anchor artifact, in preference order.
 *
 * The PCB1 binary (`postcode-<cc>.bin`) comes first, then the older JSON lookup.
 */
export const ANCHOR_ARTIFACT_CARD_KEYS = ["postcode_anchor", "anchor_lookup"] as const

/**
 * A file that a package's own model card lists, and whether the file exists.
 */
export interface DeclaredArtifact {
	/**
	 * The `files` key, such as `postcode_anchor`.
	 */
	key: string
	/**
	 * The filename exactly as the card gives it, such as `postcode-us.bin`.
	 */
	file: string
	/**
	 * {@link DeclaredArtifact.file} resolved against `packageDir`.
	 */
	path: string
	present: boolean
}

/**
 * Returns the first of `keys` that a weights package's own `model-card.json` lists under `files`.
 *
 * The `files` block states what this package should contain.
 * The `requires` block describes the trained encoder, which overlays share with their base model.
 *
 * An overlay may therefore require a channel and still deliberately ship no artifact for it.
 *
 * Only the package's own card is read.
 * An overlay without a card makes no claim about its files and must not inherit the base package's list.
 *
 * @returns `undefined` when the package has no card, the card has no `files` block,
 * or none of `keys` appears there.
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

		// Cards record a deliberate absence in a `$comment_*` key, so only a plain filename counts.
		if (typeof file !== "string" || !file || file.startsWith("$")) continue

		const path = resolvePath(packageDir, file)

		return { key, file, path, present: await pathExists(path) }
	}

	return undefined
}

/**
 * Reads a `model-card.json` into a plain object.
 *
 * It returns `undefined` when the card is absent, unreadable or not an object.
 * Each caller validates its own field and throws when that field is present but malformed.
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
 * Loads an `AnchorLookup` from a PCB1 binary or a JSON lookup.
 */
export async function loadAnchorLookup(source: { path: PathBuilderLike; binary: boolean }): Promise<AnchorLookup> {
	return source.binary
		? new PostcodeBinaryResolver(new Uint8Array(await readLocalBuffer(source.path))).toAnchorLookup()
		: parseAnchorLookup(await readLocalJSONFile(source.path))
}

/**
 * A soft-feature channel that `loadFromWeights` can find required but unfed.
 */
export type UnfedChannel = "anchor" | "gazetteer" | "country" | "street_type" | "locality_surface"

/**
 * The process-wide set of `<channel>:<package>` keys already warned about.
 */
const warnedUnfedChannels = new Set<string>()

/**
 * Returns a function that logs an error when a required channel of one weights package cannot be fed.
 *
 * The parse still runs with the channel off.
 * Warnings are deduplicated per channel and package, because one process can load
 * several packages and each message must identify the package that degraded.
 *
 * @param weightsPackage The package identifier for the message, such as the locale and resolved directory.
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
 * Returns the reason an unfed anchor channel deserves a warning for this package,
 * or `undefined` when it does not.
 *
 * A package whose card lists an anchor file that is missing or empty is broken, so it gets a warning.
 * A package whose card lists no anchor file has chosen not to ship one, so it gets none.
 *
 * The `requires` block cannot decide this because overlays inherit it from the base model.
 */
export async function unfedAnchorDetail(packageDir: PathBuilderLike | undefined): Promise<string | undefined> {
	const declared = await readDeclaredArtifactFile(packageDir)

	if (!declared) return undefined

	return declared.present
		? `its declared files.${declared.key} (${declared.file}) parsed EMPTY`
		: `its card declares files.${declared.key} = ${declared.file}, which is NOT in the package`
}

/**
 * The encoder declared by a model card.
 */
export type { EncoderDescriptor } from "#char-encoder"

/**
 * Reads the `encoder` block from a model card file with `encoderDescriptorFromCard`.
 */
export async function readEncoderFromModelCard(modelCardPath: PathBuilderLike | undefined): Promise<EncoderDescriptor> {
	return encoderDescriptorFromCard(await readModelCardObject(modelCardPath), modelCardPath?.toString() ?? "model card")
}

/**
 * Reads the `requires` block from a `model-card.json`.
 *
 * It returns `undefined` when the card is absent, unreadable or has no `requires` field.
 * Callers then infer the required channels with `inferRequiredChannelsFromInputs`.
 *
 * @throws When the field is present but malformed, such as a channel entry with a non-boolean `required`.
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
				`expected an object, got ${stringifyJSON(requires)}.`
		)
	}

	const obj = requires as Record<string, unknown>

	// Each channel entry that is present must have a boolean `required` field.
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
					`expected { required: boolean }, got ${stringifyJSON(entry)}.`
			)
		}
	}

	// A non-string lexicon name would silently fall back to the older default filename, so it throws.
	for (const channel of ["street_type", "locality_surface"] as const) {
		const lexicon = (obj[channel] as { lexicon?: unknown } | undefined)?.lexicon

		if (lexicon !== undefined && typeof lexicon !== "string") {
			throw new Error(
				`model-card.json at ${modelCardPath} has a malformed \`requires.${channel}.lexicon\` — ` +
					`expected a filename string, got ${stringifyJSON(lexicon)}.`
			)
		}
	}

	// An unrecognized span mode would anchor the wrong spans without any error, so it throws.
	const anchorSpanMode = (obj.anchor as { span_mode?: unknown } | undefined)?.span_mode

	if (anchorSpanMode !== undefined && anchorSpanMode !== "alnum-run" && anchorSpanMode !== "shaped") {
		throw new Error(
			`model-card.json at ${modelCardPath} has a malformed \`requires.anchor.span_mode\` — ` +
				`expected "alnum-run" or "shaped", got ${stringifyJSON(anchorSpanMode)}.`
		)
	}

	if (obj.suppress_gazetteer_near_postcode !== undefined && typeof obj.suppress_gazetteer_near_postcode !== "boolean") {
		throw new Error(
			`model-card.json at ${modelCardPath} has a malformed \`requires.suppress_gazetteer_near_postcode\` ` +
				`field — expected a boolean, got ${stringifyJSON(obj.suppress_gazetteer_near_postcode)}.`
		)
	}

	return requires as RequiredChannels
}

/**
 * One tag's certified capability for one tier and address system in the capability manifest.
 */
export interface TagCapability {
	/**
	 * The measured per-tag exact-match F1, in percent, with the conventions mask off.
	 */
	maskOffF1: number
	/**
	 * The measured per-tag F1, in percent, with the mask on.
	 *
	 * It is recorded only for tags that some codex `forbiddenTags` list masks,
	 * because only the delta check reads it.
	 */
	maskOnF1?: number
}

/**
 * The `capabilities` block of a `model-card.json`, shaped as `capabilities[tier][system][tag]`.
 *
 * The tiers are `server` (anchor and gazetteer channels) and `pocket` (anchor only).
 * `createScorer` reads the block to reject a conventions mask that would forbid
 * a tag the model is certified to emit.
 * Readers ignore a `$comment` key beside the tier keys.
 */
export type CapabilityManifest = Record<string, Record<string, Record<string, TagCapability>>>

/**
 * Reads the `capabilities` block from a `model-card.json`.
 *
 * It returns `undefined` when the card is absent, unreadable or has no `capabilities`
 * field, and the delta check is then skipped.
 * Malformed cells inside the block are ignored by `lookupTagCapability`.
 *
 * @throws When the field is present but is not an object.
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
				`expected an object, got ${stringifyJSON(capabilities)}.`
		)
	}

	return capabilities as CapabilityManifest
}

/**
 * Returns `capabilities[tier][system][tag]`, or `undefined` for a missing or malformed cell.
 *
 * The scorer treats an uncertified tag as safe to mask.
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

/**
 * Learned CRF transition scores from `crf-transitions.json`.
 */
export interface CRFTransitions {
	transitions: number[][]
	startTransitions: number[]
	endTransitions: number[]
}

/**
 * Reads learned CRF transition scores from `crf-transitions.json`.
 *
 * @returns `undefined` when the file is missing or malformed.
 * Callers then use only the structural BIO mask.
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
 * Reads the `labels` array from a `model-card.json` file.
 *
 * It returns `undefined` when the file is missing, unreadable or has no `labels` field,
 * and callers then use their built-in default labels.
 *
 * @throws When `labels` is present but is not a non-empty array of strings.
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
				`expected a non-empty array of strings, got ${stringifyJSON(labels)}.`
		)
	}

	return Object.freeze(labels.slice()) as readonly string[]
}

/**
 * Returns whether a directory holds a package's binaries.
 *
 * The binaries are `model.onnx` plus either `tokenizer.model` or, when the card declares
 * a character encoder, the character vocabulary the card names.
 */
export async function packageHasBinaries(dir: PathBuilderLike): Promise<boolean> {
	if (!(await pathExists(resolvePath(dir, "model.onnx")))) return false

	if (await pathExists(resolvePath(dir, "tokenizer.model"))) return true

	const cardPath = resolvePath(dir, "model-card.json")
	const encoder = await readEncoderFromModelCard(cardPath)

	if (encoder.kind === "char") return await pathExists(resolvePath(dir, encoder.charVocab))

	await assertNoOrphanedCharVocab(dir, cardPath)

	return false
}

/**
 * Throws when a directory has a character vocabulary but its card declares no character encoder.
 *
 * Without this check, the package would load as a Latin model and silently
 * mis-parse every line in its script.
 */
async function assertNoOrphanedCharVocab(dir: PathBuilderLike, cardPath: PathBuilderLike): Promise<void> {
	if (!(await pathExists(resolvePath(dir, "char-vocab.json")))) return

	throw new Error(
		`${dir}: char-vocab.json is present but ${cardPath} declares no char encoder — the model card is missing or ` +
			"does not carry an `encoder` block, so this package would load as a Latin model and mis-parse every line " +
			"its script covers."
	)
}

/**
 * Returns the path of the character vocabulary file.
 *
 * It prefers the package's own copy, then the base package's copy, which an overlay shares.
 * When neither exists, it returns the package path so the missing-file error shows where it looked.
 */
export async function resolveCharVocab(
	packageDir: PathBuilderLike,
	baseDir: PathBuilderLike | undefined,
	fileName: string
): Promise<string> {
	const own = resolvePath(packageDir, fileName)

	if (await pathExists(own)) return own

	if (baseDir) {
		const base = resolvePath(baseDir, fileName)

		if (await pathExists(base)) return base
	}

	return own
}
