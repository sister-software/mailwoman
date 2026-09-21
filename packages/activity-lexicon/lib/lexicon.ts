/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Reader and audit for the reviewed activity-phrase lexicon.
 *
 *   Activities differ from POI categories because they can apply to multiple, locale-dependent entity kinds.
 *   Invalid or incomplete entries cause {@linkcode readActivityLexicon} to throw.
 */

import { readLocalJSONFile } from "@mailwoman/core/fs/readers"
import { stringifyJSON } from "@mailwoman/core/json"
import { resolvePackagedDataPath } from "@mailwoman/core/module/packaged-data"
import { resolveLocaleScope } from "@mailwoman/variant-aliases"

import type {
	ActivityPhraseEntry,
	ActivityPhraseLexicon,
	ActivityPhraseLocaleMatch,
	ActivityPhraseDerivation,
} from "#types"

const moduleDir = import.meta.dirname

/**
 * Every derivation the closed list admits, for the audit.
 */
const DERIVATIONS: ReadonlyArray<ActivityPhraseDerivation> = ["plural", "nominalization", "verb-phrase", "possessive"]

/**
 * The committed lexicon, located by the shared source-tree/`out/` probe
 * in `@mailwoman/core/module/packaged-data`.
 */
export const ACTIVITY_LEXICON_PATH: string = await resolvePackagedDataPath(moduleDir, "activity-lexicon.json")

/**
 * Normalize a phrase for comparison: nfkc, trimmed, whitespace collapsed, lowercased.
 *
 * Uses locale-independent lowercasing.
 * Locale scope is resolved separately.
 */
export function normalizeActivityPhrase(phrase: string): string {
	return phrase.normalize("NFKC").trim().replaceAll(/\s+/g, " ").toLowerCase()
}

/**
 * Decide whether an entry answers under a locale, delegating to `@mailwoman/variant-aliases`'
 * {@linkcode resolveLocaleScope} — the owner of these semantics.
 *
 * A scoped entry does not match when the locale is unknown.
 */
export function resolveActivityPhraseLocale(
	entry: ActivityPhraseEntry,
	locale: string | undefined
): ActivityPhraseLocaleMatch | null {
	return resolveLocaleScope(entry.locales, locale)
}

/**
 * Everything wrong with a lexicon that can be established without leaving this
 * package, one message per problem.
 *
 * The checks an entry's attestation invites but this package cannot make — that a committed
 * query row exists and ends in the phrase, that a referenced synonym carries the locales
 * the entry copied, that a cited description clause is really in the compiled concept —
 * belong to a consumer that holds those artifacts, and are made there.
 */
export function auditActivityLexicon(lexicon: ActivityPhraseLexicon): string[] {
	const problems: string[] = []

	if (!lexicon.phrases.length) {
		problems.push("the lexicon is empty — a vocabulary with no surface form can never fire")
	}

	const byPhrase = new Map<string, ActivityPhraseEntry>()

	for (const entry of lexicon.phrases) {
		const normalized = normalizeActivityPhrase(entry.phrase)
		const named = stringifyJSON(entry.phrase)

		if (!normalized) {
			problems.push(`phrase ${named} normalizes to nothing`)

			continue
		}

		if (byPhrase.has(normalized)) {
			problems.push(`phrase ${named} is declared twice`)

			continue
		}

		byPhrase.set(normalized, entry)

		if (entry.source !== "curated") {
			problems.push(
				`phrase ${named} declares source ${stringifyJSON(entry.source)} — the only reviewed source is \`curated\``
			)
		}

		if (!entry.note.trim()) {
			problems.push(`phrase ${named} carries no note — an entry nobody can review is an entry nobody can remove`)
		}

		if (entry.locales && !entry.locales.length) {
			problems.push(`phrase ${named} declares an empty locale list — scoped to nowhere, it can never fire`)
		}
	}

	for (const entry of lexicon.phrases) {
		problems.push(...auditAttestation(entry, byPhrase))
	}

	return problems
}

/**
 * The attestation half of the audit: whatever an entry's attestation points at
 * inside this lexicon has to be there.
 */
function auditAttestation(entry: ActivityPhraseEntry, byPhrase: ReadonlyMap<string, ActivityPhraseEntry>): string[] {
	const named = stringifyJSON(entry.phrase)
	const { attestation } = entry

	switch (attestation.kind) {
		case "committed-query": {
			const query = normalizeActivityPhrase(attestation.detail)
			const phrase = normalizeActivityPhrase(entry.phrase)

			if (query !== phrase && !query.includes(` ${phrase} `) && !query.startsWith(`${phrase} `)) {
				return [
					`phrase ${named} cites committed query ${stringifyJSON(attestation.detail)}, which omits it as a subject`,
				]
			}

			return []
		}

		case "concept-description": {
			if (attestation.reference !== entry.activity) {
				return [
					`phrase ${named} cites the description of ${stringifyJSON(attestation.reference)} while naming activity ${stringifyJSON(entry.activity)}`,
				]
			}

			return attestation.detail.trim() ? [] : [`phrase ${named} cites a description clause but quotes none of it`]
		}

		case "derived-form":
		case "regional-register": {
			const base = byPhrase.get(normalizeActivityPhrase(attestation.base))

			if (!base) {
				return [
					`phrase ${named} is attested against base ${stringifyJSON(attestation.base)}, which the lexicon does not declare`,
				]
			}

			const problems: string[] = []

			if (base.attestation.kind === "derived-form") {
				problems.push(
					`phrase ${named} is derived from ${stringifyJSON(attestation.base)}, which is itself derived — an attestation chain that never reaches a committed record attests nothing`
				)
			}

			if (base.activity !== entry.activity) {
				problems.push(
					`phrase ${named} names activity ${stringifyJSON(entry.activity)} while its base names ${stringifyJSON(base.activity)}`
				)
			}

			if (attestation.kind === "derived-form") {
				if (!DERIVATIONS.includes(attestation.derivation)) {
					problems.push(
						`phrase ${named} declares derivation ${stringifyJSON(attestation.derivation)}, which is not a known one`
					)
				}

				if (stringifyJSON(entry.locales ?? null) !== stringifyJSON(base.locales ?? null)) {
					problems.push(
						`phrase ${named} is a derived form whose locale scope differs from its base — a regular transformation does not change where a phrasing is used`
					)
				}
			}

			return problems
		}
	}
}

let committed: ActivityPhraseLexicon | undefined

/**
 * Read the lexicon, refusing one the audit rejects.
 *
 * The committed read is memoized.
 * An explicit path is read fresh, which is what a test asserting a refusal needs.
 */
export async function readActivityLexicon(path: string = ACTIVITY_LEXICON_PATH): Promise<ActivityPhraseLexicon> {
	if (path === ACTIVITY_LEXICON_PATH && committed) return committed

	const lexicon = await readLocalJSONFile<ActivityPhraseLexicon>(path)
	const problems = auditActivityLexicon(lexicon)

	if (problems.length) {
		throw new Error(
			[`activity-lexicon: ${path} does not audit:`].concat(problems.map((problem) => `  - ${problem}`)).join("\n")
		)
	}

	if (path === ACTIVITY_LEXICON_PATH) {
		committed = lexicon
	}

	return lexicon
}
