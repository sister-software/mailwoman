/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The funnel from every jurisdiction the source register knows to the few a named release check would fail a
 *   regression on, over one denominator.
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
 *   Each stage's own scope is narrower than its name, so every reading states what it read. `evaluated` and `checking`
 *   count gauntlet board rows. `corpusRows` counts what the corpus manifest the census read carries. `admitted`
 *   describes the one training config named in the provenance block. A reader comparing two runs of this report
 *   compares their provenance blocks first.
 *
 *   The twelve stages are not one pipeline, and reading them as one would be the mistake this report most invites.
 *   `licensed`, `addressRole` and `coverage` describe the SOURCE REGISTER's 389 researched sources. `corpusRows`,
 *   `admitted` and `sampled` describe the TRAINING CORPUS, which is fed by adapters and carries its own per-row
 *   `SourceProvenance.license`. The two populations overlap without matching: NPPES is `us-health-1` in the register
 *   and `usgov-nppes` at weight 2.0 in the training config, while TIGER and the National Address Database feed the
 *   corpus and appear in no register row. So a jurisdiction does not pass from `licensed` into `corpusRows` — it holds
 *   both readings at once, about different sets of sources.
 *
 *   That is why the United States reads 9 of 12: 487,234,195 corpus rows and a published package, and 23 registered
 *   sources of which none is ingest-eligible. The register describes what could be ingested next rather than what
 *   trains today. #2323's second task, retiring `SourceProvenance.license` for a `licenseID` into the register, is
 *   what would make the two one population and these twelve stages one sequence.
 *
 *   Nothing here scores need. {@linkcode OPPORTUNITY_INPUTS} lists the five inputs a work-selection ranking reads and
 *   marks the two this instrument supplies, and {@linkcode opportunityCandidates} filters on those two and orders by
 *   how far a jurisdiction's source research got. Ordering by packages, boards or tiers instead would put the
 *   jurisdictions already measured on top, which is the selection the funnel exists to expose.
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
 * `absent` and `unknown` are the pair this report keeps apart.
 * `absent` means the funnel looked and the stage is not reached.
 *
 * `unknown` means the funnel declined, and the reason says what answering would take.
 */
export const StageState = {
	Reached: "reached",
	Absent: "absent",
	/**
	 * Reached, and a named condition prevents the next stage.
	 *
	 * A researched absence and a source with no elected terms are both this rather than
	 * `absent`: somebody looked, and what they found is the finding.
	 */
	Blocked: "blocked",
	/**
	 * This instrument cannot measure the stage from a checkout.
	 */
	Unknown: "unknown",
} as const

export type StageState = (typeof StageState)[keyof typeof StageState]

/**
 * The twelve stages, in the order a jurisdiction passes through them.
 *
 * `licensed`, `addressRole` and `coverage` are the three conditions `ingestEligibilityProblems`
 * applies to every source, and they are listed together because each one alone blocks ingestion.
 * An earlier version carried `licensed` and neither of the others, so the one universal
 * blocker it could see is the one it reported, and the license step read as the bottleneck.
 *
 * Electing all twelve license decisions would move the ingest-eligible count from 0 to 0.
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
	 * The register's research state for this jurisdiction's own premise-address
	 * backbone — `A`, `A~`, `B`, `C` or `D`.
	 *
	 * A backlog position rather than a quality score, and deliberately not called a tier.
	 */
	backboneState: string
	stages: Record<FunnelStage, StageReading>
	/**
	 * How many of the ten stages read `reached`.
	 *
	 * The incumbency view groups on this.
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
		 * Jurisdictions the census report carried a row for.
		 *
		 * The difference between this and `jurisdictions` is what the union denominator drops.
		 */
		censusCountries: number
		mixtureAudit: string | null
	}
}

