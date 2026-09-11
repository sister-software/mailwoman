/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Corporate-family linkage evaluation runner.
 *
 * Runs withheld-disclosure and control builds against the shipped family reader. See `linkage-eval.md` for the
 * measurement contract, truth unit, and leakage controls.
 */

import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { changeMode, writeLocalFile } from "@mailwoman/core/fs/writers"
import { isoDate } from "@mailwoman/core/utils"
import { DatabaseClient } from "@mailwoman/sqlite/client"
import { join } from "path-ts"

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
} from "#tools/linkage/corpus"
import { groupPredicateFromMap, scorePairwiseGrouping, type PairwiseGroupingScore } from "#tools/linkage/metrics"
import { renderLinkageEvalReport } from "#tools/linkage/report"

/**
 * `sourceVintage`/`validFrom` for the eval's own `buildFilerDatabase`/`clusterFilers` calls — FIXED constants, never
 * "today", so a re-run at a different wall-clock date builds byte-identical `filer_edge`/`filer_family` provenance
 * columns (criterion 4's reproducibility clause).
 */
const EVAL_SOURCE_VINTAGE = "2026-eval-v1"
const EVAL_VALID_FROM = "2026-01-01"

/**
 * The `asOf` date every `filer_family` read in this eval is scoped to — a FIXED constant, later than the latest
 * `lastFiledAt` in the corpus and never "today", for the same reproducibility reason as the two constants above. A
 * family membership is a temporal fact in this schema (`valid_from`/`valid_to`), so "predicted same family" is only
 * well-defined relative to a date; this is that date.
 */
const EVAL_AS_OF = "2026-06-01"

/**
 * `buildFilerDatabase`'s `buildSHA` for this eval's artifact — a fixed label (not a real `git rev-parse`) since this is
 * a synthetic, in-repo corpus with no git-tracked source file of its own to attribute the build to.
 */
const EVAL_BUILD_SHA = "filer-linkage-eval"

/**
 * What a built artifact actually contains that bears on ownership — counted, not asserted. The withheld artifact is not
 * family-row-free: two `filer_family` rows reach it from the corpus's management-company disclosures, so the one page
 * whose credibility rests on the withholding being real has to measure the artifact rather than describe it.
 *
 * **Every count here is scoped to what the PREDICTION scores, not to `holding_company` alone.** The prediction accepts
 * any `filer_family` membership whose relationship asserts OWNERSHIP — `holding_company` today,
 * `parent_company`/`subsidiary` the moment a writer emits one. Counting only `holding_company` leaves the census silent
 * about exactly the rows a future evidence channel will add: three injected `subsidiary` family rows move recall from
 * 0.000 to 0.500 while a `holding_company`-only census still reads `0`, under a heading promising the numbers were
 * counted from the build.
 */
export interface LeakageCensus {
	/**
	 * `filer_node` rows of type `holding_company_name` — one per distinct raw parent name in the input.
	 */
	holdingCompanyNodes: number
	/**
	 * `filer_edge` rows whose relationship asserts OWNERSHIP ({@linkcode OWNERSHIP_BY_RELATIONSHIP}) — today
	 * `holding_company`, and `parent_company`/`subsidiary` the moment a writer emits one. Note that an ownership EDGE
	 * alone moves no score: see {@linkcode renderWhySection}.
	 */
	ownershipEdges: number
	/**
	 * `filer_family` rows the prediction will score — every membership whose relationship asserts OWNERSHIP
	 * ({@linkcode OWNERSHIP_BY_RELATIONSHIP}). Must be 0 in the withheld build.
	 */
	scoredFamilyRows: number
	/**
	 * `filer_family` rows carrying a recognized relationship that asserts something OTHER than ownership — today that is
	 * `management_company` only, since no writer emits a `same_entity` family row. Non-zero in BOTH runs:
	 * `managementCompany` is not the field under test, and the prediction ignores these.
	 */
	nonOwnershipFamilyRows: number
	/**
	 * `filer_family` rows whose relationship is not a {@linkcode FilerRelationship} value at all — impossible from any
	 * shipped writer, so a non-zero count means a row this build did not write. Counted separately rather than folded
	 * into either bucket, and the check REFUSES on it: an assertion the eval cannot classify is exactly what a leakage
	 * check should stop on, not something to file under "not ownership" and pass.
	 */
	unrecognizedFamilyRows: number
	/**
	 * Every `filer_family` row in the artifact. Published alongside the splits so a relationship class nobody anticipated
	 * cannot hide between them — and, since the three splits are exhaustive by construction, so the reader can check they
	 * sum to this.
	 */
	familyRows: number
}

