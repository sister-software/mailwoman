/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Reader and audit for the reviewed activity-phrase lexicon.
 *
 *   WHY THIS IS ITS OWN VOCABULARY. `@mailwoman/poi-taxonomy`'s phrases are venue nouns and each names ONE category;
 *   an activity is afforded by a SET of entity kinds, and the set is country-conditional. A phrase naming an activity
 *   therefore cannot be a synonym in that table without saying something the table has no field for. It is equally not
 *   part of the compiled world model: that artifact carries concepts, relations, mappings and provenance, and a phrase
 *   is none of those — it is how a person says the thing, which is recognition rather than knowledge.
 *
 *   THE AUDIT REFUSES RATHER THAN DEGRADES. Every problem {@linkcode auditActivityLexicon} reports is a record that
 *   would answer nothing while reading as though it answered: a phrase declared twice, a phrase scoped to no locale, a
 *   derived form whose base is absent or is itself derived so the chain never reaches a committed record. Each of those
 *   produces a lexicon that looks complete and is short, and a consumer measuring recognition breadth would read the
 *   shortfall as the world rather than as the file. So {@linkcode readActivityLexicon} throws.
 *
 *   ZERO DEPENDENCIES, deliberately: a vocabulary any package may read must not drag a graph behind it.
 */

import { pathExists, readLocalJSONFile } from "@mailwoman/core/fs/readers"
import { resolve } from "@mailwoman/platform/path"

import type {
	ActivityPhraseEntry,
	ActivityPhraseLexicon,
	ActivityPhraseLocaleMatch,
	ActivityPhraseDerivation,
} from "./types.ts"

const moduleDir = import.meta.dirname

/**
 * Every derivation the closed list admits, for the audit.
 */
const DERIVATIONS: ReadonlyArray<ActivityPhraseDerivation> = ["plural", "nominalization", "verb-phrase", "possessive"]

/**
 * The committed lexicon.
 *
 * `data/` sits at the package root (it is a `files` entry), and this module sits either at that root — running from
 * source — or under `out/` when compiled, so there are exactly two places to look. Probing for the FILE rather than
 * attempting a parse keeps a corrupt lexicon from reading as an absent one.
 */
export const ACTIVITY_LEXICON_PATH: string = await (async () => {
	const candidates = [
		resolve(moduleDir, "data", "activity-lexicon.json"),
		resolve(moduleDir, "..", "data", "activity-lexicon.json"),
	]

	let found: string | null = null

	for (const candidate of candidates) {
		if (await pathExists(candidate)) {
			found = candidate

			break
		}
	}

	if (!found) {
		throw new Error(`activity-lexicon: could not find data/activity-lexicon.json — looked in ${candidates.join(", ")}`)
	}

	return found
})()

/**
 * Normalize a phrase for comparison: NFKC, trimmed, whitespace collapsed, lowercased.
 *
 * `toLowerCase` rather than `toLocaleLowerCase`, deliberately: the locale-sensitive form folds a dotted capital `I` to
 * `i̇` under a Turkish host locale, which would make the same query answer differently on two machines. Locale SCOPING
 * is a property of the entry and is decided by {@linkcode resolveActivityPhraseLocale}; it never reaches the text.
 */
export function normalizeActivityPhrase(phrase: string): string {
	return phrase.normalize("NFKC").trim().replaceAll(/\s+/g, " ").toLowerCase()
}

/**
 * Decide whether an entry answers under a locale, following the `@mailwoman/variant-aliases` semantics.
 *
 * A scoped entry does not match when the locale is unknown. That is the containment: a phrasing declared regional
 * cannot be reached without knowing the region, or the record means something different from what it says.
 */
export function resolveActivityPhraseLocale(
	entry: ActivityPhraseEntry,
	locale: string | undefined
): ActivityPhraseLocaleMatch | null {
	if (!entry.locales) return { scope: "unscoped", confidence: 1 }

	if (!locale) return null

	if (entry.locales.includes(locale)) return { scope: "exact", confidence: 1 }

	const language = locale.split(/[-_]/)[0]

	if (entry.locales.some((tag) => tag.split(/[-_]/)[0] === language)) return { scope: "language", confidence: 0.5 }

	return null
}

/**
 * Everything wrong with a lexicon that can be established without leaving this package, one message per problem.
 *
 * The checks an entry's attestation invites but this package cannot make — that a committed query row exists and ends
 * in the phrase, that a referenced synonym carries the locales the entry copied, that a cited description clause is
 * really in the compiled concept — belong to a consumer that holds those artifacts, and are made there.
 */
export function auditActivityLexicon(lexicon: ActivityPhraseLexicon): string[] {
	const problems: string[] = []

	if (!lexicon.phrases.length) {
		problems.push("the lexicon is empty — a vocabulary with no surface form can never fire")
	}

	const byPhrase = new Map<string, ActivityPhraseEntry>()

	for (const entry of lexicon.phrases) {
		const normalized = normalizeActivityPhrase(entry.phrase)
		const named = JSON.stringify(entry.phrase)

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
				`phrase ${named} declares source ${JSON.stringify(entry.source)} — the only reviewed source is \`curated\``
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
 * The attestation half of the audit: whatever an entry's attestation points at inside this lexicon has to be there.
 */
function auditAttestation(entry: ActivityPhraseEntry, byPhrase: ReadonlyMap<string, ActivityPhraseEntry>): string[] {
	const named = JSON.stringify(entry.phrase)
	const { attestation } = entry

	switch (attestation.kind) {
		case "committed-query": {
			const query = normalizeActivityPhrase(attestation.detail)
			const phrase = normalizeActivityPhrase(entry.phrase)

			if (query !== phrase && !query.includes(` ${phrase} `) && !query.startsWith(`${phrase} `)) {
				return [
					`phrase ${named} cites committed query ${JSON.stringify(attestation.detail)}, which does not contain it as a subject`,
				]
			}

			return []
		}

		case "concept-description": {
			if (attestation.reference !== entry.activity) {
				return [
					`phrase ${named} cites the description of ${JSON.stringify(attestation.reference)} while naming activity ${JSON.stringify(entry.activity)}`,
				]
			}

			return attestation.detail.trim() ? [] : [`phrase ${named} cites a description clause but quotes none of it`]
		}

		case "derived-form":
		case "regional-register": {
			const base = byPhrase.get(normalizeActivityPhrase(attestation.base))

			if (!base) {
				return [
					`phrase ${named} is attested against base ${JSON.stringify(attestation.base)}, which the lexicon does not declare`,
				]
			}

			const problems: string[] = []

			if (base.attestation.kind === "derived-form") {
				problems.push(
					`phrase ${named} is derived from ${JSON.stringify(attestation.base)}, which is itself derived — an attestation chain that never reaches a committed record attests nothing`
				)
			}

			if (base.activity !== entry.activity) {
				problems.push(
					`phrase ${named} names activity ${JSON.stringify(entry.activity)} while its base names ${JSON.stringify(base.activity)}`
				)
			}

			if (attestation.kind === "derived-form") {
				if (!DERIVATIONS.includes(attestation.derivation)) {
					problems.push(
						`phrase ${named} declares derivation ${JSON.stringify(attestation.derivation)}, which is not a known one`
					)
				}

				if (JSON.stringify(entry.locales ?? null) !== JSON.stringify(base.locales ?? null)) {
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
 * The committed read is memoized; an explicit path is read fresh, which is what a test asserting a refusal needs.
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
