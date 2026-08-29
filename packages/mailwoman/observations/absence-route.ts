/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The negative-evidence route, observation-only: where the compiled artifact asserts that the
 *   answered category affords an activity AND the coverage layer surveyed the cell the search was centred
 *   on, an answer holding nothing in that cell may be recorded as an ABSENCE — a coverage-qualified
 *   statement that the thing asked for is not there, carrying the assertion's provenance and the coverage
 *   cell's basis together.
 *
 *   THE ROUTE READS; IT NEVER ANSWERS. It takes a finished {@linkcode POIIntentOutcome} and returns a
 *   record beside it. Nothing here is wired into the pipeline, no result is added, removed, re-ordered or
 *   suppressed, and no abstain is reached or avoided because of it. The pipeline that produced the outcome
 *   is byte-identical to the pipeline that runs with this module unloaded, which is what makes the
 *   inertness receipt a statement about construction rather than about a measurement.
 *
 *   BOTH HALVES OF THE CONJUNCTION ARE required, and each has its own refusal. The artifact half
 *   answers "what does this category afford, and on whose authority" — a category no concept both affords
 *   with and maps to is not a category this route can say anything about. The coverage half answers "may a
 *   miss here be read as absence" — {@linkcode supportsExclusion} over the cell's own basis, never over
 *   `completeness` alone, because `source_present` records that the source returned rows and says nothing
 *   about what it missed. Outside exclusion-grade coverage the route is SILENT: a `[]` there is silence,
 *   not absence, and that asymmetry is the whole contract.
 *
 *   A COVERAGE LAYER IS CLASS-SCOPED, AND THE TABLE DOES NOT SAY SO. `layer_coverage` carries a
 *   completeness per cell and no class, so a completeness measured over pharmacies would license an
 *   absence claim about cafés if nothing stopped it. What stops it is read from the artifact rather than
 *   declared: the layer's own `poi_category_codes` names every class it holds, and the route refuses
 *   unless that set is exactly one class and the answered category IS it. A layer holding many classes has
 *   a pooled completeness that cannot support a per-class exclusion, and saying so is the refusal.
 *
 *   A SEARCHED UNION MUST BE COVERED WHOLE. The POI branch searches every category the subject reaches, so
 *   an activity afforded by two establishment classes puts two classes in one search. The layer surveys
 *   ONE, and its completeness says nothing about the other — so "no establishment affording this activity
 *   is here" would be a claim about premises the survey never looked for, which is the unsupported
 *   negative evidence this route exists to refuse. The refusal is `category_not_surveyed`, and it is the
 *   same reading as the single-class case: the searched set has to BE the surveyed class. Widening the
 *   layer to survey the second class is what would make such a cell decidable again.
 *
 *   THE COVERAGE RESOLUTION IS DERIVED, NOT ASSUMED. `layer_manifest.spine_keys.h3.resolution` states the
 *   resolution the layer's ROWS are keyed at (res 9 for `poi.db`); the coverage cells are coarser (res 6).
 *   A reader that probed coverage at the manifest's resolution would miss every cell and read the misses
 *   as unsurveyed — a false negative shaped exactly like the real absence this route exists to detect. So
 *   the resolution is recovered from the stored cells themselves: a short cell sets every digit past its
 *   own resolution to `7`, which no valid digit is, so exactly one resolution expands it into a valid
 *   index. Measured over the pilot layer: 290 of 290 cells expand at resolution 6 and at no other.
 *
 *   WHERE THE OBSERVATION GOES. Through the one carrier both routes share — `observation-marker.ts` turns
 *   an absence observation into a `QueryIntentMarker`, the additive advisory whose contract states that a
 *   marker never changes which answer wins. A second private path from here to the caller would be the
 *   duplication that carrier exists to prevent.
 *
 *   `mailwoman` and `@mailwoman/geographic-model` must bump in ONE coordinated release. `yarn pack` freezes
 *   `workspace:*` to whatever the sibling reads at pack time, so a `mailwoman` packed ahead of the sibling's
 *   bump pins a version that will never be republished. The artifact reader stays behind a dynamic import
 *   so a caller who never builds a route never loads it.
 */

