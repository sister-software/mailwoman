/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The funnel from every jurisdiction the source register knows to the few a release check protects, over one
 *   denominator.
 *
 *   `#coverage/census` already assembles five registers — corpus rows, `country_weights` admission, the gauntlet
 *   board, the serving gazetteer, and the published weights packages — into one row per country, and names five ways
 *   they disagree. This module reads that report rather than recomputing it, and changes two things about how it is
 *   presented.
 *
 *   The first is the denominator. `censusCoverage` takes the union of the five registers' keys, so its row set is
 *   every country that appears in at least one of them. A jurisdiction in none of the five is absent from the report
 *   entirely, which is the shape this module exists to correct: a country with no corpus, no board and no package
 *   produces no row, and a reader scanning for failures sees nothing rather than seeing an unmeasured jurisdiction.
 *   Here the denominator is the source register's 250 records, and a jurisdiction the census never reached still gets
 *   a row stating that at every stage.
 *
 *   The second is that a stage may decline to answer. {@linkcode StageState.Unknown} is this instrument saying it
 *   cannot measure the stage from a checkout, with the reason attached, and it is never a statement about the
 *   jurisdiction. `absent` is the measured negative. Collapsing the two would print "we cannot see whether this
 *   country is evaluated" as "this country is not evaluated", which is the reading that makes an unmeasured
 *   jurisdiction look solved. The rule is `docs/engineering/reference/the-meaning-of-zero.mdx`.
 *
 *   Nothing here ranks. {@linkcode OPPORTUNITY_INPUTS} lists what a work-selection ranking reads and marks which of
 *   those this instrument supplies, because a ranking that scored coverage as need would reproduce the selection the
 *   funnel exists to expose.
 */

import {
	type AddressSourceRegister,
	JurisdictionResearchState,
	LicenseReviewState,
	readAddressSourceRegister,
} from "@mailwoman/corpus/source-register"

import type { CountryCoverage } from "#coverage/census"

/**
 * What one jurisdiction's stage reads.
 *
 * `absent` and `unknown` are the pair this report keeps apart. `absent` means the funnel looked and the stage is not
 * reached. `unknown` means the funnel declined, and the reason says what answering would take.
 */
export const StageState = {
	Reached: "reached",
	Absent: "absent",
	/**
	 * Reached, and a named condition prevents the next stage. A researched absence and a source with no elected terms are
	 * both this rather than `absent`: somebody looked, and what they found is the finding.
	 */
	Blocked: "blocked",
	/**
	 * This instrument cannot measure the stage from a checkout.
	 */
	Unknown: "unknown",
} as const

export type StageState = (typeof StageState)[keyof typeof StageState]

/**
 * The ten stages, in the order a jurisdiction passes through them.
 */
export const FUNNEL_STAGES = [
	"researched",
	"licensed",
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
	 * What the reading rests on, or what would make an `unknown` answerable. Always present: a bare state invites the
	 * reader to supply a reason of their own.
	 */
	detail: string
}

export interface JurisdictionFunnelRow {
	iso2: string
	name: string
	/**
	 * The register's research state for this jurisdiction's own premise-address backbone — `A`, `A~`, `B`, `C` or `D`. A
	 * backlog position rather than a quality score, and deliberately not called a tier.
	 */
	backboneState: string
	stages: Record<FunnelStage, StageReading>
	/**
	 * How many of the ten stages read `reached`. The incumbency view groups on this.
	 */
	reached: number
}

export interface CoverageFunnel {
	rows: readonly JurisdictionFunnelRow[]
	/**
	 * Per stage, how many jurisdictions read each state, over the register's own denominator.
	 */
	byStage: Record<FunnelStage, Record<StageState, number>>
	provenance: {
		registerVersion: string
		jurisdictions: number
		/**
		 * Jurisdictions the census report carried a row for. The difference between this and `jurisdictions` is what the
		 * union denominator drops.
		 */
		censusCountries: number
		mixtureAudit: string | null
	}
}

