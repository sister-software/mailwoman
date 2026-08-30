/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Tests for the semantic observation route: the phrase rule, the locale scope, the assertion's country
 *   scope, the plural affordance, the authority an observation carries, and every construction refusal.
 *
 *   No model, no database, no pipeline. The route is a `POIPhraseLookup` over a compiled artifact and a
 *   reviewed lexicon, and both are injectable — so the refusals are exercised against synthetic
 *   models rather than by breaking the committed ones.
 *
 *   The committed pair is asserted too, and that is the check with the shortest half-life: a declared
 *   phrase whose activity nothing affords would match a query and answer nothing, which reads at the
 *   probe as the class being unanswerable rather than as the route being unwired.
 *
 *   THE WAVE-1 PLURAL CASE IS FULLY COMMITTED. The `drugstore` concept, its US-scoped assertion and its
 *   `poi-taxonomy` mapping are all in the artifact, so `obtain_medication` reaches two mapped kinds and the
 *   route returns both — the case that used to refuse at construction is now the committed behaviour, and
 *   it is asserted against the real records rather than against a clone of them.
 *
 *   {@linkcode withAffordingKind} stays for the shapes the committed set cannot express: a class sorting
 *   AFTER `pharmacy`, because a set whose members are returned in code-point order has to be shown to be
 *   returned whole from both sides of that order, and a second activity nobody carries yet.
 */

import type { ActivityPhraseEntry, ActivityPhraseLexicon } from "@mailwoman/activity-lexicon"
import { readActivityLexicon } from "@mailwoman/activity-lexicon"
import type { CompiledGeographicModel, RelationAssertion } from "@mailwoman/geographic-model"
import { Modality } from "@mailwoman/geographic-model"
import type { POIPhraseLookup } from "@mailwoman/kind-classifier"
import { matchPOISubject } from "@mailwoman/kind-classifier"
import { createSemanticObservationRoute } from "mailwoman/observations"
import { describe, expect, it } from "vitest"

const committedLexicon = readActivityLexicon()
const committedRoute = await createSemanticObservationRoute()
const committedModel = await readCommittedModel()

/**
 * The committed artifact, read the way the route reads it.
 */
async function readCommittedModel(): Promise<CompiledGeographicModel> {
	const { readCompiledGeographicModel } = await import("@mailwoman/geographic-model/scripts/build-artifact")

	return await readCompiledGeographicModel()
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

	return await createSemanticObservationRoute({ model, lexicon })
}

/**
 * The compiled records carry branded identifiers, so a synthetic id enters a scratch model through one cast rather than
 * through a re-declared shape that would stop matching the schema the moment it grew a field.
 */
function brand<Branded>(value: string): Branded {
	return value as Branded
}

/**
 * One synthetic establishment class affording an activity, mapped into `poi-taxonomy` under its own external id, with
 * the assertion's country scope as the caller states it. A `see_a_doctor`-style activity nobody carries yet is cloned
 * from the committed one.
 *
 * Used only for the shapes the committed records cannot express. The set is enumerated in code-point order over concept
 * ids, so a class sorting BEFORE `pharmacy` and one sorting after are the two sides of the same question — whether the
 * whole set comes back or only its head. The committed `drugstore` covers the first side, and a synthetic
 * `retail_pharmacy` is what covers the second.
 */
function withAffordingKind(conceptID: string, options: { activity?: string; countries?: string[] } = {}) {
	const activity = options.activity ?? "obtain_medication"

	return (model: CompiledGeographicModel): void => {
		const pharmacy = model.concepts.find((concept) => String(concept.id) === "pharmacy")!
		const added = structuredClone(pharmacy)
		const assertion = added.assertions[0]!
		const mapping = structuredClone(model.mappings[0]!)

		assertion.id = brand(`${conceptID}-affords-${activity}`)
		assertion.target = brand(activity)
		assertion.modality = Modality.StronglyExpected

		if (options.countries) {
			assertion.countries = options.countries
		}

		added.id = brand(conceptID)
		added.label = conceptID
		added.isA = [brand("establishment")]

		mapping.id = brand(`poi-taxonomy-${conceptID}`)
		mapping.concept = brand(conceptID)
		mapping.externalID = brand(conceptID)

		model.concepts = [...model.concepts, added]
		model.mappings = [...model.mappings, mapping]

		if (activity === "obtain_medication") return

		const cloned = structuredClone(model.concepts.find((concept) => String(concept.id) === "obtain_medication")!)

		cloned.id = brand(activity)
		cloned.label = activity

		model.concepts = [...model.concepts, cloned]
	}
}

/**
 * Take the country scope off the committed `drugstore` assertion, so the plural case can be run with the claim scoped
 * to nowhere in particular as well as to the US.
 */