/**
 * Whether each {@linkcode FilerRelationship} asserts OWNERSHIP — the thing this eval withholds and scores — as opposed
 * to operational control or plain identity.
 *
 * **Exhaustive by construction, and that is the point.** Expressed the obvious way — two DENYLISTS typed `readonly
 * string[]`, naming the relationships that don't count — a relationship class added to `FilerRelationship` later falls
 * through to "counts as ownership" silently, in BOTH the prediction and the leakage census, scoring a fact nobody
 * decided should be scored and doing it without a test failing. The `satisfies Record<FilerRelationship, boolean>` pin
 * below inverts that default: a new member is a COMPILE error here until someone classifies it deliberately. Same idiom
 * the BDC plausibility check uses (`bdc/sdk/plausibility.test.ts`'s `satisfies Record<keyof PlausibilityBundle,
 * true>`). Unlike the `satisfies` pins that live in TEST files — which only `yarn typecheck:tests` evaluates — this one
 * sits in a source file inside `filer/tsconfig.json`'s default include, so plain `tsc -b` enforces it: dropping a
 * member fails with TS1360 naming the missing relationship.
 *
 * `SameEntity` is false because two identifiers denoting ONE filer say nothing about who owns it; `ManagementCompany`
 * because operational control is not ownership (spec §3.1 finding 1, and the reason this eval excludes management
 * families from both prediction and truth). `HoldingCompany`, `ParentCompany` and `Subsidiary` each assert an ownership
 * relation between two DIFFERENT entities, which is exactly what a withheld-parent run must not be able to see.
 */
const OWNERSHIP_BY_RELATIONSHIP = {
	[FilerRelationship.SameEntity]: false,
	[FilerRelationship.ManagementCompany]: false,
	[FilerRelationship.HoldingCompany]: true,
	[FilerRelationship.ParentCompany]: true,
	[FilerRelationship.Subsidiary]: true,
	// Identity continuity over time, not control. A supersession chain says one registration became
	// another; scoring it as ownership would let a withheld-parent run credit itself for recovering a
	// family fact it never saw. Operator ruling, 2026-08-07 — see FilerRelationship.SupersededBy.
	[FilerRelationship.SupersededBy]: false,
} as const satisfies Record<FilerRelationship, boolean>

/**
 * Does this relationship assert ownership? Single source of truth for {@linkcode readLeakageCensus}'s "scored" count
 * and {@linkcode readRegistrantFamilies}'s filter, so the census can never promise to police rows the prediction
 * quietly scored, or vice versa. An unrecognized value is treated as NON-ownership: it cannot come from
 * `FilerRelationship` (the pin above makes that a compile error), so it is a raw string read back from a
 * `filer_family`/`filer_edge` row this build did not write, and silently scoring an unknown assertion as ownership is
 * the failure this exists to stop.
 *
 * **The {@linkcode isRecognizedRelationship} guard is required, not belt-and-braces.** `OWNERSHIP_BY_RELATIONSHIP` is a
 * plain object literal, so a bare index lookup inherits `Object.prototype`: `relationship === "constructor"` (or
 * `"toString"`, or `"__proto__"`) resolves to a FUNCTION, which is truthy and never nullish, so `??` does not fire and
 * the lookup answers `true` for a string it does not classify — the precise failure the paragraph above says it exists
 * to stop. Measured through the real builder: three injected `constructor` family rows score as ownership AND land in
 * the unrecognized bucket, so the three census splits sum to 8 against a published total of 5.
 */