import {
	CoverageBasis,
	type CoverageCell,
	type LayerManifest,
	readLayerCoverage,
	readLayerManifest,
	supportsExclusion,
} from "@mailwoman/core/layers"
import type { POIIntentOutcome } from "@mailwoman/core/pipeline"
import type {
	CompiledGeographicModel,
	ConceptRecord,
	ExternalMappingRecord,
	RelationAssertion,
	SourceProvenance,
} from "@mailwoman/geographic-model"
import type { POIDatabase } from "@mailwoman/resolver-wof-sqlite/poi-schema"
import { recoverShortCellResolution, type H3Cell } from "@mailwoman/spatial"
import { DatabaseClient } from "@mailwoman/sqlite/client"
import { latLngToCell } from "h3-js"

import { resolvePOISearchCenter } from "../poi-executor.ts"

/**
 * The relation an affordance is asserted under — the one the frozen vertical slice defines, and the only one this route
 * reads. The semantic route reads the same relation for the opposite direction (phrase → category); this one reads it
 * from the category back to the activity it affords.
 */
const AFFORDS_RELATION = "affords"

/**
 * The external vocabulary the answered category id belongs to.
 */
const POI_TAXONOMY_VOCABULARY = "poi-taxonomy"

/**
 * One coverage-qualified absence, recorded beside an answer.
 *
 * Everything a reader needs to check the claim is here, from both sides. From the artifact: which concept the answered
 * category names, which activity it affords, under what modality, and on whose authority — the assertion's own
 * provenance and the mapping's. From the coverage layer: the cell, its basis, the completeness that basis rests on, the
 * rows the layer holds there, and the layer's own manifest identity. A reader holding one half alone cannot tell
 * whether the claim was earned.
 */
export interface AbsenceObservation {
	/**
	 * The answered POI category id — the `externalID` the mapping translates the concept into.
	 */
	categoryID: string
	/**
	 * The concept the category names in the compiled artifact.
	 */
	concept: string
	/**
	 * The activity the concept affords, and which the observation therefore states is not obtainable in the cell.
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
		 * The 48-bit short-cell integer the layer stores, and the full index it expands to at the layer's coverage
		 * resolution — the integer is what a reader queries the table with, the index is what a reader can draw.
		 */
		h3Cell: number
		h3CellIndex: string
		resolution: number
		basis: CoverageBasis
		completeness: number
		observedRows: number
		/**
		 * The class the layer holds, read from its own `poi_category_codes`. Equal to `categoryID` on every observation —
		 * carried anyway, because the equality is the guard and a receipt that does not show it cannot be checked.
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
	 * The point the search was centred on — the executor's own, never re-derived.
	 */
	searchCenter: { latitude: number; longitude: number }
	/**
	 * How many rows the answer returned in total, and how many of them fell inside the observed cell. The second is
	 * always zero on an observation: a returned row inside the cell contradicts the coverage row, and the route refuses
	 * rather than choosing which reader to believe.
	 */
	resultsReturned: number
	resultsInCell: number
}

/**
 * Why a query produced no absence observation. Every one of these is a SILENCE the route owes an account of — an
 * unnamed silence and a silence for the right reason read identically on a receipt, and the control rows are graded on
 * exactly which one occurred.
 */
export const ABSENCE_REFUSALS = [
	/**
	 * The coordinator never took the POI branch, or took it and abstained — there is no answer to qualify.
	 */
	"no_poi_answer",
	/**
	 * The POI branch answered, but the executor never ran (intent-only mode). A search that did not happen returns
	 * nothing for a reason that has nothing to do with the world.
	 */
	"executor_did_not_run",
	/**
	 * The subject was a brand or a free-text name. The artifact maps categories, so a non-category subject reaches no
	 * assertion.
	 */
	"subject_not_a_category",
	/**
	 * The compiled artifact carries no concept that both maps to this category and asserts `affords` against an activity.
	 */
	"no_affordance_assertion",
	/**
	 * The coverage layer does not hold this class, so its completeness says nothing about it.
	 */
	"category_not_surveyed",
	/**
	 * The search was un-anchored, so there is no cell to qualify.
	 */
	"no_search_center",
	/**
	 * The layer carries no coverage row for the cell the search was centred on — unmapped, which is unknown and never
	 * absence.
	 */
	"cell_unsurveyed",
	/**
	 * The cell has a coverage row whose basis is `source_present`. The source looked and returned rows; that is presence
	 * evidence and supports no exclusion.
	 */
	"basis_supports_no_exclusion",
	/**
	 * The layer holds rows in the cell, so the cell is not empty. Whether the search reached them is a retrieval
	 * question, not an absence.
	 */
	"cell_not_empty",
	/**
	 * The layer's coverage row says the cell is empty and the answer returned a row inside it. The two readers disagree,
	 * and an absence claim asserted over a disagreement is the confident wrong answer this whole route exists to avoid.
	 */
	"coverage_contradicted_by_answer",
] as const