function withoutDrugstoreCountryScope(model: CompiledGeographicModel): void {
	model.concepts = model.concepts.map((concept) =>
		String(concept.id) === "drugstore" ? { ...concept, assertions: concept.assertions.map(unscopedAssertion) } : concept
	)
}

function unscopedAssertion({ countries: _scoped, ...rest }: RelationAssertion): RelationAssertion {
	return rest
}

/**
 * Take the committed `pharmacy` assertion away, so a scratch model's added class is the only thing affording the
 * activity and the plural refusal does not stand in front of what the test is measuring.
 */
function withoutPharmacyAffordance(model: CompiledGeographicModel): void {
	model.concepts = model.concepts.map((concept) =>
		String(concept.id) === "pharmacy" ? { ...concept, assertions: [] } : concept
	)
}

describe("the committed lexicon against the committed artifact", () => {
	it("resolves — every declared phrase reaches a mapped entity kind", async () => {
		await expect(await createSemanticObservationRoute()).resolves.toBeDefined()
	})

	// Both wave-1 kinds, in code-point order. The identity enumerates what the declared activities CAN reach through
	// the artifact, before any country scope is applied — a receipt that named only the kind a given query admitted
	// could not tell a scope refusing a class from an artifact never carrying it.
	it("reaches both POI categories wave 1 maps", () => {
		expect(committedRoute.identity.reachableCategoryIDs).toEqual(["drugstore", "pharmacy"])
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
	// No locale, so the US-scoped drugstore assertion is not admitted and the set is `pharmacy` alone. `searchAsSet` is
	// on it anyway: it says what the array MEANS, not how long it happens to be, and a caller that read it as a length
	// signal would narrow the moment a second kind arrived.
	it("claims a candidate that ends in a declared phrase", () => {
		expect(committedRoute.lookup("where can i pick up a prescription")).toEqual([
			{
				kind: "category",
				categoryID: "pharmacy",
				matchedPhrase: "pick up a prescription",
				confidence: 1,
				searchAsSet: true,
			},
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

describe("a plural affordance", () => {
	// The committed records, at the locale that admits both: `drugstore` sorts before `pharmacy` on `d` preceding `p`,
	// and BOTH come back. Narrowing to the head would hand the query the class reaching 6,679 US rows and drop the one
	// reaching 44,945, on a sort key nobody authored as a preference.
	it("returns every mapped kind the activity reaches, in concept code-point order", () => {
		expect(committedRoute.lookup("prescription", "en-US")).toEqual([
			{ kind: "category", categoryID: "drugstore", matchedPhrase: "prescription", confidence: 1, searchAsSet: true },
			{ kind: "category", categoryID: "pharmacy", matchedPhrase: "prescription", confidence: 1, searchAsSet: true },
		])
	})

	// Every member carries the same confidence, so nothing in the set can be ranked off the value the query surface
	// reads. The number selects a query KIND; it orders no candidate.
	it("gives every member of the set the same confidence", () => {
		const confidences = new Set(committedRoute.lookup("prescription", "en-US").map((hit) => hit.confidence))

		expect(confidences).toEqual(new Set([1]))
	})

	// The losing order, run because a set that only survives when the new class sorts first is not a set: it is the
	// head with the other winner, and reading `hits[0]` would take `pharmacy` here and report nothing wrong.
	it("returns the whole set when the added class sorts last", async () => {
		const route = await scratchRoute(withAffordingKind("retail_pharmacy", { countries: ["US"] }))

		expect(route.lookup("prescription", "en-US").map((hit) => hit.categoryID)).toEqual([
			"drugstore",
			"pharmacy",
			"retail_pharmacy",
		])
	})

	// The set reaching the query surface, measured where the narrowing used to happen rather than argued: two matches go
	// in, `matchPOISubject` carries both, and the POI branch searches their union.
	it("carries the whole set through the query surface", () => {
		const plural: ReturnType<POIPhraseLookup> = [
			{ kind: "category", categoryID: "drugstore", matchedPhrase: "prescription", confidence: 1, searchAsSet: true },
			{ kind: "category", categoryID: "pharmacy", matchedPhrase: "prescription", confidence: 1, searchAsSet: true },
		]

		const matched = matchPOISubject("prescription near Denver CO", "en-US", (phrase) =>
			phrase === "prescription" ? plural : []
		)

		expect(matched?.matches.map((hit) => hit.categoryID)).toEqual(["drugstore", "pharmacy"])
		expect(matched?.remainder).toBe("Denver CO")
	})

	// The committed route driven through the surface that used to narrow, at both locales. France reaches one category
	// because the drugstore assertion is scoped to the US and the layer holds zero drugstore rows there; the US reaches
	// two, and the POI branch searches both.
	it("reaches the query surface as one category in France and two in the US", () => {
		const fr = matchPOISubject("prescription near Toulouse", "fr-FR", committedRoute.lookup)
		const us = matchPOISubject("prescription near Denver CO", "en-US", committedRoute.lookup)

		expect(fr?.matches.map((hit) => hit.categoryID)).toEqual(["pharmacy"])
		expect(us?.matches.map((hit) => hit.categoryID)).toEqual(["drugstore", "pharmacy"])
	})

	// One observation per member, each naming its OWN assertion and mapping. Folding them into one would lose which
	// authority put which class in the set, and every one of them reports the size of the set it belongs to.
	it("records one observation per member, each with its own authority", () => {
		committedRoute.takeObservations()
		committedRoute.lookup("prescription", "en-US")

		const observations = committedRoute.takeObservations()

		expect(observations.map((observation) => observation.concept)).toEqual(["drugstore", "pharmacy"])

		expect(observations.map((observation) => observation.assertion.id)).toEqual([
			"drugstore-affords-obtain-medication",
			"pharmacy-affords-obtain-medication",
		])

		expect(observations.map((observation) => observation.mappedKindCount)).toEqual([2, 2])
	})

	// The scope narrows the SET, which is the one narrowing that is a reading of the records rather than of a sort key:
	// the committed drugstore assertion is US-scoped, so France reaches `pharmacy` alone and the observation says so.
	// Strip the scope off and France reaches both, which is what says the scope did the work.
	it("narrows the set by the assertion's country scope, and by nothing else", async () => {
		expect(committedRoute.lookup("prescription", "fr-FR").map((hit) => hit.categoryID)).toEqual(["pharmacy"])

		committedRoute.takeObservations()
		committedRoute.lookup("prescription", "fr-FR")

		expect(committedRoute.takeObservations().map((observation) => observation.mappedKindCount)).toEqual([1])

		const unscoped = await scratchRoute(withoutDrugstoreCountryScope)

		expect(unscoped.lookup("prescription", "fr-FR").map((hit) => hit.categoryID)).toEqual(["drugstore", "pharmacy"])
	})
})

describe("the assertion's country scope", () => {
	/**
	 * The COMMITTED US-scoped assertion, alone in the set: the unscoped pharmacy affordance is taken away, so `drugstore`
	 * is the only mapped kind affording the activity and a scope refusing it empties the answer rather than shortening
	 * it. That is what makes silence readable here — with `pharmacy` still in the set, every one of these queries would
	 * answer something and the scope's effect would be a length.
	 *
	 * Nothing about the scope itself is synthetic — `countries: ["US"]` is the value the artifact carries, so a curator
	 * who widened or dropped it would move these tests rather than leave them agreeing with a clone.
	 */
	async function usScopedRoute(): Promise<ReturnType<typeof createSemanticObservationRoute>> {
		return await scratchRoute((model, lexicon) => {
			withoutPharmacyAffordance(model)

			lexicon.phrases = [entry({ phrase: "prescription" })]
		})
	}

	it("reads the scope off the committed record rather than off a clone of it", async () => {
		const model = await readCommittedModel()
		const drugstore = model.concepts.find((concept) => String(concept.id) === "drugstore")

		expect(drugstore?.assertions[0]?.countries).toEqual(["US"])
	})

	it("answers under a locale whose region the assertion names", async () => {
		const route = await usScopedRoute()

		expect(route.lookup("prescription", "en-US")).toEqual([
			{ kind: "category", categoryID: "drugstore", matchedPhrase: "prescription", confidence: 1, searchAsSet: true },
		])
	})

	// The measured half of the defect: the layer holds zero `drugstore` rows in France, so a US-scoped claim firing at
	// Toulouse would answer a French query with a category the data there cannot serve.
	it("stays silent at Toulouse, where the assertion's scope does not reach", async () => {
		const route = await usScopedRoute()

		expect(route.lookup("prescription", "fr-FR")).toEqual([])
		expect(route.takeObservations()).toEqual([])
	})

	it("stays silent when the locale names no region at all", async () => {
		const route = await usScopedRoute()

		expect(route.lookup("prescription", "en")).toEqual([])
		expect(route.lookup("prescription")).toEqual([])
	})

	// The committed pharmacy assertion is unscoped, so it is in the set under both locales. The US-scoped drugstore
	// assertion joins it only where the locale names the US, which is the whole difference between the two lengths.
	it("leaves an unscoped assertion answering everywhere, including at Toulouse", () => {
		expect(committedRoute.lookup("prescription", "fr-FR").map((hit) => hit.categoryID)).toEqual(["pharmacy"])

		expect(committedRoute.lookup("prescription", "en-US").map((hit) => hit.categoryID)).toEqual([
			"drugstore",
			"pharmacy",
		])
	})

	it("records the scope and the country it met, so a receipt can be checked", async () => {
		const route = await usScopedRoute()

		route.lookup("prescription", "en-US")

		const [observation] = route.takeObservations()

		expect(observation!.assertion.countries).toEqual(["US"])
		expect(observation!.localeCountry).toBe("US")
		expect(observation!.assertion.modality).toBe("strongly_expected")
	})

	// Two members, and each observation states its OWN scope: the drugstore one names the list it is scoped to, the
	// pharmacy one carries `null` rather than an empty list. Read off one observation alone the distinction would be
	// invisible, which is why both are asserted from the same firing.
	it("carries null for an unscoped assertion rather than an empty list", () => {
		committedRoute.takeObservations()
		committedRoute.lookup("prescription", "en-US")

		const byConcept = new Map(
			committedRoute.takeObservations().map((observation) => [observation.concept, observation])
		)

		expect(byConcept.get("drugstore")!.assertion.countries).toEqual(["US"])
		expect(byConcept.get("pharmacy")!.assertion.countries).toBeNull()
		expect(byConcept.get("pharmacy")!.localeCountry).toBe("US")
	})

	// The country check sits INSIDE the phrase search for the same reason the locale check does: a longer phrase whose
	// assertion the country refuses must not stand in front of a shorter one whose assertion admits it, or one scope
	// would silence a phrase it does not cover.
	it("lets a shorter phrase answer where the longer one's assertion is out of scope", async () => {
		const route = await scratchRoute((model, lexicon) => {
			withAffordingKind("walk_in_clinic", { activity: "see_a_doctor" })(model)
			withoutPharmacyAffordance(model)

			lexicon.phrases = [
				entry({ phrase: "prescription", activity: "see_a_doctor" }),
				entry({ phrase: "collect a prescription", activity: "obtain_medication" }),
			]
		})

		expect(route.lookup("collect a prescription", "en-US")).toEqual([
			{
				kind: "category",
				categoryID: "drugstore",
				matchedPhrase: "collect a prescription",
				confidence: 1,
				searchAsSet: true,
			},
		])

		expect(route.lookup("collect a prescription", "fr-FR")).toEqual([
			{
				kind: "category",
				categoryID: "walk_in_clinic",
				matchedPhrase: "prescription",
				confidence: 1,
				searchAsSet: true,
			},
		])
	})
})

describe("construction refusals", () => {
	it("refuses an activity the artifact does not carry", async () => {
		await expect(
			await scratchRoute((_model, lexicon) => {
				lexicon.phrases = [entry({ phrase: "get a haircut", activity: "get_haircut" })]
			})
		).rejects.toThrow(/which the compiled model does not carry/)
	})

	it("refuses a concept that is not an activity", async () => {
		await expect(
			await scratchRoute((_model, lexicon) => {
				lexicon.phrases = [entry({ phrase: "prescription", activity: "pharmacy" })]
			})
		).rejects.toThrow(/concept kind is "establishment" rather than `activity`/)
	})

	it("refuses an activity nothing affords — the phrase would match and answer nothing", async () => {
		await expect(
			await scratchRoute((model) => {
				for (const concept of model.concepts) {
					concept.assertions = []
				}
			})
		).rejects.toThrow(/no concept both affords and maps into/)
	})

	it("refuses an activity whose affording kind maps into no POI category", async () => {
		await expect(
			await scratchRoute((model) => {
				model.mappings = []
			})
		).rejects.toThrow(/no concept both affords and maps into/)
	})

	it("refuses an artifact that defines no `affords` relation", async () => {
		await expect(
			await scratchRoute((model) => {
				model.relations = []
			})
		).rejects.toThrow(/defines no `affords` relation/)
	})

	it("refuses a phrase declared twice", async () => {
		await expect(
			await scratchRoute((_model, lexicon) => {
				lexicon.phrases = [entry({ phrase: "prescription" }), entry({ phrase: "  Prescription " })]
			})
		).rejects.toThrow(/is declared twice/)
	})

	it("refuses an empty lexicon", async () => {
		await expect(
			await scratchRoute((_model, lexicon) => {
				lexicon.phrases = []
			})
		).rejects.toThrow(/a vocabulary with no surface form can never fire/)
	})

	it("refuses a phrase that normalizes to nothing", async () => {
		await expect(
			await scratchRoute((_model, lexicon) => {
				lexicon.phrases = [entry({ phrase: "   " })]
			})
		).rejects.toThrow(/normalizes to nothing/)
	})

	it("refuses a phrase scoped to no locale at all", async () => {
		await expect(
			await scratchRoute((_model, lexicon) => {
				lexicon.phrases = [entry({ phrase: "prescription", locales: [] })]
			})
		).rejects.toThrow(/scoped to nowhere/)
	})

	it("refuses a derived form whose base the lexicon does not declare", async () => {
		await expect(
			await scratchRoute((_model, lexicon) => {
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
