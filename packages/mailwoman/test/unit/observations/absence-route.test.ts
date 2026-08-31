/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Tests for the coverage-qualified absence route (#1965): the conjunction, every named silence, the
 *   authority an observation carries, and the construction refusals.
 *
 *   No pipeline. The route reads a finished `POIIntentOutcome` and a sealed coverage layer, and both are
 *   supplied here — synthetic outcomes against a scratch layer built through `@mailwoman/core/layers`'s own
 *   writers. That is what lets the ASYMMETRY be stated at its sharpest: the same query, the same empty
 *   answer, two cells that differ in nothing but `basis`, and opposite readings. The pilot layer cannot
 *   state it, because every one of its 290 cells is `surveyed`.
 *
 *   The committed pre-registration is asserted too. Its hash is what stops a row that failed from being
 *   rewritten into a row that passes, and a freeze that has drifted from its definition would let exactly
 *   that happen while the loader still reported a clean load.
 */

import type { AddressNode, AddressTree } from "@mailwoman/core/decoder"
import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import {
	CoverageBasis,
	createLayerCoverageTable,
	createLayerManifestTable,
	LayerFreshnessPolicy,
	LayerTier,
	writeLayerCoverage,
	writeLayerManifest,
} from "@mailwoman/core/layers"
import type { POIIntent, POIIntentOutcome, POIResult } from "@mailwoman/core/pipeline"
import type { CompiledGeographicModel } from "@mailwoman/geographic-model"
import type { POIDatabase } from "@mailwoman/resolver-wof-sqlite/poi-schema"
import { shortCellToInt, type H3Cell } from "@mailwoman/spatial"
import { DatabaseClient } from "@mailwoman/sqlite/client"
import { latLngToCell } from "h3-js"
import {
	auditAbsenceProbeDefinition,
	loadAbsenceProbeDefinition,
	absenceProbeDefinitionHash,
	ABSENCE_PROBE_DEFINITION_PATH,
	ABSENCE_PROBE_FREEZE_PATH,
	type AbsenceProbeDefinition,
} from "mailwoman/eval-harness/absence-observation/probe"
import {
	createAbsenceObservationRoute,
	describeAbsenceObservation,
	recoverCoverageResolution,
	type AbsenceObservationRoute,
} from "mailwoman/observations"
import { afterAll, describe, expect, it } from "vitest"

const COVERAGE_RESOLUTION = 6

/**
 * Four points in the same region, each in its own res-6 cell, so a scratch layer can give each one a different coverage
 * story without the cells colliding.
 */
const POINTS = {
	surveyedEmpty: { latitude: 48.82, longitude: 1.7553 },
	sourcePresentEmpty: { latitude: 48.7835, longitude: 2.9188 },
	surveyedPopulated: { latitude: 48.7361, longitude: 3.0294 },
	unsurveyed: { latitude: 40.265, longitude: -89.1916 },
} as const

function cellOf(point: { latitude: number; longitude: number }): number {
	return shortCellToInt(latLngToCell(point.latitude, point.longitude, COVERAGE_RESOLUTION) as H3Cell)
}

const committedModel = await readCommittedModel()

async function readCommittedModel(): Promise<CompiledGeographicModel> {
	const { readCompiledGeographicModel } = await import("@mailwoman/geographic-model/scripts/build-artifact")

	return await readCompiledGeographicModel()
}

interface ScratchLayerOptions {
	/**
	 * The classes the layer holds. One is the ordinary case; two is what the pooled-completeness refusal is about.
	 */
	categories?: string[]
	cells?: { h3Cell: number; completeness: number; basis: CoverageBasis; observedRows: number }[]
}

const scratchRoot = await temporaryDirectory("mw-absence-")

afterAll(() => scratchRoot[Symbol.asyncDispose]())
const built: string[] = []

/**
 * A sealed-shaped layer carrying exactly the contract tables the route reads, written through the blessed writers so
 * the scratch artifact and a real one differ in scale and nothing else.
 */
async function scratchLayer(options: ScratchLayerOptions = {}): Promise<string> {
	const path = scratchRoot.resolve(`layer-${built.length}.db`)

	built.push(path)

	using db = new DatabaseClient<POIDatabase>(path)

	await createLayerManifestTable(db)
	await createLayerCoverageTable(db)

	await db.schema
		.createTable("poi_category_codes")
		.addColumn("id", "integer", (c) => c.primaryKey())
		.addColumn("category", "text", (c) => c.unique())
		.execute()

	await writeLayerManifest(db, {
		name: "poi",
		version: "test",
		schemaVersion: 1,
		tier: LayerTier.BuildLocal,
		license: "ODbL-1.0",
		attribution: "OpenStreetMap contributors",
		source: "osm",
		sourceVintage: "260627",
		buildCmd: "mailwoman gazetteer build poi-coverage",
		buildSHA: "testsha",
		freshnessPolicy: LayerFreshnessPolicy.Sealed,
		spineKeys: { h3: { column: "h3_cell", resolution: 9 } },
		createdAt: "2026-08-27T00:00:00.000Z",
	})

	const categories = options.categories ?? ["pharmacy"]

	for (const [index, category] of categories.entries()) {
		await db
			.insertInto("poi_category_codes")
			.values({ id: index + 1, category })
			.execute()
	}

	const cells = options.cells ?? [
		{ h3Cell: cellOf(POINTS.surveyedEmpty), completeness: 0.6665, basis: CoverageBasis.Surveyed, observedRows: 0 },
		{
			h3Cell: cellOf(POINTS.sourcePresentEmpty),
			completeness: 0.6665,
			basis: CoverageBasis.SourcePresent,
			observedRows: 0,
		},
		{ h3Cell: cellOf(POINTS.surveyedPopulated), completeness: 0.6665, basis: CoverageBasis.Surveyed, observedRows: 2 },
	]

	if (cells.length) {
		await writeLayerCoverage(db, cells)
	}

	return path
}

/**
 * A finished POI answer, as the executor would have produced it: a category subject, an anchor tree whose one node
 * carries the resolved centroid, and the rows the search returned.
 */
function answered(
	categoryID: string,
	center: { latitude: number; longitude: number },
	results: POIResult[] = []
): POIIntentOutcome {
	const node: AddressNode = {
		tag: "locality",
		value: "anchor",
		start: 0,
		end: 6,
		confidence: 1,
		children: [],
		lat: center.latitude,
		lon: center.longitude,
	}

	const tree: AddressTree = { raw: "anchor", roots: [node] }

	const intent: POIIntent = {
		subject: { kind: "category", categoryIDs: [categoryID], matched: categoryID },
		relation: "near",
		anchor: { text: "anchor", tree },
	}

	return { type: "intent", intent, results }
}

function poiRow(latitude: number, longitude: number): POIResult {
	return {
		name: "a pharmacy",
		categoryID: "pharmacy",
		brandWikidata: null,
		latitude,
		longitude,
		country: "FR",
		confidence: 1,
		gersID: null,
	}
}

const routes: AbsenceObservationRoute[] = []

async function routeOver(options: ScratchLayerOptions = {}, model?: CompiledGeographicModel) {
	const route = await createAbsenceObservationRoute({
		coverageDatabasePath: await scratchLayer(options),
		model: model ?? committedModel,
	})

	routes.push(route)

	return route
}

afterAll(() => {
	for (const route of routes) {
		route[Symbol.dispose]()
	}
})

describe("the asymmetry — the same empty answer, read two ways", () => {
	it("fires inside exclusion-grade coverage on a cell the layer surveyed and holds nothing in", async () => {
		const route = await routeOver()
		const decision = await route.observe(answered("pharmacy", POINTS.surveyedEmpty))

		expect(decision.fired).toBe(true)
	})

	it("stays silent on the SAME empty answer when the cell's basis is source_present", async () => {
		const route = await routeOver()
		const decision = await route.observe(answered("pharmacy", POINTS.sourcePresentEmpty))

		expect(decision).toEqual({ fired: false, refusal: "basis_supports_no_exclusion" })
	})

	it("stays silent on the SAME empty answer where the layer carries no coverage row at all", async () => {
		const route = await routeOver()
		const decision = await route.observe(answered("pharmacy", POINTS.unsurveyed))

		expect(decision).toEqual({ fired: false, refusal: "cell_unsurveyed" })
	})

	it("stays silent on an empty answer whose cell the layer holds rows in", async () => {
		const route = await routeOver()
		const decision = await route.observe(answered("pharmacy", POINTS.surveyedPopulated))

		expect(decision).toEqual({ fired: false, refusal: "cell_not_empty" })
	})
})

describe("the conjunction's other half — the artifact", () => {
	it("refuses a category the artifact asserts no affordance for", async () => {
		const route = await routeOver({ categories: ["cafe"] })
		const decision = await route.observe(answered("cafe", POINTS.surveyedEmpty))

		expect(decision).toEqual({ fired: false, refusal: "no_affordance_assertion" })
	})

	// The committed artifact affords `obtain_medication` from both wave-1 classes; the pilot layer surveys `pharmacy`.
	// So `drugstore` is a class the artifact CAN speak about and the layer cannot, which is a different refusal from
	// a class the artifact never heard of.
	it("refuses a category the artifact affords but the layer never surveyed", async () => {
		const route = await routeOver()

		expect(route.identity.affordingCategoryIDs).toEqual(["drugstore", "pharmacy"])

		const decision = await route.observe(answered("drugstore", POINTS.surveyedEmpty))

		expect(decision).toEqual({ fired: false, refusal: "category_not_surveyed" })
	})

	// The union: an activity afforded by two classes puts two classes in one search, and the layer's completeness
	// covers one of them. "No establishment affording this activity is here" would then be a claim about premises the
	// survey never looked for, so the whole searched set has to be the surveyed class or the cell is not decidable.
	it("refuses a searched union that reaches past the surveyed class", async () => {
		const route = await routeOver()
		const outcome = answered("pharmacy", POINTS.surveyedEmpty)

		if (outcome.type !== "intent" || outcome.intent.subject.kind !== "category") throw new Error("unreachable")

		// The same cell and the same answer, with the second class added to the SEARCH — the one difference.
		expect(await route.observe(outcome)).toMatchObject({ fired: true })

		outcome.intent.subject.categoryIDs = ["drugstore", "pharmacy"]

		expect(await route.observe(outcome)).toEqual({ fired: false, refusal: "category_not_surveyed" })
	})
})

describe("the silences that are about the answer rather than the world", () => {
	it("refuses an answer the executor never produced", async () => {
		const route = await routeOver()

		expect(await route.observe(undefined)).toEqual({ fired: false, refusal: "no_poi_answer" })

		expect(await route.observe({ type: "abstain", reason: "anchor_required" })).toEqual({
			fired: false,
			refusal: "no_poi_answer",
		})
	})

	it("refuses an intent the executor never ran — a search that did not happen returns nothing for its own reasons", async () => {
		const route = await routeOver()
		const outcome = answered("pharmacy", POINTS.surveyedEmpty)
		const unexecuted: POIIntentOutcome = { type: "intent", intent: (outcome as { intent: POIIntent }).intent }

		expect(await route.observe(unexecuted)).toEqual({ fired: false, refusal: "executor_did_not_run" })
	})

	it("refuses a non-category subject", async () => {
		const route = await routeOver()

		const outcome: POIIntentOutcome = {
			type: "intent",
			intent: { subject: { kind: "name", text: "Pharmacie du Centre" } },
			results: [],
		}

		expect(await route.observe(outcome)).toEqual({ fired: false, refusal: "subject_not_a_category" })
	})

	it("refuses an un-anchored search — there is no cell to qualify", async () => {
		const route = await routeOver()

		const outcome: POIIntentOutcome = {
			type: "intent",
			intent: { subject: { kind: "category", categoryIDs: ["pharmacy"], matched: "pharmacy" } },
			results: [],
		}

		expect(await route.observe(outcome)).toEqual({ fired: false, refusal: "no_search_center" })
	})

	it("refuses when the answer returns a row inside the cell the coverage row calls empty", async () => {
		const route = await routeOver()

		const outcome = answered("pharmacy", POINTS.surveyedEmpty, [
			poiRow(POINTS.surveyedEmpty.latitude, POINTS.surveyedEmpty.longitude),
		])

		expect(await route.observe(outcome)).toEqual({ fired: false, refusal: "coverage_contradicted_by_answer" })
	})

	it("still fires when the answer returns rows from OTHER cells — the claim is about the queried cell", async () => {
		const route = await routeOver()

		const outcome = answered("pharmacy", POINTS.surveyedEmpty, [
			poiRow(POINTS.surveyedPopulated.latitude, POINTS.surveyedPopulated.longitude),
		])

		const decision = await route.observe(outcome)

		expect(decision.fired).toBe(true)

		if (!decision.fired) return

		expect(decision.observation.resultsReturned).toBe(1)
		expect(decision.observation.resultsInCell).toBe(0)
	})
})

describe("what an observation carries", () => {
	it("carries both provenances — the assertion's and the coverage cell's", async () => {
		const route = await routeOver()
		const decision = await route.observe(answered("pharmacy", POINTS.surveyedEmpty))

		expect(decision.fired).toBe(true)

		if (!decision.fired) return

		const { observation } = decision

		expect(observation.concept).toBe("pharmacy")
		expect(observation.activity).toBe("obtain_medication")
		expect(observation.assertion.relation).toBe("affords")
		expect(observation.assertion.modality).toBe("necessary")
		expect(observation.assertion.provenance.source).toBeTruthy()
		expect(observation.mapping.vocabulary).toBe("poi-taxonomy")
		expect(observation.mapping.provenance.source).toBeTruthy()

		expect(observation.coverage.basis).toBe(CoverageBasis.Surveyed)
		expect(observation.coverage.observedRows).toBe(0)
		expect(observation.coverage.surveyedCategoryID).toBe("pharmacy")
		expect(observation.coverage.resolution).toBe(COVERAGE_RESOLUTION)
		expect(observation.coverage.layer.license).toBe("ODbL-1.0")
		expect(observation.coverage.layer.source).toBe("osm")

		const line = describeAbsenceObservation(observation)

		expect(line).toContain("obtain_medication")
		expect(line).toContain("surveyed")
		expect(line).toContain(observation.assertion.provenance.source)
		expect(line).toContain(observation.coverage.layer.source)
	})
})

describe("construction refusals", () => {
	it("refuses a layer holding more than one class — a pooled completeness supports no per-class exclusion", async () => {
		await expect(routeOver({ categories: ["pharmacy", "cafe"] })).rejects.toThrow(/holds 2 classes/)
	})

	it("refuses a layer with no coverage rows at all", async () => {
		await expect(routeOver({ cells: [] })).rejects.toThrow(/holds no cells/)
	})

	it("refuses an artifact that defines no affords relation", async () => {
		const model = structuredClone(committedModel)
		model.relations = model.relations.filter((relation) => String(relation.id) !== "affords")

		await expect(routeOver({}, model)).rejects.toThrow(/defines no `affords` relation/)
	})

	it("refuses an artifact whose concepts assert no affordance the vocabulary maps", async () => {
		const model = structuredClone(committedModel)
		model.mappings = []

		await expect(routeOver({}, model)).rejects.toThrow(/could never fire/)
	})
})

describe("recovering the coverage resolution from the cells themselves", () => {
	it("recovers the resolution a short cell was captured at", () => {
		expect(recoverCoverageResolution([cellOf(POINTS.surveyedEmpty), cellOf(POINTS.surveyedPopulated)])).toBe(
			COVERAGE_RESOLUTION
		)

		expect(recoverCoverageResolution([shortCellToInt(latLngToCell(48.82, 1.7553, 9) as H3Cell)])).toBe(9)
	})

	it("refuses a table that mixes resolutions rather than probing at one of them", () => {
		const mixed = [cellOf(POINTS.surveyedEmpty), shortCellToInt(latLngToCell(48.82, 1.7553, 9) as H3Cell)]

		expect(() => recoverCoverageResolution(mixed)).toThrow(/mixes resolutions/)
	})

	it("refuses an empty table", () => {
		expect(() => recoverCoverageResolution([])).toThrow(/holds no cells/)
	})
})

const frozenAbsenceDefinition = await loadAbsenceProbeDefinition()

describe("the frozen pre-registration", () => {
	const definition = frozenAbsenceDefinition

	it("loads, and its content hash matches the committed freeze record", () => {
		expect(definition.probeID).toBe("absence-observation-pharmacy-idf-v1")
		expect(auditAbsenceProbeDefinition(definition)).toEqual([])
		expect(ABSENCE_PROBE_DEFINITION_PATH).toContain("probe-definition.json")
		expect(ABSENCE_PROBE_FREEZE_PATH).toContain("probe-freeze.json")
	})

	it("refuses a definition whose content has moved", () => {
		const moved: AbsenceProbeDefinition = structuredClone(definition)
		moved.rows[0]!.query = "pharmacy near somewhere else"

		expect(absenceProbeDefinitionHash(moved)).not.toBe(absenceProbeDefinitionHash(definition))
	})

	it("registers both sides of the asymmetry", () => {
		const groups = new Set(definition.rows.map((row) => row.group))

		expect(groups).toEqual(new Set(["target", "outside_coverage", "wrong_class", "cell_populated"]))
		expect(definition.requiredRowHolds).toBe(definition.rows.length)
	})

	it("refuses a target row that does not expect the observation", () => {
		const broken: AbsenceProbeDefinition = structuredClone(definition)
		broken.rows.find((row) => row.group === "target")!.expectedOutcome = "cell_unsurveyed"

		expect(auditAbsenceProbeDefinition(broken)).toContainEqual(expect.stringContaining("a target row expects"))
	})

	it("refuses a control row that expects the observation", () => {
		const broken: AbsenceProbeDefinition = structuredClone(definition)
		broken.rows.find((row) => row.group !== "target")!.expectedOutcome = "absence_observation"

		expect(auditAbsenceProbeDefinition(broken)).toContainEqual(
			expect.stringContaining("control expects the observation")
		)
	})

	it("refuses a row count the required-holds figure does not match", () => {
		const broken: AbsenceProbeDefinition = structuredClone(definition)
		broken.requiredRowHolds = definition.rows.length - 1

		expect(auditAbsenceProbeDefinition(broken)).toContainEqual(expect.stringContaining("asserts a conjunction"))
	})
})