function assertsOwnership(relationship: string): boolean {
	return isRecognizedRelationship(relationship) && OWNERSHIP_BY_RELATIONSHIP[relationship as FilerRelationship]
}

/**
 * Is this relationship one {@linkcode OWNERSHIP_BY_RELATIONSHIP} actually classifies? Distinct from
 * {@linkcode assertsOwnership} because the PREDICTION and the CHECK want opposite defaults for a string neither
 * recognizes, and one predicate cannot serve both.
 *
 * The prediction must not score an assertion it does not understand, so unknown → not ownership → ignored. The check
 * exists to REFUSE publication when the withheld build holds ownership facts it should never have seen, and "a
 * relationship this eval does not recognize, in a build it did not write" is precisely the case it should refuse rather
 * than quietly bucket as non-ownership. Collapse the two call sites onto `assertsOwnership` alone and the check narrows
 * to nothing on exactly that case: three injected `transfer_of_control` family rows leave `scoredFamilyRows: 0` and the
 * check silent.
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
 * Hard check on the withheld build (decision 4). The leakage exclusion is structural —
 * {@linkcode buildFilteredEvalInputs} is the only thing that builds what the builder receives — but "structural" is an
 * argument, and this is a check: if any ownership artifact survives into the withheld build, the eval refuses to report
 * a number rather than reporting a flattered one. Runs against the census taken straight off the BUILD, before any
 * injected evidence, so a deliberate probe can still be measured without disarming the check.
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
 * Every `filer_family` family a registrant's nodes belong to, split into the ones the prediction uses and the full set.
 */
interface RegistrantFamilies {
	/**
	 * Family ids the prediction treats as evidence of shared ownership — everything except a membership this node holds
	 * only by way of a relationship that does not assert ownership (see the module docstring).
	 */
	predicted: Map<FRN, string[]>
	/**
	 * Every family id any of the registrant's nodes belongs to, management included. Reported, never scored.
	 */
	observed: Map<FRN, string[]>
}

/**
 * Read each registrant's corporate-family memberships through the SHIPPED reader (`familyRollup`), at
 * {@linkcode EVAL_AS_OF}. This is the eval's entire prediction: no query is written here that a product caller couldn't
 * make, and nothing about the clustering output is consulted.
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
			for (const rollup of await familyRollup(db, { nodeID, asOf: EVAL_AS_OF })) {
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
 * One truth-positive pair (two registrants the withheld `holdingCompany` field puts in the same real family) and
 * whether the run recovered it — the report's per-pair table.
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

			// A `singleton:` label embeds its own representative, so it can never equal another registrant's label —
			// no separate singleton check is needed here.
			if (familyID === undefined || familyID !== truthGroupOf.get(b)) continue

			outcomes.push({ a, b, familyID, recovered: predictedSame(a, b) })
		}
	}

	return outcomes
}

export interface LinkageEvalRun {
	/**
	 * `"withheld"` or `"control"`.
	 */
	label: string
	/**
	 * Whether `holdingCompany` was cleared from this run's input.
	 */
	holdingCompanyWithheld: boolean
	inputsSHA256: string
	score: PairwiseGroupingScore
	/**
	 * The entity-resolution pass's own counters. Reported as context — this eval's prediction does not read its output.
	 */
	inferred: InferredClusterResult
	census: LeakageCensus
	/**
	 * Per scored registrant, the family ids the prediction used.
	 */
	predictedFamilyIDsOf: Map<FRN, string[]>
	/**
	 * Per scored registrant, every family id `filer_family` places its nodes in — including the management-company
	 * families the prediction deliberately ignores.
	 */
	observedFamilyIDsOf: Map<FRN, string[]>
	truthPositivePairs: TruthPositivePairOutcome[]
}

/**
 * {@linkcode runLinkagePass}'s arguments.
 */
