/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Resolves the evidence lexicon files of a weights package against the lexicon versions its model card declares.
 */

import { pathExists } from "@mailwoman/core/fs/readers"
import { stringifyJSON } from "@mailwoman/core/json"
import { type PathBuilder, resolvePath } from "path-ts"
import { Globerator } from "spliterator/node/fs"

import { readRequiredChannels } from "#weights/channels"

/**
 * The evidence lexicon families, with each family's filename prefix and legacy filename.
 *
 * A model card declares its lexicon in `requires.<channel>.lexicon`,
 * and {@linkcode resolveEvidenceLexicon} resolves that file.
 * The legacy filename applies only to a card that declares no lexicon, and using it logs a warning once.
 */
export const EVIDENCE_LEXICON_FAMILIES = {
	street_type: { prefix: "street-type-lexicon-v", legacy: "street-type-lexicon-v3.json" },
	locality_surface: { prefix: "locality-surface-lexicon-v", legacy: "locality-surface-lexicon-v6.json" },
} as const

/**
 * A channel key of {@link EVIDENCE_LEXICON_FAMILIES}.
 */
export type EvidenceLexiconChannel = keyof typeof EVIDENCE_LEXICON_FAMILIES

/**
 * Thrown when the model card declares one lexicon version and the weights package ships a different one.
 *
 * Serving a different lexicon version than the model trained with degrades parses without
 * any other error, so {@linkcode resolveWeights} fails the load instead.
 */
export class LexiconVersionMismatchError extends Error {
	constructor(message: string) {
		super(message)
		this.name = "LexiconVersionMismatchError"
	}
}

/**
 * The `channel:card` keys already warned about for an undeclared lexicon.
 *
 * Keying by card makes each distinct bundle warn once.
 */
const warnedUndeclaredLexicon = new Set<string>()

/**
 * Returns every version of a lexicon family in a directory, such as `["locality-surface-lexicon-v6.json"]`.
 *
 * The mismatch error lists these files.
 */
async function shippedLexiconGenerations(dir: PathBuilder, prefix: string): Promise<string[]> {
	try {
		return (await Globerator.files("json", { cwd: dir, absolute: false, recursive: false }).toArray())
			.filter((name) => name.startsWith(prefix))
			.toSorted()
	} catch {
		return []
	}
}

/**
 * Resolves one evidence lexicon for a weights package from the model card's declaration.
 *
 * 1. When the card declares a file and the package has it, the function returns its path.
 * 2. When the card declares a file and the package has no file of that family, it returns `undefined`.
 * 3. When the card declares a file and the package has a different version,
 *    it throws {@link LexiconVersionMismatchError}.
 * 4. When the card declares no file, it returns the legacy filename if present and warns once.
 *
 * Only the package directory is searched.
 * Falling back to the base package would turn the evidence channels on for every
 * data-only overlay, on locales that were never evaluated with them.
 * An overlay that wants a lexicon must ship its own copy.
 */
export async function resolveEvidenceLexicon(
	channel: EvidenceLexiconChannel,
	packageDir: PathBuilder,
	modelCardPath: string | undefined
): Promise<string | undefined> {
	const { prefix, legacy } = EVIDENCE_LEXICON_FAMILIES[channel]
	const declared = (await readRequiredChannels(modelCardPath))?.[channel]?.lexicon

	if (!declared) {
		const candidate = resolvePath(packageDir, legacy)
		const found = (await pathExists(candidate)) ? candidate : undefined

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

	const declaredPath = resolvePath(packageDir, declared)

	if (await pathExists(declaredPath)) {
		return declaredPath
	}

	const shipped = await shippedLexiconGenerations(packageDir, prefix)

	// A package with no file of this family simply lacks the channel.
	if (!shipped.length) return undefined

	throw new LexiconVersionMismatchError(
		`[resolveWeights] ${channel} lexicon MISMATCH between the model-card and the weights package. The card ` +
			`at ${modelCardPath} declares \`requires.${channel}.lexicon\` = ${stringifyJSON(declared)} — the ` +
			`generation the model TRAINED against — but the package at ${packageDir} ships ` +
			`${shipped.map((name) => stringifyJSON(name)).join(", ")}. Serving a different lexicon generation than ` +
			`training painted is a silent train/serve incongruence (#1510), so this refuses rather than downgrading. ` +
			`Stage ${stringifyJSON(declared)} into the package, or correct the card to name what it actually ships.`
	)
}
