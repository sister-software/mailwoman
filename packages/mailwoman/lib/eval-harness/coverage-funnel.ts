/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Coverage funnel that reads every source-register jurisdiction at each coverage stage. The register supplies the
 *   denominator, so jurisdictions missing from the census still appear. The stages measure different populations, so
 *   a later stage can be reached while an earlier one is absent.
 */

import {
	type AddressSourceRegister,
	JurisdictionResearchState,
	LicenseReviewState,
	readAddressSourceRegister,
} from "@mailwoman/corpus/source-register"

import type { CountryCoverage } from "#coverage/census"

/**
 * State of a jurisdiction at one stage.
 * The state `absent` is a measured absence.
 */
export const StageState = {
	Reached: "reached",
	Absent: "absent",
	/**
	 * The jurisdiction has inputs for the stage, and a measured condition blocks it.
	 */
	Blocked: "blocked",
	/**
	 * The stage cannot be measured from the supplied inputs.
	 */
	Unknown: "unknown",
} as const

export type StageState = (typeof StageState)[keyof typeof StageState]

/**
 * Coverage stages in report order.
 *
 * The `licensed`, `addressRole`, and `coverage` stages are all required for ingestion.
 */
export const FUNNEL_STAGES = [
	"researched",
	"licensed",
	"addressRole",
	"coverage",
	"corpusRows",
	"admitted",
	"sampled",
	"evaluated",
	"checking",
	"packaged",
	"claimed",
	"protected",
] as const

export type FunnelStage = (typeof FUNNEL_STAGES)[number]

/**
 * State of one jurisdiction at one stage.
 */
export interface StageReading {
	state: StageState
	/**
	 * Evidence for the state.
	 * For `unknown`, it says which input would answer the stage.
	 */
	detail: string
}

/**
 * Funnel readings for one jurisdiction.
 */
export interface JurisdictionFunnelRow {
	iso2: string
	name: string
	/**
	 * Source-register research state for the premise-address backbone.
	 */
	backboneState: string
	stages: Record<FunnelStage, StageReading>
	/**
	 * Number of stages marked `reached`.
	 */
	reached: number
}

/**
 * Funnel for every jurisdiction in the source register.
 */
export interface CoverageFunnel {
	rows: readonly JurisdictionFunnelRow[]
	/**
	 * Number of jurisdictions in each state at each stage.
	 */
	byStage: Record<FunnelStage, Record<StageState, number>>
	provenance: {
		registerVersion: string
		jurisdictions: number
		/**
		 * Number of countries in the census report.
		 */
		censusCountries: number
		mixtureAudit: string | null
	}
}

/**
 * Inputs for {@link readCoverageFunnel}.
 */
export interface CoverageFunnelInput {
	/**
	 * Per-country rows from `censusCoverage`.
	 */
	coverage: readonly CountryCoverage[]
	register?: AddressSourceRegister
	/**
	 * Countries that any `scope.config.json` tier lists.
	 */
	tieredCountries: readonly string[]
	/**
	 * Countries where a named release check fails on regression.
	 * These are tier 1 and `dRuleProtected` countries.
	 */
	protectedCountries: readonly string[]
	/**
	 * Path of the `audit_epoch_mixture` output, recorded in the provenance.
	 */
	mixtureAudit?: string
	/**
	 * Rows sampled per country and the audit's total.
	 *
	 * The `sampled` stage is `unknown` when `sampledRows` is absent.
	 */
	sampledRows?: ReadonlyMap<string, number>
	sampledTotal?: number
}

/**
 * Reads every coverage stage for each jurisdiction in the source register.
 */
