/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Tests for the reviewed activity-phrase lexicon: the committed file, the locale semantics it borrows from
 *   `@mailwoman/variant-aliases`, and every refusal the audit makes.
 *
 *   The refusals are what the tests spend most of their length on, because each one describes a lexicon that
 *   would answer fewer queries than it appears to declare — and a consumer measuring recognition breadth
 *   against it would read the shortfall as the world rather than as the file.
 */

import type { ActivityPhraseEntry, ActivityPhraseLexicon } from "@mailwoman/activity-lexicon"
import {
	auditActivityLexicon,
	normalizeActivityPhrase,
	readActivityLexicon,
	resolveActivityPhraseLocale,
} from "@mailwoman/activity-lexicon/lexicon"
import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { removePathIfPresent, writeLocalJSONFile } from "@mailwoman/core/fs/writers"
import { resolvePath } from "path-ts"
import { describe, expect, it } from "vitest"

const committed = await readActivityLexicon()

function entry(overrides: Partial<ActivityPhraseEntry> & Pick<ActivityPhraseEntry, "phrase">): ActivityPhraseEntry {
	const activity = overrides.activity ?? "obtain_medication"

	return {
		activity,
		source: "curated",
		attestation: { kind: "concept-description", reference: activity, detail: "obtaining medication" },
		note: "test",
		...overrides,
	}
}

function lexicon(phrases: ActivityPhraseEntry[]): ActivityPhraseLexicon {
	return {
		lexiconID: "test",
		version: "0.0.0",
		provenance: { source: "mailwoman-curated" },
		phrases,
	}
}

describe("the committed lexicon", () => {
	it("audits clean", () => {
		expect(auditActivityLexicon(committed)).toEqual([])
	})

	it("declares every entry curated, attested and noted", () => {
		expect(committed.phrases.length).toBeGreaterThan(0)

		for (const declared of committed.phrases) {
			expect(declared.source).toBe("curated")
			expect(declared.note.trim()).not.toBe("")
			expect(declared.attestation.kind).toBeTruthy()
		}
	})

	it("rests every attestation chain on a record outside the lexicon", () => {
		const byPhrase = new Map(committed.phrases.map((declared) => [normalizeActivityPhrase(declared.phrase), declared]))

		for (const declared of committed.phrases) {
			if (declared.attestation.kind !== "derived-form") continue

			const base = byPhrase.get(normalizeActivityPhrase(declared.attestation.base))

			expect(base).toBeDefined()
			expect(base!.attestation.kind).not.toBe("derived-form")
		}
	})
})

describe("normalization", () => {
	it("folds case, width and whitespace", () => {
		expect(normalizeActivityPhrase("  Pick   Up A  PRESCRIPTION ")).toBe("pick up a prescription")
		expect(normalizeActivityPhrase("ＰＲＥＳＣＲＩＰＴＩＯＮ")).toBe("prescription")
	})
})

describe("the locale scope", () => {
	const scoped = entry({ phrase: "collect a prescription", locales: ["en-GB", "en-AU"] })
	const unscoped = entry({ phrase: "prescription" })

	it("answers an unscoped entry under any locale, and under none", () => {
		expect(resolveActivityPhraseLocale(unscoped, "fr-FR")).toEqual({ scope: "unscoped", confidence: 1 })
		expect(resolveActivityPhraseLocale(unscoped, undefined)).toEqual({ scope: "unscoped", confidence: 1 })
	})

	it("answers a scoped entry at full strength on an exact tag", () => {
		expect(resolveActivityPhraseLocale(scoped, "en-AU")).toEqual({ scope: "exact", confidence: 1 })
	})

	it("answers a scoped entry at half strength when only the language agrees", () => {
		expect(resolveActivityPhraseLocale(scoped, "en-IE")).toEqual({ scope: "language", confidence: 0.5 })
	})

	it("refuses a scoped entry under an unrelated locale", () => {
		expect(resolveActivityPhraseLocale(scoped, "fr-FR")).toBeNull()
	})

	it("refuses a scoped entry when the locale is unknown", () => {
		expect(resolveActivityPhraseLocale(scoped, undefined)).toBeNull()
	})
})

