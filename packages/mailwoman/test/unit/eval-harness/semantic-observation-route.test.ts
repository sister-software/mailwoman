/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Tests for the one semantic observation route the utility probe injects (#1929): the phrase rule, the
 *   authority an observation carries, and every construction refusal.
 *
 *   No model, no database, no pipeline. The route is a `POIPhraseLookup` over a compiled artifact and a
 *   declared phrase table, and both are injectable — so the refusals are exercised against synthetic
 *   models rather than by breaking the committed one.
 *
 *   The committed pair is asserted too, and that is the check with the shortest half-life: a declared
 *   phrase whose activity nothing affords would match a query and answer nothing, which reads at the
 *   probe as the class being unanswerable rather than as the route being unwired.
 */

import type { CompiledGeographicModel } from "@mailwoman/geographic-model"
import {
	type ActivityPhraseTable,
	createSemanticObservationRoute,
	readActivityPhraseTable,
} from "mailwoman/eval-harness/semantic-utility/observation-route"
import { describe, expect, it } from "vitest"

const committedTable = readActivityPhraseTable()
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
 * A route over a mutated copy of the committed pair, so a refusal is provoked without touching either committed file.
 */
async function scratchRoute(
	mutate: (model: CompiledGeographicModel, table: ActivityPhraseTable) => void
): Promise<ReturnType<typeof createSemanticObservationRoute>> {
	const model = structuredClone(committedModel)
	const table = structuredClone(committedTable)

	mutate(model, table)

	return createSemanticObservationRoute({ model, phraseTable: table })
}

describe("the committed declared table against the committed artifact", () => {
	it("resolves — every declared phrase reaches a mapped entity kind", async () => {
		await expect(createSemanticObservationRoute()).resolves.toBeDefined()
	})

	it("reaches exactly the POI category the frozen slice maps", () => {
		expect(committedRoute.identity.reachableCategoryIDs).toEqual(["pharmacy"])
	})

	it("reports what it was built from, so a receipt never has to name it twice", () => {
		expect(committedRoute.identity.phraseTableID).toBe(committedTable.tableID)
		expect(committedRoute.identity.phraseTableVersion).toBe(committedTable.version)
		expect(committedRoute.identity.declaredPhrases).toBe(committedTable.phrases.length)
		expect(committedRoute.identity.modelVersion).toBe(committedModel.modelVersion)
	})

	it("marks its phrases authored rather than measured", () => {
		expect(committedTable.provenance.source).toBe("authored-for-the-probe")
		expect(committedTable.provenance.notes).toBeTruthy()

		for (const entry of committedTable.phrases) {
			expect(entry.note.trim()).not.toBe("")
		}
	})

	it("declares phrases no registered target row uses, so the table is about the activity", () => {
		const registered = new Set([
			"pick up a prescription",
			"prescription",
			"fill a prescription",
			"prescription refilled",
		])

		const beyond = committedTable.phrases.filter((entry) => !registered.has(entry.phrase))

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
		const route = await scratchRoute((_model, table) => {
			table.phrases = [{ phrase: "medication", activity: "obtain_medication", note: "test" }]
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
		expect(observation!.phraseProvenance.source).toBe("authored-for-the-probe")
		expect(observation!.mappedKindCount).toBe(1)
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
			scratchRoute((_model, table) => {
				table.phrases = [{ phrase: "get a haircut", activity: "get_haircut", note: "test" }]
			})
		).rejects.toThrow(/which the compiled model does not carry/)
	})

	it("refuses a concept that is not an activity", async () => {
		await expect(
			scratchRoute((_model, table) => {
				table.phrases = [{ phrase: "prescription", activity: "pharmacy", note: "test" }]
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
			scratchRoute((_model, table) => {
				table.phrases = [
					{ phrase: "prescription", activity: "obtain_medication", note: "test" },
					{ phrase: "  Prescription ", activity: "obtain_medication", note: "test" },
				]
			})
		).rejects.toThrow(/is declared twice/)
	})

	it("refuses an empty table", async () => {
		await expect(
			scratchRoute((_model, table) => {
				table.phrases = []
			})
		).rejects.toThrow(/a route with no surface form can never fire/)
	})

	it("refuses a phrase that normalizes to nothing", async () => {
		await expect(
			scratchRoute((_model, table) => {
				table.phrases = [{ phrase: "   ", activity: "obtain_medication", note: "test" }]
			})
		).rejects.toThrow(/normalizes to nothing/)
	})
})
