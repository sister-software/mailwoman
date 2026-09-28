/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { changeMode, writeLocalFile } from "@mailwoman/core/fs/writers"
import { isoDate } from "@mailwoman/core/utils"
import { DatabaseClient } from "@mailwoman/sqlite/client"

import { familyRollup } from "#family-rollup"
import type { FRN } from "#frn"
import { FilerIdentifierType, FilerRelationship, type FilerDatabase } from "#schema"
import { buildFilerDatabase } from "#sdk/build/filer"
import { clusterFilers, type InferredClusterResult } from "#sdk/cluster-filers"
import {
	buildControlEvalInputs,
	buildFilteredEvalInputs,
	buildLinkageEvalForm499Rows,
	buildLinkageEvalProviderRows,
	buildTruthFamilyGroups,
	buildTruthRegistrants,
	hashLinkageEvalInputs,
	type LinkageEvalInputs,
	type LinkageEvalRegistrant,
	LINKAGE_EVAL_AS_OF,
} from "#tools/linkage/corpus"
import { groupPredicateFromMap, scorePairwiseGrouping, type PairwiseGroupingScore } from "#tools/linkage/metrics"
import { renderLinkageEvalReport } from "#tools/linkage/report"

/**
 * Fixing these provenance values rather than taking the current date makes a re-run on
 * another day build identical `filer_edge` and `filer_family` provenance columns.
 */
const EVAL_SOURCE_VINTAGE = "2026-eval-v1"
const EVAL_VALID_FROM = "2026-01-01"

/**
 * This label stands in for a git SHA because the synthetic corpus has no tracked
 * source file to attribute the build to.
 */
const EVAL_BUILD_SHA = "filer-linkage-eval"

/**
 * Counts the ownership-bearing rows in a built artifact that still holds
 * management-company `filer_family` rows.
 *
 * That count lets the report measure the withholding rather than describe it.
 */
export interface LeakageCensus {
	holdingCompanyNodes: number
	/**
	 * The prediction reads only `filer_family`, so an ownership edge alone does not change a score.
	 */
	ownershipEdges: number
	/**
	 * These are the rows the prediction scores, and they must number 0 in the withheld build.
	 */
	scoredFamilyRows: number
	nonOwnershipFamilyRows: number
	/**
	 * The leakage check fails on a nonzero count because such a row cannot be
	 * ruled out as asserting ownership.
	 */
	unrecognizedFamilyRows: number
	/**
	 * The three split counts partition every row, so they sum to this total.
	 */
	familyRows: number
}

/**
 * `satisfies Record<FilerRelationship, boolean>` makes a new relationship a compile error
 * until someone classifies whether it asserts ownership.
 */
const OWNERSHIP_BY_RELATIONSHIP = {
	[FilerRelationship.SameEntity]: false,
	[FilerRelationship.ManagementCompany]: false,
	[FilerRelationship.HoldingCompany]: true,
	[FilerRelationship.ParentCompany]: true,
	[FilerRelationship.Subsidiary]: true,
	// A supersession chain records identity continuity rather than control.
	[FilerRelationship.SupersededBy]: false,
} as const satisfies Record<FilerRelationship, boolean>

/**
 * An unrecognized relationship counts as not ownership, and the {@linkcode isRecognizedRelationship}
 * guard is required because a bare lookup of a key such as `constructor` on the plain
 * `OWNERSHIP_BY_RELATIONSHIP` object returns an inherited function, which is truthy.
 */
function assertsOwnership(relationship: string): boolean {
	return isRecognizedRelationship(relationship) && OWNERSHIP_BY_RELATIONSHIP[relationship as FilerRelationship]
}

/**
 * The prediction ignores an unrecognized relationship while the leakage check must
 * fail on one, so this stays separate from {@linkcode assertsOwnership}.
 */
function isRecognizedRelationship(relationship: string): boolean {
	return Object.hasOwn(OWNERSHIP_BY_RELATIONSHIP, relationship)
}

async function readLeakageCensus(db: DatabaseClient<FilerDatabase>): Promise<LeakageCensus> {
	const nodes = await db
		.selectFrom("filer_node")
		.select("node_id")
		.where("identifier_type", "=", FilerIdentifierType.HoldingCompanyName)
		.execute()

	const edges = await db.selectFrom("filer_edge").select("relationship").execute()
	const familyRows = await db.selectFrom("filer_family").select("relationship").execute()

	return {
		holdingCompanyNodes: nodes.length,
		ownershipEdges: edges.filter((row) => assertsOwnership(row.relationship)).length,
		scoredFamilyRows: familyRows.filter((row) => assertsOwnership(row.relationship)).length,
		nonOwnershipFamilyRows: familyRows.filter(
			(row) => isRecognizedRelationship(row.relationship) && !assertsOwnership(row.relationship)
		).length,
		unrecognizedFamilyRows: familyRows.filter((row) => !isRecognizedRelationship(row.relationship)).length,
		familyRows: familyRows.length,
	}
}

