/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The evidence-bundle lexicon families and the resolver that answers which generation of one a weights package
 *   ships, checked against the generation the model card says training painted. Split out of `weights.ts`, which had
 *   reached the 1,000-line ceiling: the lexicon interface is its own concern — a family table, a version-mismatch
 *   error, and a resolution ladder — and `resolveWeights` calls it as one step among a dozen.
 */

import { pathExists } from "@mailwoman/core/fs/readers"
import { stringifyJSON } from "@mailwoman/core/json"
import { type PathBuilder, resolvePath } from "path-ts"
import { Globerator } from "spliterator/node/fs"

import { readRequiredChannels } from "#weights/channels"

/**
 * The evidence-bundle lexicon families, and the legacy filename each resolved by
 * before the card named its own (#1510).
 *
 * Why this exists.
 * `resolveWeights` used to probe two literal filenames — `street-type-lexicon-v3.json` and
 * `locality-surface-lexicon-v6.json` — while both the shipped v4.0.1 recipe and the v4.2.0 candidate
 * train against locality-surface **v7** (`/data/gazetteer/locality-surface-lexicon-v7.json`).
 *
 * Serving therefore fed the channel a different lexicon generation than training painted,
 * and nothing said so: the v6 file exists, the channel loads, the parse works.
 * The Run B check had to stage v7's content under the v6 filename to score the candidate faithfully —
 * a workaround that only exists because the filename rather than the card, was the interface.
 *
 * The interface is now the card: `requires.<channel>.lexicon` names the artifact
 * the model trained against, and
 * {@linkcode resolveEvidenceLexicon} resolves that. The legacy filenames stay as the back-compat answer for a card that
 * declares no version — every bundle published before 2026-08-06 — and taking that path warns once.
 */
export const EVIDENCE_LEXICON_FAMILIES = {
	street_type: { prefix: "street-type-lexicon-v", legacy: "street-type-lexicon-v3.json" },
	locality_surface: { prefix: "locality-surface-lexicon-v", legacy: "locality-surface-lexicon-v6.json" },
} as const

export type EvidenceLexiconChannel = keyof typeof EVIDENCE_LEXICON_FAMILIES

/**
 * A train/serve lexicon mismatch (#1510): the card names one generation of an evidence
 * lexicon and the weights package ships a different one.
 *
 * Thrown at load time, from {@linkcode resolveWeights}, naming both versions —
 * the whole point is that this can never again be a silent downgrade.
 */
export class LexiconVersionMismatchError extends Error {
	constructor(message: string) {
		super(message)
		this.name = "LexiconVersionMismatchError"
	}
}

/**
 * Warn-once bookkeeping for the undeclared-lexicon back-compat path.
 *
 * Keyed by `channel:card` so a process that loads two different bundles hears about both,
 * while repeated loads of the same bundle warn once.
 */
const warnedUndeclaredLexicon = new Set<string>()

/**
 * Every generation of `family` a directory ships, e.g. `["locality-surface-lexicon-v6.json"]`.
 *
 * Used only to build the mismatch message — naming what is there is what makes the error actionable.
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
 * Resolve one evidence-bundle lexicon for a weights package, from the card's declaration
 * rather than a hard-coded filename (#1510).
 *
 * The ladder, and why each rung is shaped the way it is:
 *
 * 1. The card names a generation and the package ships that exact file → resolve it.
 *    The train/serve congruent case.
 * 2. The card names a generation, the package ships none of that family → `undefined`.
 *    Absence is absence: a pre-bundle package simply doesn't carry the channel,
 *    and `createScorer` already fails closed if the card also declares it required.
 *    (`neural-weights-base-latn` is the live example — it symlinks en-us's card and ships no lexicons.)
 * 3. The card names a generation, the package ships a different one → throw.
 *    This is the #1510 defect exactly, and it is the only rung where guessing would
 *    be a silent downgrade rather than a plain absence.
 * 4. The card names nothing → the legacy filename, with a one-time warning.
 *    Every bundle published before 2026-08-06.
 *
 * Package-dir only — deliberately not the `baseWeights` fallback the model card and
 * `fst-street-morphology.bin` take, even though the lexicons are locale-general and the dedup would "work".
 * Adding it was tried and reverted while closing #1511: a data-only overlay
 * that ships no lexicon of its own would start resolving the base package's,
 * which silently turns both evidence channels on for every overlay in the repo
 * (de-de, es-es, it-it, en-in, en-nz, fr-fr) in one commit, on locales no board has graded.
 *
 * An overlay that wants the bundle links its own copy and says so in its `files` array.
 * that is one locale's measured decision rather than seven unmeasured ones.
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

	// Nothing of this family anywhere → plain absence rather than a mismatch (rung 2).
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