export async function readCoverageFunnel(input: CoverageFunnelInput): Promise<CoverageFunnel> {
	const register = input.register ?? (await readAddressSourceRegister())

	const coverageByCountry = new Map(input.coverage.map((entry) => [entry.country, entry]))
	const licenseByID = new Map(register.licenses.map((decision) => [decision.licenseID, decision]))

	const sourcesByJurisdiction = new Map<string, (typeof register.sources)[number][]>()

	for (const source of register.sources) {
		sourcesByJurisdiction.set(source.iso2, [...(sourcesByJurisdiction.get(source.iso2) ?? []), source])
	}

	const tiered = new Set(input.tieredCountries)
	const guarded = new Set(input.protectedCountries)

	const rows: JurisdictionFunnelRow[] = register.jurisdictions.map((jurisdiction) => {
		const iso2 = jurisdiction.iso2
		const sources = sourcesByJurisdiction.get(iso2) ?? []
		const country = coverageByCountry.get(iso2)

		const researched: StageReading =
			jurisdiction.researchState === JurisdictionResearchState.Unexamined
				? { state: StageState.Absent, detail: "nothing resolved and nothing ruled out" }
				: jurisdiction.researchState === JurisdictionResearchState.Exception
					? { state: StageState.Blocked, detail: "researched absence — no ordinary national registry exists" }
					: { state: StageState.Reached, detail: `${sources.length} source(s) resolved` }

		const elected = sources.filter((source) => licenseByID.get(source.license)?.state === LicenseReviewState.Elected)

		const licensed: StageReading = elected.length
			? { state: StageState.Reached, detail: `${elected.length} of ${sources.length} source(s) elected` }
			: sources.length
				? {
						state: StageState.Blocked,
						detail: `${sources.length} source(s), none with elected terms — none is ingest-eligible`,
					}
				: { state: StageState.Absent, detail: "no source to license" }

		// Ingestion requires a declared address role and measured coverage.
		// The `upstreamLineage` field affects linkage and plays no part in admission.
		const withRole = sources.filter((source) => source.addressRole !== undefined)
		const withCoverage = sources.filter((source) => source.coverage !== undefined)

		const addressRole: StageReading = !sources.length
			? { state: StageState.Absent, detail: "no source to resolve a role for" }
			: withRole.length
				? { state: StageState.Reached, detail: `${withRole.length} of ${sources.length} source(s) resolve a role` }
				: {
						state: StageState.Blocked,
						detail: `${sources.length} source(s), none resolving an address role — the grammar their rows carry is unknown`,
					}

		const coverage: StageReading = !sources.length
			? { state: StageState.Absent, detail: "no source to measure coverage for" }
			: withCoverage.length
				? {
						state: StageState.Reached,
						detail: `${withCoverage.length} of ${sources.length} source(s) measure coverage`,
					}
				: {
						state: StageState.Blocked,
						detail: `${sources.length} source(s), none with measured coverage`,
					}

		// The census reads the corpus manifest, so zero rows is a measured absence.
		const corpusRows: StageReading = country?.corpusRows
			? {
					state: StageState.Reached,
					detail: `${country.corpusRows} corpus row(s), ${country.corpusStreetRows} carrying a street or house number`,
				}
			: { state: StageState.Absent, detail: "no corpus row carries this country" }

		const admitted: StageReading = country?.admitted
			? { state: StageState.Reached, detail: "named in the training config's country_weights" }
			: { state: StageState.Absent, detail: "absent from the training config's country_weights" }

		// An admitted country missing from the audit drew zero rows and is blocked.
		// A country that is not admitted is absent because the sampler had nothing to draw.
		const sampledCount = input.sampledRows?.get(iso2)

		const sampled: StageReading = !input.sampledRows
			? {
					state: StageState.Unknown,
					detail: "no audit_epoch_mixture output supplied — pass one to answer this stage",
				}
			: sampledCount
				? {
						state: StageState.Reached,
						detail: `${sampledCount} row(s) drawn of ${input.sampledTotal ?? "an unreported number"} audited`,
					}
				: country?.admitted
					? {
							state: StageState.Blocked,
							detail: `admitted, and drew 0 of the ${input.sampledTotal ?? "audited"} rows sampled`,
						}
					: {
							state: StageState.Absent,
							detail: "not admitted by the training config, so it has nothing to draw",
						}

		// Both stages count gauntlet board rows only.
		// Golden, panel, and locale-probe sets are excluded.
		const boardRows = country?.boardRows ?? 0
		const checkingRows = country?.boardPassedRows ?? 0

		const evaluated: StageReading = boardRows
			? { state: StageState.Reached, detail: `${boardRows} gauntlet board row(s)` }
			: { state: StageState.Absent, detail: "no gauntlet board row names this country" }

		const checking: StageReading = checkingRows
			? { state: StageState.Reached, detail: `${checkingRows} of ${boardRows} gauntlet row(s) check` }
			: boardRows
				? {
						state: StageState.Blocked,
						detail: `${boardRows} gauntlet row(s), none of which check — no regression here can fail`,
					}
				: { state: StageState.Absent, detail: "no gauntlet board row to check" }

		const packaged: StageReading = country?.weightsPackage
			? { state: StageState.Reached, detail: country.weightsPackage }
			: { state: StageState.Absent, detail: "no published weights overlay scopes this country" }

		const claimed: StageReading = tiered.has(iso2)
			? { state: StageState.Reached, detail: "named in scope.config.json tiers" }
			: { state: StageState.Absent, detail: "no tier claims this country" }

		const isProtected: StageReading = guarded.has(iso2)
			? { state: StageState.Reached, detail: "tier 1 or dRuleProtected" }
			: { state: StageState.Absent, detail: "no named release check protects it" }

		const stages: Record<FunnelStage, StageReading> = {
			researched,
			licensed,
			addressRole,
			coverage,
			corpusRows,
			admitted,
			sampled,
			evaluated,
			checking,
			packaged,
			claimed,
			protected: isProtected,
		}

		return {
			iso2,
			name: jurisdiction.name,
			backboneState: jurisdiction.backboneState,
			stages,
			reached: FUNNEL_STAGES.filter((stage) => stages[stage].state === StageState.Reached).length,
		}
	})

	const byStage = Object.fromEntries(
		FUNNEL_STAGES.map((stage) => [
			stage,
			Object.fromEntries(
				Object.values(StageState).map((state) => [
					state,
					rows.filter((row) => row.stages[stage].state === state).length,
				])
			) as Record<StageState, number>,
		])
	) as Record<FunnelStage, Record<StageState, number>>

	return {
		rows,
		byStage,
		provenance: {
			registerVersion: register.version,
			jurisdictions: rows.length,
			censusCountries: coverageByCountry.size,
			mixtureAudit: input.mixtureAudit ?? null,
		},
	}
}