export interface CoverageFunnelInput {
	/**
	 * `censusCoverage`'s per-country rows. Keyed by ISO alpha-2 here, and a jurisdiction missing from it reads as a
	 * jurisdiction the five registers never mention.
	 */
	coverage: readonly CountryCoverage[]
	register?: AddressSourceRegister
	/**
	 * Countries any `scope.config.json` tier names.
	 */
	tieredCountries: readonly string[]
	/**
	 * Countries a named release check protects: tier 1 plus `dRuleProtected`.
	 */
	protectedCountries: readonly string[]
	/**
	 * An `audit_epoch_mixture` output path. Without one the `sampled` stage reads `unknown`, because how many rows a
	 * country contributes per epoch is a property of a run rather than of a checkout.
	 */
	mixtureAudit?: string
	/**
	 * Rows sampled per country in one epoch, and the epoch's own denominator, when a mixture audit supplied them.
	 */
	sampledRows?: ReadonlyMap<string, number>
	sampledTotal?: number
}

/**
 * Read the ten-stage funnel over every jurisdiction the source register carries.
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

		// The census counts a country's rows from the corpus manifest. A jurisdiction absent from the census report is
		// absent from all five of its registers, which includes the corpus, so zero rows is the measured reading.
		const corpusRows: StageReading = country?.corpusRows
			? {
					state: StageState.Reached,
					detail: `${country.corpusRows} corpus row(s), ${country.corpusStreetRows} carrying a street or house number`,
				}
			: { state: StageState.Absent, detail: "no corpus row carries this country" }

		const admitted: StageReading = country?.admitted
			? { state: StageState.Reached, detail: "named in the training config's country_weights" }
			: { state: StageState.Absent, detail: "absent from the training config's country_weights" }

		// How many rows a country contributes to an epoch is decided by the sampler at run time, not by the config: a
		// country admitted at weight 1.0 whose sources hold no rows samples nothing. Printing `absent` without a mixture
		// audit would claim that outcome for every country.
		const sampledCount = input.sampledRows?.get(iso2)

		const sampled: StageReading =
			sampledCount === undefined
				? {
						state: StageState.Unknown,
						detail: "no audit_epoch_mixture output supplied — pass one to answer this stage",
					}
				: sampledCount > 0
					? {
							state: StageState.Reached,
							detail: `${sampledCount} row(s) sampled of ${input.sampledTotal ?? "an unreported"} in the epoch`,
						}
					: {
							state: StageState.Blocked,
							detail: "admitted and sampled zero rows in the audited epoch",
						}

		const boardRows = country?.boardRows ?? 0
		const checkingRows = country?.boardPassedRows ?? 0

		const evaluated: StageReading = boardRows
			? { state: StageState.Reached, detail: `${boardRows} board row(s)` }
			: { state: StageState.Absent, detail: "no board row names this country" }

		const checking: StageReading = checkingRows
			? { state: StageState.Reached, detail: `${checkingRows} of ${boardRows} board row(s) check` }
			: boardRows
				? {
						state: StageState.Blocked,
						detail: `${boardRows} board row(s), none of which check — no regression here can fail`,
					}
				: { state: StageState.Absent, detail: "no board row to check" }

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
	 * How many of the ten stages the jurisdictions in this group reached.
	 */
	reached: number
	jurisdictions: readonly string[]
}

/**
 * Jurisdictions grouped by how many stages they reached, deepest first.
 *
 * The group a roadmap item was selected from is what this view exists to make visible. A repository cannot derive that
 * selection, so the caller states it beside the groups rather than this function inferring it.
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
 * The inputs a work-selection ranking reads, and which of them this instrument supplies today.
 *
 * Existing package and board coverage is absent from this list by design. It reduces what a piece of work costs, and
 * reading it as need would rank the jurisdictions already measured above the ones nobody has measured — the selection
 * the funnel exists to expose.
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
