/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Present source-register jurisdictions across twelve distinct coverage stages.
 *   Census data supplies corpus, admission, board, gazetteer, and package readings;
 *   the register supplies the denominator, including jurisdictions absent from the census.
 *   `absent` is measured absence; `unknown` means this checkout cannot answer.
 *   Stages describe different source populations and must not be read as one pipeline.
 *   Opportunity candidates use source research and corpus presence, not existing coverage.
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
 *
 * `absent` is measured; `unknown` means the stage could not be measured.
 */
export const StageState = {
	Reached: "reached",
	Absent: "absent",
	/**
	 * Reached, but a measured condition blocks progress.
	 */
	Blocked: "blocked",
	/**
	 * This instrument cannot measure the stage from a checkout.
	 */
	Unknown: "unknown",
} as const

export type StageState = (typeof StageState)[keyof typeof StageState]

/**
 * Twelve coverage stages; source-register, corpus, and evaluation stages are distinct populations.
 *
 * Ingestion requires license, address role, and measured coverage.
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

export interface StageReading {
	state: StageState
	/**
	 * What the reading rests on, or what would make an `unknown` answerable.
	 *
	 * Always present: a bare state invites the reader to supply a reason of their own.
	 */
	detail: string
}

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

export interface CoverageFunnel {
	rows: readonly JurisdictionFunnelRow[]
	/**
	 * Jurisdiction counts by stage state, using the register denominator.
	 */
	byStage: Record<FunnelStage, Record<StageState, number>>
	provenance: {
		registerVersion: string
		jurisdictions: number
		/**
		 * Countries represented in the census report.
		 */
		censusCountries: number
		mixtureAudit: string | null
	}
}

export interface CoverageFunnelInput {
	/**
	 * Per-country rows from `censusCoverage`, keyed here by ISO-2.
	 */
	coverage: readonly CountryCoverage[]
	register?: AddressSourceRegister
	/**
	 * Countries any `scope.config.json` tier names.
	 */
	tieredCountries: readonly string[]
	/**
	 * Countries a named release check fails a regression on: tier 1 plus `dRuleProtected`.
	 */
	protectedCountries: readonly string[]
	/**
	 * `audit_epoch_mixture` output path; without it, sampling is unknown.
	 */
	mixtureAudit?: string
	/**
	 * Per-country rows sampled and the audit's denominator.
	 */
	sampledRows?: ReadonlyMap<string, number>
	sampledTotal?: number
}

/**
 * Read all coverage stages for jurisdictions in the source register.
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

		// Ingestion also requires each source to declare its address role and coverage.
		// `upstreamLineage` affects linkage correctness, not admission.
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

		// The corpus manifest is one of the census registers, so zero is measured absence.
		const corpusRows: StageReading = country?.corpusRows
			? {
					state: StageState.Reached,
					detail: `${country.corpusRows} corpus row(s), ${country.corpusStreetRows} carrying a street or house number`,
				}
			: { state: StageState.Absent, detail: "no corpus row carries this country" }

		const admitted: StageReading = country?.admitted
			? { state: StageState.Reached, detail: "named in the training config's country_weights" }
			: { state: StageState.Absent, detail: "absent from the training config's country_weights" }

		// Sampling is run-specific: admitted countries absent from the audit drew zero;
		// countries not admitted are absent, not sampler failures.
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

		// Both stages count gauntlet rows only, not golden, panel, or locale-probe sets.
		// `absent` therefore means no gauntlet row names this country.
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

export interface IncumbencyGroup {
	/**
	 * Number of stages reached by each jurisdiction in the group.
	 */
	reached: number
	jurisdictions: readonly string[]
}

/**
 * Group jurisdictions by stages reached, deepest first.
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
 * Filter for researched backbones with no corpus rows; this is not a ranking.
 *
 * Callers supply other opportunity inputs.
 * Existing packages, boards, and tiers are excluded.
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
 * Work-selection inputs and whether this instrument supplies them.
 *
 * Existing package and board coverage is excluded because it measures cost, not need.
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