/**
 * Jurisdictions that reached the same number of stages.
 */
export interface IncumbencyGroup {
	/**
	 * Number of stages that each jurisdiction in the group reached.
	 */
	reached: number
	jurisdictions: readonly string[]
}

/**
 * Groups jurisdictions by the number of stages reached, highest first.
 */
export function incumbencyGroups(funnel: CoverageFunnel): readonly IncumbencyGroup[] {
	const byDepth = new Map<number, string[]>()

	for (const row of funnel.rows) {
		byDepth.set(row.reached, [...(byDepth.get(row.reached) ?? []), row.iso2])
	}

	return [...byDepth.entries()]
		.toSorted(([left], [right]) => right - left)
		.map(([reached, jurisdictions]) => ({ reached, jurisdictions: jurisdictions.toSorted() }))
}

/**
 * Jurisdiction with a researched address backbone and no corpus rows.
 */
export interface OpportunityCandidate {
	iso2: string
	name: string
	/**
	 * Research state of the premise-address backbone.
	 */
	backboneState: string
	/**
	 * Whether the training config admits this country.
	 */
	admitted: boolean
	licensed: boolean
}

/**
 * Lists jurisdictions whose backbone state is in `backboneStates` and that have no corpus rows.
 *
 * The result is sorted by the order of `backboneStates` and then by ISO code.
 * The sort order carries no priority.
 */
export function opportunityCandidates(
	funnel: CoverageFunnel,
	backboneStates: readonly string[] = ["A", "A~"]
): readonly OpportunityCandidate[] {
	const rank = new Map(backboneStates.map((state, index) => [state, index]))

	return funnel.rows
		.filter((row) => rank.has(row.backboneState) && row.stages.corpusRows.state !== StageState.Reached)
		.map((row) => ({
			iso2: row.iso2,
			name: row.name,
			backboneState: row.backboneState,
			admitted: row.stages.admitted.state === StageState.Reached,
			licensed: row.stages.licensed.state === StageState.Reached,
		}))
		.toSorted(
			(left, right) =>
				(rank.get(left.backboneState) ?? 0) - (rank.get(right.backboneState) ?? 0) ||
				left.iso2.localeCompare(right.iso2)
		)
}

/**
 * Inputs for choosing coverage work, and whether the funnel supplies each one.
 */
export const OPPORTUNITY_INPUTS = [
	{
		input: "source availability and terms",
		supplied: true,
		from: "the funnel's `researched` and `licensed` stages",
	},
	{
		input: "current failure evidence",
		supplied: true,
		from: "the funnel's `checking` stage, which separates a failing board from an absent one",
	},
	{
		input: "address-system diversity",
		supplied: false,
		from: "@mailwoman/codex address-system coverage, once #2276's typology lands",
	},
	{
		input: "user need",
		supplied: false,
		from: "outside this repository — query volume or an operator judgement, recorded per decision",
	},
	{
		input: "the new capability the work would add",
		supplied: false,
		from: "stated per candidate rather than derived",
	},
] as const