/**
 * Throws when the withheld build holds an ownership fact that reached the build by any
 * path other than the cleared builder input, refusing to report an inflated score.
 */
export function assertNoOwnershipLeak(census: LeakageCensus): void {
	if (census.holdingCompanyNodes || census.ownershipEdges || census.scoredFamilyRows || census.unrecognizedFamilyRows) {
		throw new Error(
			"filerLinkageEval: the withheld build contains ownership facts it was supposed to have never seen " +
				`(${census.holdingCompanyNodes} holding_company_name nodes, ${census.ownershipEdges} ownership edges, ` +
				`${census.scoredFamilyRows} scoreable filer_family rows, ${census.unrecognizedFamilyRows} filer_family rows ` +
				"carrying an unrecognized relationship) — the withheld run's score would be measuring the truth field it is " +
				"meant to withhold. Refusing to report it."
		)
	}
}

interface RegistrantFamilies {
	/**
	 * These family IDs come from memberships whose relationship asserts ownership.
	 */
	predicted: Map<FRN, string[]>
	/**
	 * These cover every membership, including the management-company families
	 * the report shows but never scores.
	 */
	observed: Map<FRN, string[]>
}

/**
 * Uses only queries a product caller could make and ignores the clustering output,
 * so the result is the eval's whole prediction.
 */
async function readRegistrantFamilies(
	db: DatabaseClient<FilerDatabase>,
	registrants: readonly LinkageEvalRegistrant[]
): Promise<RegistrantFamilies> {
	const predicted = new Map<FRN, string[]>()
	const observed = new Map<FRN, string[]>()

	for (const registrant of registrants) {
		const used = new Set<string>()
		const all = new Set<string>()

		for (const nodeID of registrant.nodeIDs) {
			for (const rollup of await familyRollup(db, { nodeID, asOf: LINKAGE_EVAL_AS_OF })) {
				all.add(rollup.family_id)

				const ownThisNode = rollup.members.filter((member) => member.node_id === nodeID)

				if (ownThisNode.some((member) => assertsOwnership(member.relationship))) {
					used.add(rollup.family_id)
				}
			}
		}

		predicted.set(registrant.representative, [...used].toSorted())
		observed.set(registrant.representative, [...all].toSorted())
	}

	return { predicted, observed }
}

/**
 * Records one truth-positive pair, two registrants whose `holdingCompany` values
 * put them in one family, and whether the run recovered it.
 */
export interface TruthPositivePairOutcome {
	a: FRN
	b: FRN
	familyID: string
	recovered: boolean
}

function findTruthPositivePairs(
	representatives: readonly FRN[],
	truthGroupOf: ReadonlyMap<FRN, string>,
	predictedSame: (a: FRN, b: FRN) => boolean
): TruthPositivePairOutcome[] {
	const outcomes: TruthPositivePairOutcome[] = []

	for (let i = 0; i < representatives.length; i++) {
		for (let j = i + 1; j < representatives.length; j++) {
			const a = representatives[i]!
			const b = representatives[j]!
			const familyID = truthGroupOf.get(a)

			if (familyID === undefined || familyID !== truthGroupOf.get(b)) continue

			outcomes.push({ a, b, familyID, recovered: predictedSame(a, b) })
		}
	}

	return outcomes
}

/**
 * Holds one linkage pass's score, leakage census and family reads.
 */
export interface LinkageEvalRun {
	/**
	 * The label is `"withheld"` or `"control"`.
	 */
	label: string
	holdingCompanyWithheld: boolean
	inputsSHA256: string
	score: PairwiseGroupingScore
	/**
	 * Counters from the entity-resolution pass that the report shows as context
	 * and the prediction does not read.
	 */
	inferred: InferredClusterResult
	census: LeakageCensus
	predictedFamilyIDsOf: Map<FRN, string[]>
	/**
	 * Every family ID for each scored registrant, including the management-company
	 * families the prediction ignores.
	 */
	observedFamilyIDsOf: Map<FRN, string[]>
	truthPositivePairs: TruthPositivePairOutcome[]
}

/**
 * Options for {@linkcode runLinkagePass}.
 */
export interface LinkageEvalPassOptions {
	inputs: LinkageEvalInputs
	registrants: readonly LinkageEvalRegistrant[]
	truthGroupOf: ReadonlyMap<FRN, string>
	label: string
	holdingCompanyWithheld: boolean
	/**
	 * A test-only hook that runs after the leakage check and before the prediction is read,
	 * so it can add ownership facts without tripping the check.
	 */
	injectEvidence?: (db: DatabaseClient<FilerDatabase>) => Promise<void>
}

/**
 * Builds a scratch `filer.db` from one set of inputs, runs the shipped clustering,
 * takes the leakage census, reads each registrant's families, and scores the prediction.
 */