describe("the audit", () => {
	it("refuses an empty lexicon", () => {
		expect(auditActivityLexicon(lexicon([])).join("\n")).toMatch(/a vocabulary with no surface form can never fire/)
	})

	it("refuses a phrase declared twice", () => {
		const problems = auditActivityLexicon(
			lexicon([entry({ phrase: "prescription" }), entry({ phrase: " Prescription " })])
		)

		expect(problems.join("\n")).toMatch(/is declared twice/)
	})

	it("refuses a phrase that normalizes to nothing", () => {
		expect(auditActivityLexicon(lexicon([entry({ phrase: "   " })])).join("\n")).toMatch(/normalizes to nothing/)
	})

	it("refuses an entry scoped to no locale at all", () => {
		expect(auditActivityLexicon(lexicon([entry({ phrase: "x", locales: [] })])).join("\n")).toMatch(/scoped to nowhere/)
	})

	it("refuses an entry with no note", () => {
		expect(auditActivityLexicon(lexicon([entry({ phrase: "x", note: " " })])).join("\n")).toMatch(/carries no note/)
	})

	it("refuses a committed-query citation that does not contain the phrase", () => {
		const problems = auditActivityLexicon(
			lexicon([
				entry({
					phrase: "prescription",
					attestation: { kind: "committed-query", reference: "board#row", detail: "pharmacy near Denver CO" },
				}),
			])
		)

		expect(problems.join("\n")).toMatch(/does not contain it as a subject/)
	})

	it("refuses a concept-description citation of a concept the entry does not name", () => {
		const problems = auditActivityLexicon(
			lexicon([
				entry({
					phrase: "prescription",
					attestation: { kind: "concept-description", reference: "get_haircut", detail: "cutting hair" },
				}),
			])
		)

		expect(problems.join("\n")).toMatch(/while naming activity/)
	})

	it("refuses a derived form whose base is absent", () => {
		const problems = auditActivityLexicon(
			lexicon([
				entry({
					phrase: "prescriptions",
					attestation: { kind: "derived-form", base: "prescription", derivation: "plural" },
				}),
			])
		)

		expect(problems.join("\n")).toMatch(/which the lexicon does not declare/)
	})

	it("refuses an attestation chain that never reaches a record outside the lexicon", () => {
		const problems = auditActivityLexicon(
			lexicon([
				entry({
					phrase: "prescription",
					attestation: { kind: "derived-form", base: "prescriptions", derivation: "plural" },
				}),
				entry({
					phrase: "prescriptions",
					attestation: { kind: "derived-form", base: "prescription", derivation: "plural" },
				}),
			])
		)

		expect(problems.join("\n")).toMatch(/is itself derived/)
	})

	it("refuses a derived form that moves its base's locale scope", () => {
		const problems = auditActivityLexicon(
			lexicon([
				entry({ phrase: "collect a prescription", locales: ["en-GB"] }),
				entry({
					phrase: "collect my prescription",
					locales: ["en-US"],
					attestation: { kind: "derived-form", base: "collect a prescription", derivation: "possessive" },
				}),
			])
		)

		expect(problems.join("\n")).toMatch(/locale scope differs from its base/)
	})

	it("refuses an entry whose activity disagrees with its base", () => {
		const problems = auditActivityLexicon(
			lexicon([
				entry({ phrase: "prescription" }),
				entry({
					phrase: "prescriptions",
					activity: "get_haircut",
					attestation: { kind: "derived-form", base: "prescription", derivation: "plural" },
				}),
			])
		)

		expect(problems.join("\n")).toMatch(/while its base names/)
	})
})

describe("the reader", () => {
	it("throws rather than serving a lexicon the audit rejects", async () => {
		await using directoryDirectory = await temporaryDirectory("activity-lexicon-")

		const directory = directoryDirectory.path
		const path = resolvePath(directory, "activity-lexicon.json")

		await writeLocalJSONFile(lexicon([entry({ phrase: "x" }), entry({ phrase: "X" })]), path)

		await expect(readActivityLexicon(path)).rejects.toThrow(/is declared twice/)

		await removePathIfPresent(directory)
	})
})