export interface LinkageEvalPassOptions {
	inputs: LinkageEvalInputs
	registrants: readonly LinkageEvalRegistrant[]
	truthGroupOf: ReadonlyMap<FRN, string>
	label: string
	/**
	 * Whether `holdingCompany` was cleared from `inputs`. Arms {@linkcode assertNoOwnershipLeak}.
	 */
	holdingCompanyWithheld: boolean
	/**
	 * Writes evidence into the built artifact AFTER the leakage check has passed and BEFORE the prediction is read — the
	 * injection point the standing "this baseline can be beaten" test uses to simulate an evidence channel that does not
	 * exist yet. Never set by {@linkcode filerLinkageEval} itself: the two published runs measure builds nobody touched.
	 * Ordering is the point — the check still polices what the BUILDER produced from a withheld input, so a probe can add
	 * ownership facts without disarming it.
	 */
	injectEvidence?: (db: DatabaseClient<FilerDatabase>) => Promise<void>
}

/**
 * One pass: build a scratch `filer.db` from one projection, run the shipped clustering over it, census it, read each
 * registrant's corporate families, score. Exported so a test can run the SAME code path with injected evidence rather
 * than reimplementing the pipeline beside it.
 */
export async function runLinkagePass(options: LinkageEvalPassOptions): Promise<LinkageEvalRun> {
	const { inputs, registrants, truthGroupOf, label, holdingCompanyWithheld, injectEvidence } = options

	await using scratch = await temporaryDirectory(`filer-linkage-eval-${label}-`)
	const out = join(scratch.path, "filer.db")

	await buildFilerDatabase({
		form499Rows: inputs.form499Rows,
		providerRows: inputs.providerRows,
		out,
		sourceVintage: EVAL_SOURCE_VINTAGE,
		validFrom: EVAL_VALID_FROM,
		buildSHA: EVAL_BUILD_SHA,
	})

	// buildFilerDatabase seals the artifact read-only — clusterFilers writes filer_cluster/filer_edge, so unseal
	// first (mirrors filer-lookup.test.ts's "REAL builder + REAL clusterAuthoritativeComponents" check).
	await changeMode(out, 0o644)

	using db = new DatabaseClient<FilerDatabase>(out)

	// Run the full shipped pipeline, not just the builder — the entity-resolution pass is part of what produces a
	// real filer.db, and its counters belong in the report even though this eval scores a different table.
	const { inferred } = await clusterFilers(db, { sourceVintage: EVAL_SOURCE_VINTAGE, validFrom: EVAL_VALID_FROM })

	// Check the BUILD, then inject, then census what will actually be scored. Taking one census for both jobs is what
	// let three injected `subsidiary` family rows move recall to 0.500 while the published census still read 0.
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

export interface FilerLinkageEvalOptions {
	/**
	 * Also write the markdown report here.
	 */
	outMd?: string
	/**
	 * Overrides the report's dated H1 — for regenerating the committed scorecard on a later day, and for reproducibility
	 * tests that need byte-identical markdown across two runs that don't fall on the same wall-clock date. Without it the
	 * report cannot be regenerated without editing code. Defaults to today.
	 */
	date?: string
	/**
	 * Print the markdown to stdout. Defaults to `true` — the CLI's whole output. Tests pass `false`.
	 */
	printMarkdown?: boolean
}

/**
 * {@linkcode filerLinkageEval}'s return value — both runs, always. There is no single "the score": the withheld run is
 * the measurement and the control run is what makes it mean anything, and a caller that reports one without the other
 * is reporting half a result.
 */
export interface FilerLinkageEvalResult {
	markdown: string
	withheld: LinkageEvalRun
	control: LinkageEvalRun
	registrants: LinkageEvalRegistrant[]
	truthGroupOf: Map<FRN, string>
}

/**
 * Run the corporate-family recovery eval — see the module docstring for the experiment design. Builds two scratch
 * `filer.db` artifacts from the same corpus (one with `holdingCompany` withheld, one without), scores each against the
 * held-out truth, and renders the markdown scorecard.
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