export async function runLinkagePass(options: LinkageEvalPassOptions): Promise<LinkageEvalRun> {
	const { inputs, registrants, truthGroupOf, label, holdingCompanyWithheld, injectEvidence } = options

	await using scratch = await temporaryDirectory(`filer-linkage-eval-${label}-`)
	const out = scratch.path("filer.db")

	await buildFilerDatabase({
		form499Rows: inputs.form499Rows,
		providerRows: inputs.providerRows,
		out,
		sourceVintage: EVAL_SOURCE_VINTAGE,
		validFrom: EVAL_VALID_FROM,
		buildSHA: EVAL_BUILD_SHA,
	})

	// The builder leaves the artifact read-only, and `clusterFilers` must write `filer_cluster` and `filer_edge`.
	await changeMode(out, 0o644)

	using db = new DatabaseClient<FilerDatabase>(out)

	// The pass runs the shipped clustering because its counters belong in the report,
	// even though the eval scores another table.
	const { inferred } = await clusterFilers(db, { sourceVintage: EVAL_SOURCE_VINTAGE, validFrom: EVAL_VALID_FROM })

	// The leakage check covers only the builder's output, so the reported census is taken after injection.
	if (holdingCompanyWithheld) {
		assertNoOwnershipLeak(await readLeakageCensus(db))
	}

	await injectEvidence?.(db)

	const census = await readLeakageCensus(db)
	const { predicted, observed } = await readRegistrantFamilies(db, registrants)

	const predictedSame = (a: FRN, b: FRN): boolean => {
		const familiesOfA = new Set(predicted.get(a))

		return (predicted.get(b) ?? []).some((familyID) => familiesOfA.has(familyID))
	}

	const representatives = registrants.map((registrant) => registrant.representative)
	const score = scorePairwiseGrouping(representatives, groupPredicateFromMap(truthGroupOf), predictedSame)

	return {
		label,
		holdingCompanyWithheld,
		inputsSHA256: hashLinkageEvalInputs(inputs),
		score,
		inferred,
		census,
		predictedFamilyIDsOf: predicted,
		observedFamilyIDsOf: observed,
		truthPositivePairs: findTruthPositivePairs(representatives, truthGroupOf, predictedSame),
	}
}

/**
 * Options for {@linkcode filerLinkageEval}.
 */
export interface FilerLinkageEvalOptions {
	outMd?: string
	/**
	 * Replaces the date in the report's H1.
	 *
	 * The date defaults to today, and scorecard regeneration and reproducibility
	 * tests pin it through this option.
	 */
	date?: string
	printMarkdown?: boolean
}

/**
 * Holds both runs of {@linkcode filerLinkageEval}, whose control run gives the withheld score its meaning.
 */
export interface FilerLinkageEvalResult {
	markdown: string
	withheld: LinkageEvalRun
	control: LinkageEvalRun
	registrants: LinkageEvalRegistrant[]
	truthGroupOf: Map<FRN, string>
}

/**
 * Builds two scratch `filer.db` artifacts from one corpus, one with `holdingCompany` withheld
 * and one intact, scores each against the held-out truth, and renders the markdown scorecard.
 */
export async function filerLinkageEval(
	options: FilerLinkageEvalOptions = {},
	report?: (line: string) => void
): Promise<FilerLinkageEvalResult> {
	const progress = report ?? ((): void => {})
	const date = options.date ?? isoDate()

	const truthForm499Rows = buildLinkageEvalForm499Rows()
	const truthProviderRows = buildLinkageEvalProviderRows()
	const registrants = buildTruthRegistrants(truthForm499Rows, truthProviderRows)
	const truthGroupOf = buildTruthFamilyGroups(truthForm499Rows, truthProviderRows)

	const withheldInputs = buildFilteredEvalInputs()
	const controlInputs = buildControlEvalInputs()

	progress("building filer.db from the holdingCompany-stripped projection")

	const withheld = await runLinkagePass({
		inputs: withheldInputs,
		registrants,
		truthGroupOf,
		label: "withheld",
		holdingCompanyWithheld: true,
	})

	progress("building the control filer.db, truth field intact")

	const control = await runLinkagePass({
		inputs: controlInputs,
		registrants,
		truthGroupOf,
		label: "control",
		holdingCompanyWithheld: false,
	})

	const markdown = renderLinkageEvalReport({
		date,
		withheld,
		control,
		withheldInputs,
		controlInputs,
		registrants,
		truthForm499Rows,
		truthGroupOf,
	})

	if (options.printMarkdown !== false) {
		console.log(markdown)
	}

	if (options.outMd) {
		await writeLocalFile(markdown, options.outMd)
		progress(`[written] ${options.outMd}`)
	}

	return { markdown, withheld, control, registrants, truthGroupOf }
}
