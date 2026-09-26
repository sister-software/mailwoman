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
 * These provenance values are fixed rather than taken from the current date.
 *
 * A re-run on another day therefore builds identical `filer_edge` and `filer_family` provenance columns.
 */
const EVAL_SOURCE_VINTAGE = "2026-eval-v1"
const EVAL_VALID_FROM = "2026-01-01"

/**
 * This label stands in for a git SHA because the synthetic corpus has no tracked
 * source file to attribute the build to.
 */
const EVAL_BUILD_SHA = "filer-linkage-eval"

/**
 * This interface counts the ownership-bearing rows in a built artifact.
 *
 * The withheld artifact still holds management-company `filer_family` rows,
 * so the report must measure the withholding rather than describe it.
 * Each ownership count covers every relationship the prediction scores, including
 * `parent_company` and `subsidiary` rows that a future writer adds.
 */
export interface LeakageCensus {
	/**
	 * This field counts `filer_node` rows of type `holding_company_name`.
	 * The builder writes one node per distinct raw parent name.
	 */
	holdingCompanyNodes: number
	/**
	 * This field counts `filer_edge` rows whose relationship asserts ownership.
	 *
	 * The prediction reads only `filer_family`, so an ownership edge alone does not change a score.
	 */
	ownershipEdges: number
	/**
	 * This field counts `filer_family` rows whose relationship asserts ownership,
	 * which are the rows the prediction scores.
	 * It must be 0 in the withheld build.
	 */
	scoredFamilyRows: number
	/**
	 * This field counts `filer_family` rows whose recognized relationship does not assert ownership.
	 *
	 * The count is nonzero in both runs because the corpus discloses management
	 * companies, which the prediction ignores.
	 */
	nonOwnershipFamilyRows: number
	/**
	 * This field counts `filer_family` rows whose relationship is not a {@linkcode FilerRelationship} value.
	 *
	 * No shipped writer produces such a row.
	 * The leakage check fails on a nonzero count because the eval cannot rule
	 * out that the row asserts ownership.
	 */
	unrecognizedFamilyRows: number
	/**
	 * This field counts every `filer_family` row.
	 *
	 * The three split counts partition the rows, so they sum to this total.
	 */
	familyRows: number
}

/**
 * This table records whether each {@linkcode FilerRelationship} asserts ownership,
 * which is the fact this eval withholds and scores.
 *
 * The `satisfies Record<FilerRelationship, boolean>` clause makes a new relationship
 * a compile error until someone classifies it.
 * A denylist would instead count an unclassified relationship as ownership in
 * both the prediction and the census.
 *
 * This file is a source file rather than a test, so plain `tsc -b` enforces the clause.
 *
 * `SameEntity` is false because two identifiers for one filer make no statement about its owner.
 * `ManagementCompany` is false because operational control is not ownership.
 */
const OWNERSHIP_BY_RELATIONSHIP = {
	[FilerRelationship.SameEntity]: false,
	[FilerRelationship.ManagementCompany]: false,
	[FilerRelationship.HoldingCompany]: true,
	[FilerRelationship.ParentCompany]: true,
	[FilerRelationship.Subsidiary]: true,
	// A supersession chain records that one registration became another.
	// It shows identity continuity rather than control.
	[FilerRelationship.SupersededBy]: false,
} as const satisfies Record<FilerRelationship, boolean>

/**
 * This function reports whether a relationship asserts ownership.
 *
 * The census and the prediction both use it, so they always agree on which rows count.
 * An unrecognized relationship counts as not ownership, so the prediction never
 * scores an assertion it cannot classify.
 *
 * The {@linkcode isRecognizedRelationship} guard is required because
 * `OWNERSHIP_BY_RELATIONSHIP` is a plain object.
 * A bare lookup of a key such as `constructor` returns an inherited function, which is truthy.
 */
function assertsOwnership(relationship: string): boolean {
	return isRecognizedRelationship(relationship) && OWNERSHIP_BY_RELATIONSHIP[relationship as FilerRelationship]
}

/**
 * This function reports whether {@linkcode OWNERSHIP_BY_RELATIONSHIP} classifies a relationship.
 *
 * The prediction ignores an unrecognized relationship, but the leakage check must fail on one.
 * One predicate cannot provide both defaults, so this check stays separate
 * from {@linkcode assertsOwnership}.
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
 * This function throws when the withheld build holds any ownership fact.
 *
 * {@linkcode buildFilteredEvalInputs} already clears `holdingCompany` from the builder's inputs.
 * This check catches an ownership fact that reaches the build by any other path.
 *
 * The eval refuses to report a score rather than report an inflated one.
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

/**
 * This interface holds each registrant's `filer_family` families, keyed by representative FRN.
 */