export type AbsenceRefusal = (typeof ABSENCE_REFUSALS)[number]

/**
 * What the route decided about one answer: an observation, or a named silence.
 */
export type AbsenceDecision =
	| { fired: true; observation: AbsenceObservation }
	| { fired: false; refusal: AbsenceRefusal }

/**
 * What the route is, stated for a receipt: which artifact and which coverage layer it reads, and what it can speak to.
 *
 * A receipt recording only that "the route was on" cannot distinguish a route that found nothing from a route built
 * against the wrong layer, and those produce the same silence for opposite reasons.
 */
export interface AbsenceRouteIdentity {
	modelVersion: string
	/**
	 * Every POI category id the artifact both maps and asserts an affordance for, in code-point order.
	 */
	affordingCategoryIDs: string[]
	coverageDatabasePath: string
	coverageLayer: LayerManifest
	/**
	 * The class the coverage layer holds — the only category this route may speak about.
	 */
	surveyedCategoryID: string
	coverageResolution: number
	coverageCells: number
	/**
	 * Cells recorded surveyed-and-empty: the exclusion payload, and the count worth reading first.
	 */
	exclusionGradeEmptyCells: number
}

export interface AbsenceObservationRoute {
	identity: AbsenceRouteIdentity
	/**
	 * Decide one answered query. Pure with respect to the pipeline: it reads the outcome and the coverage layer and
	 * returns a record.
	 */
	observe: (outcome: POIIntentOutcome | undefined) => Promise<AbsenceDecision>
	close: () => void
}

export interface AbsenceObservationRouteOptions {
	/**
	 * The sealed layer whose `layer_coverage` rows qualify the absence. Required: there is no default coverage layer, and
	 * a route that guessed one would qualify an absence against a survey nobody asked for.
	 */
	coverageDatabasePath: string
	/**
	 * Override the compiled artifact — for a test that wants a synthetic model. Absent reads the committed one.
	 */
	model?: CompiledGeographicModel
}

/**
 * UTF-16 code point, ascending. `localeCompare` is the trap this avoids: its answer depends on the machine's collation,
 * so an order built with it is reproducible only on the machine that built it.
 */
function byCodePoint(left: string, right: string): number {
	if (left < right) return -1

	if (left > right) return 1

	return 0
}

/**
 * One category the artifact can speak about: the concept it names, the affordance assertion, and the mapping that ties
 * the external identifier to the concept.
 */
interface AffordingCategory {
	concept: ConceptRecord
	assertion: RelationAssertion
	mapping: ExternalMappingRecord
}

/**
 * Index the artifact by external category id, keeping only categories that both map into `poi-taxonomy` and carry an
 * `affords` assertion.
 *
 * A category reaching more than one affordance is not resolved here — the first in concept code-point order is taken
 * and the count is not hidden, because choosing among affordances would be a preference this program does not author.
 * The frozen slice reaches exactly one.
 */
