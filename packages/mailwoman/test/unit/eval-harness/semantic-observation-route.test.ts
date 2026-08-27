/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Tests for the one semantic observation route the utility probe injects (#1929): the phrase rule, the
 *   locale scope, the authority an observation carries, and every construction refusal.
 *
 *   No model, no database, no pipeline. The route is a `POIPhraseLookup` over a compiled artifact and a
 *   reviewed lexicon, and both are injectable — so the refusals are exercised against synthetic
 *   models rather than by breaking the committed ones.
 *
 *   The committed pair is asserted too, and that is the check with the shortest half-life: a declared
 *   phrase whose activity nothing affords would match a query and answer nothing, which reads at the
 *   probe as the class being unanswerable rather than as the route being unwired.
 */

import type { ActivityPhraseEntry, ActivityPhraseLexicon } from "@mailwoman/activity-lexicon"
import { readActivityLexicon } from "@mailwoman/activity-lexicon"
import type { CompiledGeographicModel } from "@mailwoman/geographic-model"
import { createSemanticObservationRoute } from "mailwoman/eval-harness/semantic-utility/observation-route"
import { describe, expect, it } from "vitest"

const committedLexicon = readActivityLexicon()
const committedRoute = await createSemanticObservationRoute()
const committedModel = await readCommittedModel()

/**
 * The committed artifact, read the way the route reads it.
 */
async function readCommittedModel(): Promise<CompiledGeographicModel> {
	const { readCompiledGeographicModel } = await import("@mailwoman/geographic-model/scripts/build-artifact")

	return readCompiledGeographicModel()
}

/**
 * A well-formed synthetic entry, so a test provoking ONE refusal does not trip a different one on the way.
 */
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

/**
 * A route over a mutated copy of the committed pair, so a refusal is provoked without touching either committed file.
 */
async function scratchRoute(
	mutate: (model: CompiledGeographicModel, lexicon: ActivityPhraseLexicon) => void
): Promise<ReturnType<typeof createSemanticObservationRoute>> {
	const model = structuredClone(committedModel)
	const lexicon = structuredClone(committedLexicon)

	mutate(model, lexicon)

	return createSemanticObservationRoute({ model, lexicon })
}

describe("the committed lexicon against the committed artifact", () => {
	it("resolves — every declared phrase reaches a mapped entity kind", async () => {
		await expect(createSemanticObservationRoute()).resolves.toBeDefined()
	})

	it("reaches exactly the POI category the frozen slice maps", () => {
		expect(committedRoute.identity.reachableCategoryIDs).toEqual(["pharmacy"])
	})

	it("reports what it was built from, so a receipt never has to name it twice", () => {
		expect(committedRoute.identity.phraseLexiconID).toBe(committedLexicon.lexiconID)
		expect(committedRoute.identity.phraseLexiconVersion).toBe(committedLexicon.version)
		expect(committedRoute.identity.declaredPhrases).toBe(committedLexicon.phrases.length)
		expect(committedRoute.identity.modelVersion).toBe(committedModel.modelVersion)
	})

	it("marks its phrases curated and names a record behind each one", () => {
		expect(committedLexicon.provenance.source).toBe("mailwoman-curated")
		expect(committedLexicon.provenance.notes).toBeTruthy()

		for (const declared of committedLexicon.phrases) {
			expect(declared.source).toBe("curated")
			expect(declared.note.trim()).not.toBe("")
			expect(declared.attestation.kind).toBeTruthy()
		}
	})

	it("declares phrases no registered target row uses, so the lexicon is about the activity", () => {
		const registered = new Set([
			"pick up a prescription",
			"prescription",
			"fill a prescription",
			"prescription refilled",
		])

		const beyond = committedLexicon.phrases.filter((declared) => !registered.has(declared.phrase))

		expect(beyond.length).toBeGreaterThan(0)
	})
})

describe("the phrase rule", () => {
	it("claims a candidate that ends in a declared phrase", () => {
		expect(committedRoute.lookup("where can i pick up a prescription")).toEqual([
			{ kind: "category", categoryID: "pharmacy", matchedPhrase: "pick up a prescription", confidence: 1 },
		])
	})

	it("claims a candidate that IS a declared phrase", () => {
		expect(committedRoute.lookup("prescription")).toHaveLength(1)
	})

	it("refuses the same query with its anchor still attached, which is what keeps the anchor split intact", () => {
		expect(committedRoute.lookup("where can i pick up a prescription near Denver CO")).toEqual([])
		expect(committedRoute.lookup("prescription near Denver CO")).toEqual([])
	})

	it("takes the longest declared phrase when several end the candidate", () => {
		const [hit] = committedRoute.lookup("somewhere to fill a prescription")

		expect(hit?.matchedPhrase).toBe("fill a prescription")
	})

	it("requires a word boundary — a longer word ending in a declared phrase is not that phrase", async () => {
		const route = await scratchRoute((_model, lexicon) => {
			lexicon.phrases = [entry({ phrase: "medication" })]
		})

		expect(route.lookup("premedication")).toEqual([])
		expect(route.lookup("my medication")).toHaveLength(1)
	})

	it("returns nothing for every control subject the committed lexicon already answers", () => {
		for (const phrase of ["pharmacy", "er", "bank", "hospital", "somewhere"]) {
			expect(committedRoute.lookup(phrase)).toEqual([])
		}
	})

	it("normalizes case and whitespace without consulting the host locale", () => {
		expect(committedRoute.lookup("  WHERE CAN I   Pick Up A Prescription  ")).toHaveLength(1)
	})
})

describe("the locale scope", () => {
	it("answers a scoped phrase at full strength under a locale it declares", () => {
		const [hit] = committedRoute.lookup("collect a prescription", "en-GB")

		expect(hit?.confidence).toBe(1)
	})

	it("answers a scoped phrase at half strength when only the language agrees", () => {
		const [hit] = committedRoute.lookup("collect my prescription", "en-IE")

		expect(hit?.confidence).toBe(0.5)
	})

	it("stays silent on a scoped phrase under an unrelated locale", async () => {
		const route = await scratchRoute((_model, lexicon) => {
			lexicon.phrases = [entry({ phrase: "collect a prescription", locales: ["en-GB"] })]
		})

		expect(route.lookup("collect a prescription", "fr-FR")).toEqual([])
	})

	it("stays silent on a scoped phrase when the locale is unknown", async () => {
		const route = await scratchRoute((_model, lexicon) => {
			lexicon.phrases = [entry({ phrase: "collect a prescription", locales: ["en-GB"] })]
		})

		expect(route.lookup("collect a prescription")).toEqual([])
	})

	it("leaves an unscoped phrase answering under every locale, and under none", () => {
		expect(committedRoute.lookup("prescription", "fr-FR")).toHaveLength(1)
		expect(committedRoute.lookup("prescription")).toHaveLength(1)
	})

	it("falls through to the unscoped phrase the candidate also ends in, rather than going silent", () => {
		const [hit] = committedRoute.lookup("collect a prescription", "fr-FR")

		expect(hit?.matchedPhrase).toBe("prescription")
	})

	it("lets a shorter admissible phrase answer where a longer scoped one is refused", async () => {
		const route = await scratchRoute((_model, lexicon) => {
			lexicon.phrases = [
				entry({ phrase: "prescription" }),
				entry({ phrase: "collect a prescription", locales: ["en-GB"] }),
			]
		})

		const [hit] = route.lookup("collect a prescription", "fr-FR")

		expect(hit?.matchedPhrase).toBe("prescription")
	})
})

describe("the observation", () => {
	it("carries the assertion the category was chosen on, with its modality and provenance", () => {
		committedRoute.takeObservations()
		committedRoute.lookup("where can i pick up a prescription")

		const [observation] = committedRoute.takeObservations()

		expect(observation).toBeDefined()
		expect(observation!.activity).toBe("obtain_medication")
		expect(observation!.concept).toBe("pharmacy")
		expect(observation!.categoryID).toBe("pharmacy")
		expect(observation!.assertion.id).toBe("pharmacy-affords-obtain-medication")
		expect(observation!.assertion.relation).toBe("affords")
		expect(observation!.assertion.modality).toBe("necessary")
		expect(observation!.assertion.provenance.source).toBe("mailwoman-curated")
		expect(observation!.mapping.vocabulary).toBe("poi-taxonomy")
		expect(observation!.mapping.provenance.source).toBe("mailwoman-curated")
		expect(observation!.phraseProvenance.source).toBe("mailwoman-curated")
		expect(observation!.mappedKindCount).toBe(1)
	})

	it("names what attests the surface form, which the assertion's own provenance does not cover", () => {
		committedRoute.takeObservations()
		committedRoute.lookup("where can i pick up a prescription")

		const [observation] = committedRoute.takeObservations()

		expect(observation!.phraseLexiconID).toBe(committedLexicon.lexiconID)
		expect(observation!.phraseAttestation.kind).toBe("committed-query")
		expect(observation!.phraseAttestation.reference).toContain("poi-board.jsonl#sem-act-us-01")
	})

	it("records which scope admitted the phrase, so a receipt can tell an exact locale from a relaxed one", () => {
		committedRoute.takeObservations()
		committedRoute.lookup("collect a prescription", "en-AU")

		const [scoped] = committedRoute.takeObservations()

		expect(scoped!.localeScope).toBe("exact")
		expect(scoped!.declaredLocales).toEqual(["en-GB", "en-AU", "en-NZ"])

		committedRoute.lookup("prescription", "en-AU")

		const [unscoped] = committedRoute.takeObservations()

		expect(unscoped!.localeScope).toBe("unscoped")
		expect(unscoped!.declaredLocales).toBeNull()
	})

	it("deduplicates a drain — one query drives the rung several times", () => {
		committedRoute.takeObservations()
		committedRoute.lookup("prescription")
		committedRoute.lookup("prescription")
		committedRoute.lookup("prescription")

		expect(committedRoute.takeObservations()).toHaveLength(1)
	})

	it("drains, so an observation is addressed to the row it happened on", () => {
		committedRoute.takeObservations()
		committedRoute.lookup("prescription")

		expect(committedRoute.takeObservations()).toHaveLength(1)
		expect(committedRoute.takeObservations()).toEqual([])
	})

	it("records nothing for a phrase it refused", () => {
		committedRoute.takeObservations()
		committedRoute.lookup("pharmacy near Denver CO")

		expect(committedRoute.takeObservations()).toEqual([])
	})
})

describe("construction refusals", () => {
	it("refuses an activity the artifact does not carry", async () => {
		await expect(
			scratchRoute((_model, lexicon) => {
				lexicon.phrases = [entry({ phrase: "get a haircut", activity: "get_haircut" })]
			})
		).rejects.toThrow(/which the compiled model does not carry/)
	})

	it("refuses a concept that is not an activity", async () => {
		await expect(
			scratchRoute((_model, lexicon) => {
				lexicon.phrases = [entry({ phrase: "prescription", activity: "pharmacy" })]
			})
		).rejects.toThrow(/concept kind is "establishment" rather than `activity`/)
	})

	it("refuses an activity nothing affords — the phrase would match and answer nothing", async () => {
		await expect(
			scratchRoute((model) => {
				for (const concept of model.concepts) {
					concept.assertions = []
				}
			})
		).rejects.toThrow(/no concept both affords and maps into/)
	})

	it("refuses an activity whose affording kind maps into no POI category", async () => {
		await expect(
			scratchRoute((model) => {
				model.mappings = []
			})
		).rejects.toThrow(/no concept both affords and maps into/)
	})

	it("refuses an artifact that defines no `affords` relation", async () => {
		await expect(
			scratchRoute((model) => {
				model.relations = []
			})
		).rejects.toThrow(/defines no `affords` relation/)
	})

	it("refuses a phrase declared twice", async () => {
		await expect(
			scratchRoute((_model, lexicon) => {
				lexicon.phrases = [entry({ phrase: "prescription" }), entry({ phrase: "  Prescription " })]
			})
		).rejects.toThrow(/is declared twice/)
	})

	it("refuses an empty lexicon", async () => {
		await expect(
			scratchRoute((_model, lexicon) => {
				lexicon.phrases = []
			})
		).rejects.toThrow(/a vocabulary with no surface form can never fire/)
	})

	it("refuses a phrase that normalizes to nothing", async () => {
		await expect(
			scratchRoute((_model, lexicon) => {
				lexicon.phrases = [entry({ phrase: "   " })]
			})
		).rejects.toThrow(/normalizes to nothing/)
	})

	it("refuses a phrase scoped to no locale at all", async () => {
		await expect(
			scratchRoute((_model, lexicon) => {
				lexicon.phrases = [entry({ phrase: "prescription", locales: [] })]
			})
		).rejects.toThrow(/scoped to nowhere/)
	})

	it("refuses a derived form whose base the lexicon does not declare", async () => {
		await expect(
			scratchRoute((_model, lexicon) => {
				lexicon.phrases = [
					entry({
						phrase: "prescriptions",
						attestation: { kind: "derived-form", base: "prescription", derivation: "plural" },
					}),
				]
			})
		).rejects.toThrow(/which the lexicon does not declare/)
	})
})