interface RegistrantFamilies {
	/**
	 * These family IDs come from memberships whose relationship asserts ownership.
	 */
	predicted: Map<FRN, string[]>
	/**
	 * These family IDs cover every membership, including management-company families.
	 * The report shows them but never scores them.
	 */
	observed: Map<FRN, string[]>
}

/**
 * This function reads each registrant's family memberships with the shipped
 * `familyRollup` reader at {@linkcode LINKAGE_EVAL_AS_OF}.
 *
 * The result is the eval's whole prediction.
 * It uses only queries a product caller could make, and it ignores the clustering output.
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
 * This interface records one truth-positive pair and whether the run recovered it.
 *
 * A truth-positive pair is two registrants whose `holdingCompany` values put them in one family.
 * The report prints these outcomes as a per-pair table.
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

			// A `singleton:` label embeds its own representative, so it never matches another registrant's label.
			if (familyID === undefined || familyID !== truthGroupOf.get(b)) continue

			outcomes.push({ a, b, familyID, recovered: predictedSame(a, b) })
		}
	}

	return outcomes
}

/**
 * This interface holds one linkage pass's score, leakage census and family reads.
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
	 * These counters come from the entity-resolution pass.
	 *
	 * The report shows them as context, and the prediction does not read them.
	 */
	inferred: InferredClusterResult
	census: LeakageCensus
	/**
	 * This map holds the family IDs that the prediction used for each scored registrant.
	 */
	predictedFamilyIDsOf: Map<FRN, string[]>
	/**
	 * This map holds every family ID for each scored registrant, including
	 * management-company families that the prediction ignores.
	 */
	observedFamilyIDsOf: Map<FRN, string[]>
	truthPositivePairs: TruthPositivePairOutcome[]
}

/**
 * This interface holds the options for {@linkcode runLinkagePass}.
 */
export interface LinkageEvalPassOptions {
	inputs: LinkageEvalInputs
	registrants: readonly LinkageEvalRegistrant[]
	truthGroupOf: ReadonlyMap<FRN, string>
	label: string
	/**
	 * When this flag is true, the pass runs {@linkcode assertNoOwnershipLeak} on the build.
	 */
	holdingCompanyWithheld: boolean
	/**
	 * This callback writes evidence into the artifact after the leakage check
	 * and before the prediction is read.
	 *
	 * Tests use it to simulate an evidence channel that does not exist yet.
	 * The published eval never sets it.
	 *
	 * The leakage check covers only the builder's output, so a probe can add
	 * ownership facts without tripping the check.
	 */
	injectEvidence?: (db: DatabaseClient<FilerDatabase>) => Promise<void>
}

/**
 * This function runs one linkage pass.
 *
 * It builds a scratch `filer.db` from one set of inputs, runs the shipped clustering,
 * takes the leakage census, reads each registrant's families, and scores the prediction.
 * Tests call it with injected evidence so that they exercise the same code path.
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

	// The leakage check covers only the builder's output.
	// The reported census is taken after injection so that it counts every row the prediction scores.
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
 * This interface holds the options for {@linkcode filerLinkageEval}.
 */
export interface FilerLinkageEvalOptions {
	/**
	 * When this path is set, the eval also writes the markdown report to it.
	 */
	outMd?: string
	/**
	 * This date replaces the date in the report's H1, which defaults to today.
	 *
	 * Scorecard regeneration and reproducibility tests set it so that the markdown
	 * does not depend on the current date.
	 */
	date?: string
	/**
	 * The eval prints the markdown to stdout unless this flag is `false`.
	 *
	 * Printing is the default because the markdown is the CLI's only output.
	 */
	printMarkdown?: boolean
}

/**
 * This interface holds both runs of {@linkcode filerLinkageEval}.
 *
 * The control run gives the withheld score its meaning, so a caller should report both.
 */
export interface FilerLinkageEvalResult {
	markdown: string
	withheld: LinkageEvalRun
	control: LinkageEvalRun
	registrants: LinkageEvalRegistrant[]
	truthGroupOf: Map<FRN, string>
}

/**
 * This function runs the corporate-family recovery eval.
 *
 * It builds two scratch `filer.db` artifacts from one corpus, one with
 * `holdingCompany` withheld and one with it intact.
 * It scores each against the held-out truth and renders the markdown scorecard.
 * The file `linkage-eval.md` describes the experiment design.
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