function indexAffordingCategories(model: CompiledGeographicModel): Map<string, AffordingCategory> {
	const byExternalID = new Map<string, AffordingCategory>()

	const mappings = model.mappings.filter((mapping) => String(mapping.vocabulary) === POI_TAXONOMY_VOCABULARY)

	for (const concept of model.concepts.toSorted((left, right) => byCodePoint(String(left.id), String(right.id)))) {
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
 * The resolution a layer's coverage cells were captured at, recovered from the cells themselves.
 *
 * A short cell does not name its own resolution, so it cannot simply be read. It can be RECOVERED: the digits past a
 * cell's own resolution are all `7`, which is not a valid digit, so exactly one resolution expands a given short cell
 * into a valid index. Every stored cell is probed rather than a sample of them, and a table whose cells disagree throws
 * — a mixed-resolution coverage table has no single resolution to probe at, and picking one would silently answer
 * "unsurveyed" for every cell at the other.
 *
 * THE IMPLEMENTATION LIVES IN `@mailwoman/spatial` because a second layer reader needed it and the two failure modes it
 * refuses are silent in a copy. This name and its message prefix are kept so callers and their receipts read the same.
 *
 * @throws {Error} When the table is empty, when a cell expands at no resolution, or when the cells disagree.
 */
export function recoverCoverageResolution(cells: readonly number[]): number {
	return recoverShortCellResolution(cells, "absence route")
}

/**
 * The classes a POI layer holds, read from its own code table.
 */
async function readSurveyedCategories(db: DatabaseClient<POIDatabase>): Promise<string[]> {
	const rows = await db.selectFrom("poi_category_codes").select("category").execute()

	return rows.map((row) => row.category).toSorted(byCodePoint)
}

/**
 * Build the route against one compiled artifact and one sealed coverage layer.
 *
 * Everything that would make the route answer a well-formed wrong thing is refused HERE rather than at query time: a
 * layer with no coverage rows, a layer holding more than one class, a coverage table whose resolution cannot be
 * recovered, an artifact that defines no `affords` relation. Each of those would otherwise present as a route that
 * simply never fires, which on a receipt is indistinguishable from a region that genuinely has nothing to say.
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
			// A NULL column is an artifact built before `basis` existed. It was recording source presence, so that is what it
			// counts as here — never a stronger basis than the builder actually had, which is the resolution
			// `readLayerCoverage` applies to the same column.
			(row) => row.observed_rows === 0 && supportsExclusion({ basis: row.basis ?? CoverageBasis.SourcePresent })
		).length

		const identity: AbsenceRouteIdentity = {
			modelVersion: model.modelVersion,
			affordingCategoryIDs: [...affording.keys()].toSorted(byCodePoint),
			coverageDatabasePath: options.coverageDatabasePath,
			coverageLayer,
			surveyedCategoryID,
			coverageResolution,
			coverageCells: cellRows.length,
			exclusionGradeEmptyCells,
		}

		return {
			identity,
			observe: (outcome) => decide(outcome, { affording, model, db, identity }),
			close: () => db.destroy(),
		}
	} catch (error) {
		await db.destroy()

		throw error
	}
}

interface DecisionContext {
	affording: Map<string, AffordingCategory>
	model: CompiledGeographicModel
	db: DatabaseClient<POIDatabase>
	identity: AbsenceRouteIdentity
}

/**
 * The conjunction, in refusal order.
 *
 * Order is chosen so the reason a receipt records is the FIRST thing that was missing rather than the last thing
 * checked: the artifact half before the coverage half, and within the coverage half, "we never surveyed here" before
 * "the survey supports no exclusion" before "the survey found something". A control row is graded on which of these it
 * hit, so an order that reported a later reason would let a row pass its control for a reason nobody registered.
 */
async function decide(outcome: POIIntentOutcome | undefined, context: DecisionContext): Promise<AbsenceDecision> {
	if (!outcome || outcome.type !== "intent") return { fired: false, refusal: "no_poi_answer" }

	const { intent, results } = outcome

	if (!results) return { fired: false, refusal: "executor_did_not_run" }

	if (intent.subject.kind !== "category") return { fired: false, refusal: "subject_not_a_category" }

	const { categoryIDs } = intent.subject
	const afforded = categoryIDs.map((id) => context.affording.get(id)).find((entry) => entry !== undefined)

	if (!afforded) return { fired: false, refusal: "no_affordance_assertion" }

	// EVERY searched category must be the surveyed one. The coverage layer surveys a single category, so a union
	// reaching past it has no survey behind the classes it added — "nothing here" would then be a claim about premises
	// nobody looked for, which is the one thing a coverage-qualified absence exists to refuse.
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

	// `readLayerCoverage` resolves a NULL column to `source_present`, so a cell that reaches here always names its basis —
	// but the field is optional on the parsed type, and `supportsExclusion` is what narrows it to the two that qualify.
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
				modality: String(assertion.modality),
				provenance: assertion.provenance,
			},
			mapping: {
				id: String(mapping.id),
				vocabulary: String(mapping.vocabulary),
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

/**
 * The committed compiled artifact, read through the package that owns it. Never the authoring records: the runtime side
 * of this program consumes an artifact, and traversing authoring JSON is what the boundary record excludes.
 */
async function readCommittedModel(): Promise<CompiledGeographicModel> {
	const { readCompiledGeographicModel } = await import("@mailwoman/geographic-model/scripts/build-artifact")

	return readCompiledGeographicModel()
}
