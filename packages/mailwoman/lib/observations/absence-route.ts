/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { type CoverageCell, type LayerManifest, readLayerCoverage, readLayerManifest } from "@mailwoman/core/layers"
import type { POIIntentOutcome } from "@mailwoman/core/pipeline"
import { compareByCodePoint } from "@mailwoman/core/strings/compare"
import { CoverageBasis, supportsExclusion } from "@mailwoman/evidence"
import type {
	CompiledGeographicModel,
	ConceptRecord,
	ExternalMappingRecord,
	RelationAssertion,
	SourceProvenance,
} from "@mailwoman/geographic-model"
import type { POIDatabase } from "@mailwoman/resolver-wof-sqlite/poi"
import { recoverShortCellResolution, type H3Cell } from "@mailwoman/spatial"
import { DatabaseClient } from "@mailwoman/sqlite/client"
import { latLngToCell } from "h3-js"
import type { PathBuilderLike } from "path-ts"

import { readCommittedModel } from "#observations/committed-model"
import { resolvePOISearchCenter } from "#poi/executor"

const AFFORDS_RELATION = "affords"

const POI_TAXONOMY_VOCABULARY = "poi-taxonomy"

/**
 * Records one coverage-qualified absence beside a POI answer, carrying both the artifact's
 * affordance provenance and the coverage layer's evidence for the cell.
 */
export interface AbsenceObservation {
	/**
	 * The answered POI category ID, which is the mapping's `externalID` for the concept.
	 */
	categoryID: string

	/**
	 * The ID of the concept the category maps to in the compiled model.
	 */
	concept: string

	/**
	 * The activity the concept affords, which the observation states is not obtainable in the cell.
	 */
	activity: string
	assertion: {
		id: string
		relation: string
		modality: string
		provenance: SourceProvenance
	}
	mapping: {
		id: string
		vocabulary: string
		externalID: string
		provenance: SourceProvenance
	}
	modelVersion: string

	/**
	 * The coverage side of the claim: which cell, on what basis, and what the layer holds there.
	 */
	coverage: {
		/**
		 * The short-cell integer the coverage table is keyed by; `h3CellIndex` is the full index it expands to.
		 */
		h3Cell: number
		h3CellIndex: string
		resolution: number
		basis: CoverageBasis
		completeness: number
		observedRows: number

		/**
		 * The single class the coverage layer holds, read from its `poi_category_codes`.
		 *
		 * It always equals `categoryID`; it is recorded so a reader can check that guard.
		 */
		surveyedCategoryID: string
		layer: {
			name: string
			version: string
			tier: string
			license: string
			attribution?: string
			source: string
			sourceVintage: string
			buildCmd: string
			buildSHA: string
			createdAt: string
		}
		databasePath: string
	}

	/**
	 * The point the POI executor centred its search on, as `resolvePOISearchCenter` returns it.
	 */
	searchCenter: { latitude: number; longitude: number }

	/**
	 * How many rows the answer returned in total.
	 *
	 * `resultsInCell` is always zero on an observation, because a returned row inside
	 * the cell contradicts the coverage row and the route refuses instead.
	 */
	resultsReturned: number
	resultsInCell: number
}

/**
 * Lists the named reasons a query can produce no absence observation.
 *
 * Each silence is named so that a receipt can tell a correct refusal from an unexplained one.
 */
export const ABSENCE_REFUSALS = [
	"no_poi_answer",

	"executor_did_not_run",

	"subject_not_a_category",

	"no_affordance_assertion",

	"category_not_surveyed",

	"no_search_center",

	"cell_unsurveyed",

	"basis_supports_no_exclusion",

	"cell_not_empty",

	"coverage_contradicted_by_answer",
] as const

/**
 * Names one reason from {@linkcode ABSENCE_REFUSALS} that the route declined to record an absence.
 */
export type AbsenceRefusal = (typeof ABSENCE_REFUSALS)[number]

/**
 * What the route decided about one answer: an observation, or a named silence.
 */
export type AbsenceDecision =
	| { fired: true; observation: AbsenceObservation }
	| { fired: false; refusal: AbsenceRefusal }

/**
 * Describes which artifact and coverage layer a route reads, so a receipt can tell a
 * route that found no result from one built against the wrong layer.
 */
export interface AbsenceRouteIdentity {
	modelVersion: string

	/**
	 * Every POI category ID the model both maps and asserts an affordance for, in code-point order.
	 */
	affordingCategoryIDs: string[]
	coverageDatabasePath: string
	coverageLayer: LayerManifest

	/**
	 * The single class the coverage layer holds, and the only category this route may speak about.
	 */
	surveyedCategoryID: string
	coverageResolution: number
	coverageCells: number

	/**
	 * Cells recorded as surveyed and empty on a basis that supports exclusion,
	 * which bounds how often the route can fire.
	 */
	exclusionGradeEmptyCells: number
}