export interface CoverageFunnelInput {
	/**
	 * `censusCoverage`'s per-country rows.
	 *
	 * Keyed by ISO alpha-2 here, and a jurisdiction missing from it reads as a
	 * jurisdiction the five registers never mention.
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
	 * An `audit_epoch_mixture` output path.
	 *
	 * Without one the `sampled` stage reads `unknown`, because how many rows a country
	 * contributes per epoch is a property of a run rather than of a checkout.
	 */
	mixtureAudit?: string
	/**
	 * Rows sampled per country in one epoch, and the epoch's own denominator,
	 * when a mixture audit supplied them.
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

		// `addressRole` and `coverage` are the other two conditions `ingestEligibilityProblems`
		// applies to every source, and they are read from the sources themselves
		// rather than from a separate register.
		// A jurisdiction whose sources carry neither is blocked on both however its licenses read.
		// `upstreamLineage`, the third field the register declares unresolved,
		// is deliberately absent here: eligibility does not check it, and it costs
		// correctness in the spec's linkage rules rather than admission.
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

		// The census counts a country's rows from the corpus manifest.
		// A jurisdiction absent from the census report is absent from all five of its registers.
		// The corpus is one of those five, so zero rows here is a measured reading
		// rather than a gap in this instrument.
		const corpusRows: StageReading = country?.corpusRows
			? {
					state: StageState.Reached,
					detail: `${country.corpusRows} corpus row(s), ${country.corpusStreetRows} carrying a street or house number`,
				}
			: { state: StageState.Absent, detail: "no corpus row carries this country" }

		const admitted: StageReading = country?.admitted
			? { state: StageState.Reached, detail: "named in the training config's country_weights" }
			: { state: StageState.Absent, detail: "absent from the training config's country_weights" }

		// The sampler decides at run time how many rows a country contributes.
		// The config states a weight, and a country admitted at weight 1.0 whose
		// sources hold no rows still draws nothing.
		//
		// An audit's `by_country` enumerates every country it drew, so a country missing
		// from it drew zero of the audit's own denominator.
		// That is a measured zero over a stated sample rather than an unknown, which is why an
		// admitted country absent from the audit reads `blocked` and carries the denominator.
		// A country the config never admitted reads `absent` instead: it cannot draw, and reporting
		// it as a sampling failure would blame the sampler for the admission filter's decision.
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

		// Both stages read the GAUNTLET board alone — `censusCoverage`'s `casesRoot`,
		// which is `eval-harness/gauntlet/cases`.
		// The golden answer keys, the coordinate panels and the per-locale probe boards are separate sets
		// and are not counted: `golden/us.jsonl` holds 2,660 rows while the gauntlet tree holds 143 for US.
		// So `absent` here means "no gauntlet row names this country" rather than "this country
		// has no evaluation", and a country graded only on a coordinate panel reads absent.
		// Widening this stage means teaching the census to read those sets, which is a
		// change to `censusCoverage` rather than to this module.
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
	 * How many of the ten stages the jurisdictions in this group reached.
	 */
	reached: number
	jurisdictions: readonly string[]
}

/**
 * Jurisdictions grouped by how many stages they reached, deepest first.
 *
 * The group a roadmap item was selected from is what this view exists to make visible.
 * A repository cannot derive that selection, so the caller states it beside the groups
 * rather than this function inferring it.
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
	 * The register's research state for this jurisdiction's own premise-address backbone.
	 *
	 * `A` is a verified open nationwide source, `A~` a strong one that is federated or partial.
	 */
	backboneState: string
	/**
	 * Whether the training config admits the country.
	 *
	 * An admitted country with no corpus rows is a config promising a locale it
	 * cannot deliver — `censusCoverage` calls the same shape `admittedButEmpty` —
	 * and is a different piece of work from a country the config never named.
	 */
	admitted: boolean
	licensed: boolean
}

/**
 * Jurisdictions whose source research is furthest along and whose corpus carries nothing.
 *
 * A filter rather than a ranking.
 * It reads two of the five inputs {@linkcode OPPORTUNITY_INPUTS} names —
 * how far the source is researched, and whether any row exists — and the three it
 * cannot read are the ones that would order the result.
 *
 * A caller choosing between these states the other three itself.
 *
 * The filter is deliberately blind to packages, boards and tiers.
 * Ordering by those would put the jurisdictions already measured on top,
 * which is the selection the funnel exists to expose.
 *
 * `backboneState` orders the output because it is a statement about the source
 * rather than about this repository's attention: `A` means somebody verified an open
 * nationwide premise-address source and the corpus still holds no row from it.
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
 * The inputs a work-selection ranking reads, and which of them this instrument supplies today.
 *
 * Existing package and board coverage is absent from this list by design.
 * It reduces what a piece of work costs, and reading it as need would rank the jurisdictions
 * already measured above the ones nobody has measured — the selection the funnel exists to expose.
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