/**
 * Represents an open absence route that decides, for each POI outcome,
 * whether to record an absence observation or a named refusal.
 * Dispose it to close the coverage database.
 */
export interface AbsenceObservationRoute extends Disposable {
	identity: AbsenceRouteIdentity

	/**
	 * Decides one answered query from the outcome and the coverage layer, without changing the outcome.
	 */
	observe: (outcome: POIIntentOutcome | undefined) => Promise<AbsenceDecision>
}

/**
 * Configures {@linkcode createAbsenceObservationRoute} with the sealed coverage layer to read,
 * and optionally a compiled model to use in place of the committed one.
 */
export interface AbsenceObservationRouteOptions {
	/**
	 * The sealed single-class layer whose `layer_coverage` rows qualify the absence.
	 *
	 * It has no default, because a guessed layer would qualify an absence against a survey nobody chose.
	 */
	coverageDatabasePath: PathBuilderLike

	/**
	 * A compiled model to use instead of the committed one, typically a synthetic model in tests.
	 */
	model?: CompiledGeographicModel
}

interface AffordingCategory {
	concept: ConceptRecord
	assertion: RelationAssertion
	mapping: ExternalMappingRecord
}

function indexAffordingCategories(model: CompiledGeographicModel): Map<string, AffordingCategory> {
	const byExternalID = new Map<string, AffordingCategory>()

	const mappings = model.mappings.filter((mapping) => mapping.vocabulary === POI_TAXONOMY_VOCABULARY)

	for (const concept of model.concepts.toSorted((left, right) =>
		compareByCodePoint(String(left.id), String(right.id))
	)) {
		const mapping = mappings.find((candidate) => String(candidate.concept) === String(concept.id))

		if (!mapping) continue

		const assertion = concept.assertions.find((candidate) => String(candidate.relation) === AFFORDS_RELATION)

		if (!assertion) continue

		const externalID = String(mapping.externalID)

		if (byExternalID.has(externalID)) continue

		byExternalID.set(externalID, { concept, assertion, mapping })
	}

	return byExternalID
}

/**
 * Recovers the single H3 resolution at which a layer's coverage cells were stored.
 *
 * @throws {Error} When the table is empty, when a cell expands at no resolution, or when the cells disagree.
 */
export function recoverCoverageResolution(cells: readonly number[]): number {
	return recoverShortCellResolution(cells, "absence route")
}

async function readSurveyedCategories(db: DatabaseClient<POIDatabase>): Promise<string[]> {
	const rows = await db.selectFrom("poi_category_codes").select("category").execute()

	return rows.map((row) => row.category).toSorted(compareByCodePoint)
}

/**
 * Opens an absence route against one compiled model and one sealed single-class coverage layer.
 *
 * It throws at construction on any configuration that would otherwise make the route silently never fire.
 */
export async function createAbsenceObservationRoute(
	options: AbsenceObservationRouteOptions
): Promise<AbsenceObservationRoute> {
	const model = options.model ?? (await readCommittedModel())

	if (!model.relations.some((relation) => String(relation.id) === AFFORDS_RELATION)) {
		throw new Error(
			`absence route: the compiled model defines no \`${AFFORDS_RELATION}\` relation — this route reads that relation and no other`
		)
	}

	const affording = indexAffordingCategories(model)

	if (!affording.size) {
		throw new Error(
			"absence route: no concept in the compiled model both maps into `poi-taxonomy` and asserts an affordance — the route could never fire"
		)
	}

	const db = new DatabaseClient<POIDatabase>(options.coverageDatabasePath, { readOnly: true })

	try {
		const coverageLayer = await readLayerManifest(db)
		const surveyed = await readSurveyedCategories(db)

		if (surveyed.length !== 1) {
			throw new Error(
				`absence route: ${options.coverageDatabasePath} holds ${surveyed.length} classes (${surveyed.join(", ") || "none"}) — a coverage row pooled over several classes supports no per-class exclusion`
			)
		}

		const surveyedCategoryID = surveyed[0]!
		const cellRows = await db.selectFrom("layer_coverage").select(["h3_cell", "basis", "observed_rows"]).execute()
		const coverageResolution = recoverCoverageResolution(cellRows.map((row) => row.h3_cell))

		const exclusionGradeEmptyCells = cellRows.filter(
			(row) => row.observed_rows === 0 && supportsExclusion({ basis: row.basis ?? CoverageBasis.SourcePresent })
		).length

		const identity: AbsenceRouteIdentity = {
			modelVersion: model.modelVersion,
			affordingCategoryIDs: [...affording.keys()].toSorted(compareByCodePoint),
			coverageDatabasePath: options.coverageDatabasePath.toString(),
			coverageLayer,
			surveyedCategoryID,
			coverageResolution,
			coverageCells: cellRows.length,
			exclusionGradeEmptyCells,
		}

		return {
			identity,
			observe: (outcome) => decide(outcome, { affording, model, db, identity }),
			[Symbol.dispose]: () => db[Symbol.dispose](),
		}
	} catch (error) {
		db[Symbol.dispose]()

		throw error
	}
}

interface DecisionContext {
	affording: Map<string, AffordingCategory>
	model: CompiledGeographicModel
	db: DatabaseClient<POIDatabase>
	identity: AbsenceRouteIdentity
}

async function decide(outcome: POIIntentOutcome | undefined, context: DecisionContext): Promise<AbsenceDecision> {
	if (!outcome || outcome.type !== "intent") return { fired: false, refusal: "no_poi_answer" }

	const { intent, results } = outcome

	if (!results) return { fired: false, refusal: "executor_did_not_run" }

	if (intent.subject.kind !== "category") return { fired: false, refusal: "subject_not_a_category" }

	const { categoryIDs } = intent.subject
	const afforded = categoryIDs.map((id) => context.affording.get(id)).find((entry) => entry !== undefined)

	if (!afforded) return { fired: false, refusal: "no_affordance_assertion" }

	if (!categoryIDs.every((id) => id === context.identity.surveyedCategoryID)) {
		return { fired: false, refusal: "category_not_surveyed" }
	}

	const categoryID = context.identity.surveyedCategoryID

	const searchCenter = resolvePOISearchCenter(intent)

	if (!searchCenter) return { fired: false, refusal: "no_search_center" }

	const resolution = context.identity.coverageResolution
	const cellIndex = latLngToCell(searchCenter.latitude, searchCenter.longitude, resolution) as H3Cell
	const h3Cell = Number(BigInt(`0x${cellIndex.slice(2)}`))
	const cell: CoverageCell | undefined = await readLayerCoverage(context.db, h3Cell)

	if (!cell) return { fired: false, refusal: "cell_unsurveyed" }

	const basis = cell.basis

	if (!basis || !supportsExclusion(cell)) return { fired: false, refusal: "basis_supports_no_exclusion" }

	if (cell.observedRows !== 0) return { fired: false, refusal: "cell_not_empty" }

	const resultsInCell = results.filter(
		(result) => (latLngToCell(result.latitude, result.longitude, resolution) as string) === cellIndex
	).length

	if (resultsInCell) return { fired: false, refusal: "coverage_contradicted_by_answer" }

	const { concept, assertion, mapping } = afforded
	const layer = context.identity.coverageLayer

	return {
		fired: true,
		observation: {
			categoryID,
			concept: String(concept.id),
			activity: String(assertion.target),
			assertion: {
				id: String(assertion.id),
				relation: String(assertion.relation),
				modality: assertion.modality,
				provenance: assertion.provenance,
			},
			mapping: {
				id: String(mapping.id),
				vocabulary: mapping.vocabulary,
				externalID: String(mapping.externalID),
				provenance: mapping.provenance,
			},
			modelVersion: context.model.modelVersion,
			coverage: {
				h3Cell,
				h3CellIndex: cellIndex,
				resolution,
				basis,
				completeness: cell.completeness,
				observedRows: cell.observedRows,
				surveyedCategoryID: context.identity.surveyedCategoryID,
				layer: {
					name: layer.name,
					version: layer.version,
					tier: layer.tier,
					license: layer.license,
					...(layer.attribution ? { attribution: layer.attribution } : {}),
					source: layer.source,
					sourceVintage: layer.sourceVintage,
					buildCmd: layer.buildCmd,
					buildSHA: layer.buildSHA,
					createdAt: layer.createdAt,
				},
				databasePath: context.identity.coverageDatabasePath,
			},
			searchCenter,
			resultsReturned: results.length,
			resultsInCell,
		},
	}
}

/**
 * One line a reader can check the claim from, with both provenances on it.
 */
export function describeAbsenceObservation(observation: AbsenceObservation): string {
	const { coverage, assertion, mapping } = observation

	return (
		`no establishment affording ${observation.activity} within the searched area — ` +
		`coverage cell ${coverage.h3CellIndex} (res ${coverage.resolution}) holds ${coverage.observedRows} ` +
		`${coverage.surveyedCategoryID} rows on basis "${coverage.basis}" at completeness ${coverage.completeness.toFixed(4)}; ` +
		`affordance from ${assertion.id} (${assertion.relation}, ${assertion.modality}) · ${assertion.provenance.source} · ` +
		`${assertion.provenance.sourceRecord ?? "no source record"}; mapping ${mapping.id} · ${mapping.provenance.source}; ` +
		`coverage from ${coverage.layer.name} ${coverage.layer.version} (${coverage.layer.source} ${coverage.layer.sourceVintage}, ` +
		`${coverage.layer.license}, build ${coverage.layer.buildSHA})`
	)
}
