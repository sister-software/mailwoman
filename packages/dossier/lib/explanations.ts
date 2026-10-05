/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The explanations for a failed availability check. A check asks whether a layer's source holds
 *   service at the extent where it keys a building. The latest readings at that extent answer it.
 *
 *   When those readings hold no record, the section restates them as facts and states what their
 *   coverage basis supports as a deduction. Each explanation the admitted records support becomes a
 *   hypothesis, listed with its supporting, conflicting and missing records and the investigation that
 *   would test it. A kind without a supporting record is reported as checked and unsupported.
 *
 *   No rule here turns a hypothesis into a fact. A later reading that holds records resolves the
 *   exception, and the explanations stay hypotheses about the earlier date.
 */

import type { ProviderAvailability } from "#availability"
import { type UnitCount, UnitStage } from "#counts"
import { classifyReadings, type LayerReading, LayerReadingClass } from "#coverage"
import type { Building } from "#entities"
import { type CommercialEvent, CommercialEventKind, type ConstructionWindow, type OrganizationRelation } from "#events"
import type { EntityID } from "#identifiers"
import type { AliasResolution, Evidence } from "#links"
import { type ExtentMembership, readingBuildings } from "#placement"
import type { SourceRecordID } from "#sources"
import { compareISODate, type ISODate } from "#time"

/**
 * The five kinds of statement the explanation section makes, as wire values.
 *
 * A fact restates an admitted record.
 * A deduction follows from facts by a stated rule.
 *
 * An estimate is an empirical quantity with a documented basis.
 * A hypothesis is an explanation the records support without establishing it.
 * A decision is an operator's recorded disposition.
 */
export const StatementKind = {
	Fact: "fact",
	Deduction: "deduction",
	Estimate: "estimate",
	Hypothesis: "hypothesis",
	Decision: "decision",
} as const

export type StatementKind = (typeof StatementKind)[keyof typeof StatementKind]

export interface Statement {
	kind: StatementKind
	text: string
	/**
	 * The source records the statement cites.
	 *
	 * A hypothesis cites none of its own.
	 * Its supporting statements cite the records.
	 */
	sources: readonly SourceRecordID[]
	/**
	 * `true` when the statement reports that no admitted record exists for its subject.
	 *
	 * A check's extent that no admitted reading covers is one such subject.
	 * Such a statement cites no source, and the report prints it as an absence.
	 */
	absence?: true
}

/**
 * The five explanations for a failed availability check, as wire values.
 *
 * The building may not be among the premises the source keys, a provider may lack access,
 * the serving element may lack capacity, the building may not have been ready for an
 * installation, or the network may not reach the building's extent.
 */
export const ExplanationKind = {
	Identity: "identity",
	Access: "access",
	Capacity: "capacity",
	Installation: "installation",
	Route: "route",
} as const

export type ExplanationKind = (typeof ExplanationKind)[keyof typeof ExplanationKind]

/**
 * A question put to a dossier: whether the source of `layer` holds service at
 * the extent where it keys `subject`.
 */
export interface AvailabilityCheck {
	id: string
	/**
	 * The building the check is about.
	 * It must be a building the dossier's records supply.
	 */
	subject: EntityID
	/**
	 * The layer whose readings answer the check, such as `fcc-bdc-fttp`.
	 */
	layer: string
	/**
	 * The extent at which the layer's source keys its lookup, such as `census-block:<GEOID>`.
	 *
	 * The check reads every admitted reading of the layer at this extent, whichever building
	 * the reading was supplied for and whether or not it attaches to a building.
	 * The source answers for the extent, so a membership test keyed any more strictly
	 * would report an absence the source never stated.
	 */
	extent: string
}

/**
 * A source's statement that one explanation applies, or does not apply, to a building.
 *
 * A provider's survey that reports a full cabinet is one example.
 * A landlord's letter that grants access is another.
 */
export interface BlockerObservation {
	id: string
	subject: EntityID
	kind: ExplanationKind
	/**
	 * `true` when the source states that the blocker applies.
	 * Such a statement supports the explanation.
	 *
	 * `false` when the source states that the blocker does not apply.
	 * Such a statement conflicts with the explanation.
	 */
	applies: boolean
	/**
	 * What the source states, in its own words.
	 */
	statement: string
	evidence: Evidence
}

/**
 * A documented probability that one explanation holds for one check.
 *
 * A ranking uses it only when every supported explanation of the check has exactly one.
 */
export interface ExplanationProbability {
	/**
	 * The {@link AvailabilityCheck} id.
	 */
	check: string
	kind: ExplanationKind
	/**
	 * A probability from 0 to 1.
	 */
	probability: number
	/**
	 * How the cited record establishes the probability, such as `held in 31 of 40 comparable exceptions`.
	 */
	basis: string
	evidence: Evidence
}

/**
 * The result an operator recorded for an investigation.
 */
export interface OperatorOutcome {
	/**
	 * Whether the investigated explanation held.
	 */
	held: boolean
	at: ISODate
	/**
	 * Minutes the investigation took.
	 */
	minutesSpent?: number
	/**
	 * The operator's stated minutes for the same investigation without the report.
	 */
	baselineMinutes?: number
	/**
	 * The record of the outcome.
	 *
	 * A dossier admits the outcome by this record's availability date.
	 * That date can follow the decision's.
	 */
	evidence: Evidence
}

/**
 * An operator's decision about a check's explanations, with the outcome once one is recorded.
 *
 * A disposition is the operator's own record.
 * A public record that resolves an exception is a reading in the dossier and never a disposition.
 */
export interface OperatorDisposition {
	id: string
	/**
	 * The {@link AvailabilityCheck} id.
	 */
	check: string
	/**
	 * The explanation the operator chose to investigate.
	 */
	investigated: ExplanationKind
	/**
	 * The decision, in the operator's words.
	 */
	decision: string
	decidedAt: ISODate
	evidence: Evidence
	outcome?: OperatorOutcome
}

export interface Investigation {
	/**
	 * The record to obtain or the action to take that would test the explanation.
	 */
	action: string
	/**
	 * The next action if the investigation finds the explanation holds.
	 */
	ifHolds: string
	/**
	 * The next action if the investigation finds it does not hold.
	 */
	ifFails: string
}

export interface Explanation {
	kind: ExplanationKind
	hypothesis: Statement
	/**
	 * Facts and deductions that make the hypothesis more plausible.
	 * An explanation is shown only when this list has an entry.
	 */
	supporting: readonly Statement[]
	conflicting: readonly Statement[]
	/**
	 * The records that bear on the hypothesis and that the dossier lacks, in words a reader can act on.
	 */
	missing: readonly string[]
	investigation: Investigation
}

/**
 * How the section orders the supported explanations.
 *
 * `ranked` needs exactly one documented probability for every supported explanation.
 * Its entries run from the highest probability down, each with the records that document it.
 *
 * `scenarios` lists the explanations that lack one.
 * The section then shows each explanation's next action if it holds and if it fails.
 * `none` means no explanation has a supporting record.
 */
export type ExplanationRanking =
	| {
			kind: "ranked"
			order: readonly { explanation: ExplanationKind; probability: number; sources: readonly SourceRecordID[] }[]
	  }
	| { kind: "scenarios"; undocumented: readonly ExplanationKind[] }
	| { kind: "none" }

/**
 * The latest failing vintage of a check, with the explanations the admitted records support.
 */
export interface ServiceabilityException {
	/**
	 * The survey date of the failing readings, when they state one.
	 */
	vintage?: ISODate
	/**
	 * The date the rules compare records against: the vintage, or the dossier's
	 * as-of date when the readings state none.
	 */
	checkedAt: ISODate
	class: Exclude<LayerReadingClass, typeof LayerReadingClass.Records>
	/**
	 * The failing readings, or the absence of any reading at the check's extent.
	 */
	facts: readonly Statement[]
	/**
	 * What the failing readings' coverage basis supports.
	 */
	deductions: readonly Statement[]
	/**
	 * The supported explanations, in ranking order when the section ranks them.
	 */
	explanations: readonly Explanation[]
	/**
	 * The kinds the rules checked and found no supporting record for.
	 */
	unsupported: readonly ExplanationKind[]
	/**
	 * Every admitted probability documented for the check.
	 */
	estimates: readonly Statement[]
	ranking: ExplanationRanking
	/**
	 * The deduction that a later reading resolved the exception, citing that reading.
	 * Empty while the exception is open.
	 */
	resolution: readonly Statement[]
}

export interface CheckResult {
	check: AvailabilityCheck
	/**
	 * The class of the latest readings at the check's extent.
	 * It is `unknown` when no admitted reading covers the extent.
	 */
	status: LayerReadingClass
	/**
	 * The survey date of the latest readings, when they state one.
	 */
	vintage?: ISODate
	/**
	 * The latest readings at the check's extent as facts, then the deduction their class supports.
	 */
	answer: readonly Statement[]
	/**
	 * The latest failing vintage, open or resolved.
	 *
	 * It is absent when every reading at the extent holds records.
	 */
	exception?: ServiceabilityException
	/**
	 * The operator's dispositions as decisions and their admitted outcomes as facts, in decision order.
	 */
	decisions: readonly Statement[]
}

/**
 * The admitted records {@link explainCheck} reads for one building.
 *
 * Every list holds the dossier's admitted records.
 * The function selects those that concern the building or the check.
 */
export interface ExplanationInput {
	asOf: ISODate
	building: Building
	/**
	 * The building's entrances.
	 */
	entrances: readonly EntityID[]
	/**
	 * The building's aliases, each with its resolution.
	 */
	aliases: readonly { text: string; resolution: AliasResolution }[]
	/**
	 * Every admitted reading, whichever building it was supplied for.
	 */
	readings: readonly LayerReading[]
	windows: readonly ConstructionWindow[]
	counts: readonly UnitCount[]
	availability: readonly ProviderAvailability[]
	events: readonly CommercialEvent[]
	relations: readonly OrganizationRelation[]
	blockers: readonly BlockerObservation[]
	probabilities: readonly ExplanationProbability[]
	dispositions: readonly OperatorDisposition[]
	/**
	 * The admitted memberships.
	 *
	 * A reading without a subject is a reading of the building only where one of
	 * them places the building in the reading's extent.
	 * Without them, such a reading attaches to no building.
	 */
	memberships?: readonly ExtentMembership[]
}

function statement(kind: StatementKind, text: string, sources: readonly SourceRecordID[] = []): Statement {
	return { kind, text, sources: [...new Set(sources)] }
}

/**
 * A statement whose text reports that no admitted record exists for its subject.
 */
function absentStatement(kind: StatementKind, text: string): Statement {
	return { kind, text, sources: [], absence: true }
}

function plural(count: number, noun: string): string {
	return `${count} ${noun}${count === 1 ? "" : "s"}`
}

/**
 * Joins words as English prose without a serial comma: `a, b and c`.
 */
const PROSE_LIST = new Intl.ListFormat("en-GB", { style: "long", type: "conjunction" })

function withoutFinalPeriod(text: string): string {
	return text.trim().replace(/\.$/, "")
}

interface VintageGroup {
	vintage?: ISODate
	readings: readonly LayerReading[]
	class: LayerReadingClass
}

/**
 * Groups readings by survey date, oldest first.
 *
 * Readings without a survey date form one group that sorts before every dated group,
 * so a dated reading always supersedes them.
 */
function byVintage(readings: readonly LayerReading[]): VintageGroup[] {
	const groups = new Map<string, LayerReading[]>()

	for (const reading of readings) {
		const key = reading.surveyedAt ?? ""

		groups.set(key, [...(groups.get(key) ?? []), reading])
	}

	return [...groups]
		.toSorted(([a], [b]) => {
			if (a === b) return 0

			if (a === "") return -1

			if (b === "") return 1

			return compareISODate(a, b)
		})
		.map(([key, group]) => ({ vintage: key || undefined, readings: group, class: classifyReadings(group).class }))
}

function sourcesOf(readings: readonly LayerReading[]): SourceRecordID[] {
	return readings.map((reading) => reading.evidence.source)
}

function readingFact(reading: LayerReading): Statement {
	const named = `The ${reading.layer} reading over ${reading.extent}${reading.surveyedAt ? ` as of ${reading.surveyedAt}` : ""}`
	const sources = [reading.evidence.source]

	if (reading.records === null) return statement(StatementKind.Fact, `${named} has no survey.`, sources)

	if (reading.records === 0) {
		return statement(StatementKind.Fact, `${named} holds 0 records on a ${reading.basis ?? "unstated"} basis.`, sources)
	}

	return statement(StatementKind.Fact, `${named} holds ${plural(reading.records, "record")}.`, sources)
}

function readingFacts(check: AvailabilityCheck, group: VintageGroup | undefined): Statement[] {
	if (!group)
		return [absentStatement(StatementKind.Fact, `No admitted reading of ${check.layer} covers ${check.extent}.`)]

	return group.readings.map(readingFact)
}

/**
 * The deduction a group's class supports.
 *
 * Only a basis that supports exclusion turns a zero into an absence.
 */
function classDeduction(check: AvailabilityCheck, group: VintageGroup | undefined, date: ISODate): Statement {
	const service = `${check.layer} service at ${check.extent} on ${date}`
	const sources = group ? sourcesOf(group.readings) : []
	const basis = group?.readings[0]?.basis ?? "unstated"

	switch (group?.class ?? LayerReadingClass.Unknown) {
		case LayerReadingClass.Records:
			return statement(
				StatementKind.Deduction,
				`The ${check.layer} reading over ${check.extent} on ${date} holds records, so the check passes.`,
				sources
			)
		case LayerReadingClass.SurveyedEmpty:
			return statement(
				StatementKind.Deduction,
				`A reading on a ${basis} basis that holds no record supports exclusion, so the absence of ${service} is established for the surveyed extent.`,
				sources
			)
		case LayerReadingClass.SourcePresentEmpty:
			return statement(
				StatementKind.Deduction,
				`A reading on a ${basis} basis that holds no record does not support exclusion, so the absence of ${service} is unknown.`,
				sources
			)
		case LayerReadingClass.Conflicting:
			return statement(
				StatementKind.Deduction,
				`The readings disagree, so whether ${service} exists stays unresolved until a record settles them.`,
				sources
			)
		case LayerReadingClass.Unknown: {
			const text = `Without a survey of ${check.extent}, whether ${check.layer} service exists there on ${date} is unknown.`

			// A reading that states no survey is a record of the gap, and the deduction cites it.
			// When the extent has no admitted reading at all, the deduction is an absence.
			return group ? statement(StatementKind.Deduction, text, sources) : absentStatement(StatementKind.Deduction, text)
		}
	}
}

/**
 * What one explanation rule found before the explanations are compared.
 */
interface Finding {
	kind: ExplanationKind
	hypothesis: string
	supporting: Statement[]
	conflicting: Statement[]
	missing: string[]
	action: string
	ifHolds: string
}

interface RuleContext {
	check: AvailabilityCheck
	input: ExplanationInput
	label: string
	/**
	 * The date the rules compare records against.
	 */
	date: ISODate
	failing: VintageGroup | undefined
	/**
	 * The groups at the check's extent before the failing one, oldest first.
	 */
	earlier: readonly VintageGroup[]
	/**
	 * The deduction the failing group's class supports.
	 */
	deduction: Statement
}

/**
 * The blocker observations of one kind for the building, as facts.
 */
function observed(context: RuleContext, kind: ExplanationKind, applies: boolean): Statement[] {
	return context.input.blockers
		.filter(
			(blocker) => blocker.subject === context.input.building.id && blocker.kind === kind && blocker.applies === applies
		)
		.map((blocker) =>
			statement(
				StatementKind.Fact,
				`Observation ${blocker.id} states ${applies ? "a" : "no"} ${kind} blocker at ${context.label}: "${withoutFinalPeriod(blocker.statement)}".`,
				[blocker.evidence.source]
			)
		)
}

/**
 * Identity is supported by an alias of the building that resolves to more than one entity.
 */
function identityFinding(context: RuleContext): Finding {
	const { check, label } = context

	const ambiguous = context.input.aliases.flatMap((alias) => {
		if (alias.resolution.kind !== "ambiguous") return []

		const candidates = alias.resolution.candidates
		const entities = [...new Set(candidates.map((candidate) => candidate.entity))]

		return [
			statement(
				StatementKind.Fact,
				`The alias "${alias.text}" refers to ${entities.length} entities: ${entities.join(", ")}.`,
				candidates.map((candidate) => candidate.evidence.source)
			),
		]
	})

	return {
		kind: ExplanationKind.Identity,
		hypothesis: `${label} may not be among the premises the ${check.layer} source keys at ${check.extent}.`,
		supporting: [...ambiguous, ...observed(context, ExplanationKind.Identity, true)],
		conflicting: observed(context, ExplanationKind.Identity, false),
		missing: [
			`a record from the ${check.layer} source that names the premises it keys at ${check.extent}, such as its location identifier for ${label}`,
		],
		action: `Look up ${label}'s address and identifiers in the ${check.layer} source's records for ${check.extent}.`,
		ifHolds: `Supply the ${check.layer} source with ${label}'s address or identifier, and repeat the check on its next reading.`,
	}
}

/**
 * Access is supported by a landlord permission dated after the check's date,
 * because that permission was not in force on the date.
 *
 * A permission in force on the date that covers only some of the building's entrances supports it as well.
 */
function accessFinding(context: RuleContext): Finding {
	const { input, label, date } = context
	const building = input.building.id
	const mine = new Set([building, ...input.entrances])
	const touches = (event: CommercialEvent) => event.scope.some((entity) => mine.has(entity))

	const covers = (event: CommercialEvent) =>
		event.scope.includes(building) ||
		(input.entrances.length > 0 && input.entrances.every((entrance) => event.scope.includes(entrance)))

	const parties = (event: CommercialEvent) => event.parties.map((party) => party.name).join(", ") || "an unnamed party"

	const permissions = input.events.filter(
		(event) => event.kind === CommercialEventKind.LandlordPermission && touches(event)
	)

	const after = permissions.filter((event) => event.date !== undefined && compareISODate(event.date, date) > 0)
	const inForce = permissions.filter((event) => event.date !== undefined && compareISODate(event.date, date) <= 0)

	const builds = input.events.filter(
		(event) =>
			event.kind === CommercialEventKind.AcceptedBuild &&
			touches(event) &&
			event.date !== undefined &&
			compareISODate(event.date, date) <= 0
	)

	const signatories = input.relations.filter(
		(relation) => relation.subject === building && relation.signingAuthority === "yes"
	)

	return {
		kind: ExplanationKind.Access,
		hypothesis: `A provider may have lacked permission to install service at ${label} on ${date}.`,
		supporting: [
			...after.map((event) =>
				statement(
					StatementKind.Fact,
					`Landlord permission ${event.id} from ${parties(event)} for ${event.scope.join(", ")} is dated ${event.date}, after ${date}.`,
					[event.evidence.source]
				)
			),
			...inForce
				.filter((event) => !covers(event))
				.map((event) =>
					statement(
						StatementKind.Fact,
						`Landlord permission ${event.id} from ${parties(event)}, dated ${event.date}, covers ${event.scope.join(", ")} and not the whole of ${label}.`,
						[event.evidence.source]
					)
				),
			...observed(context, ExplanationKind.Access, true),
		],
		conflicting: [
			...inForce
				.filter(covers)
				.map((event) =>
					statement(
						StatementKind.Fact,
						`Landlord permission ${event.id} from ${parties(event)}, dated ${event.date}, covers ${label}.`,
						[event.evidence.source]
					)
				),
			...builds.map((event) =>
				statement(
					StatementKind.Fact,
					`An accepted build, ${event.id}, for ${event.scope.join(", ")} is dated ${event.date}.`,
					[event.evidence.source]
				)
			),
			...observed(context, ExplanationKind.Access, false),
		],
		missing: [
			`a dated landlord permission or refusal for ${label} from a party with signing authority`,
			...(signatories.length ? [] : [`a record naming the signatory for ${label}`]),
			...permissions
				.filter((event) => event.date === undefined)
				.map((event) => `the date of landlord permission ${event.id}`),
		],
		action: `Ask the owner or manager of ${label} whether a permission for the provider was in force on ${date}, and who signs for ${label}.`,
		ifHolds: `Seek a dated permission for ${label} from the party with signing authority.`,
	}
}

/**
 * Capacity is supported only by a source's statement.
 *
 * A serving element's spare capacity is the provider's record, and no other record in a dossier bears on it.
 */
function capacityFinding(context: RuleContext): Finding {
	const { check, label, date } = context

	return {
		kind: ExplanationKind.Capacity,
		hypothesis: `The element that serves ${check.extent} may have lacked spare capacity for ${label} on ${date}.`,
		supporting: observed(context, ExplanationKind.Capacity, true),
		conflicting: observed(context, ExplanationKind.Capacity, false),
		missing: [`a spare-capacity record for the element that serves ${check.extent}`],
		action: `Request the provider's spare-capacity record for the element that serves ${check.extent}.`,
		ifHolds: "Ask the provider when that element gains capacity, and repeat the check after that date.",
	}
}

function openWindowText(window: ConstructionWindow, date: ISODate): string {
	const named = `The construction window "${window.stage}"`

	if (window.start === undefined) {
		return window.end === undefined
			? `${named} states no start and no end.`
			: `${named} states no start and closed ${window.end}, after ${date}.`
	}

	if (compareISODate(window.start, date) > 0) return `${named} opened ${window.start}, after ${date}.`

	return window.end === undefined
		? `${named} opened ${window.start} and states no end.`
		: `${named} opened ${window.start} and closed ${window.end}, after ${date}.`
}

/**
 * Where an availability record states its provider's service, in the words of a statement.
 *
 * A record with an extent states availability over that extent, and it does not say
 * which premises in the extent are served.
 * The statement then gives the extent in place of the building's label.
 */
function availabilityPlace(record: ProviderAvailability, label: string): string {
	return record.extent ? `over ${record.extent}` : `at ${label}`
}

/**
 * Installation is supported by a construction window of the building that had
 * not closed on the check's date.
 *
 * It conflicts with a window that had closed, a completed unit count, and any
 * provider's availability recorded for the building on that date.
 */
function installationFinding(context: RuleContext): Finding {
	const { check, input, label, date } = context
	const building = input.building.id
	const windows = input.windows.filter((window) => window.subject === building)
	const closed = (window: ConstructionWindow) => window.end !== undefined && compareISODate(window.end, date) <= 0

	const completed = input.counts.filter(
		(count) => count.subject === building && count.stage === UnitStage.Completed && compareISODate(count.at, date) <= 0
	)

	const served = input.availability.filter(
		(record) =>
			record.subject === building &&
			compareISODate(record.from, date) <= 0 &&
			(record.to === undefined || compareISODate(date, record.to) <= 0)
	)

	return {
		kind: ExplanationKind.Installation,
		hypothesis: `${label} may not have been ready to receive service on ${date}.`,
		supporting: [
			...windows
				.filter((window) => !closed(window))
				.map((window) => statement(StatementKind.Fact, openWindowText(window, date), [window.evidence.source])),
			...observed(context, ExplanationKind.Installation, true),
		],
		conflicting: [
			...windows
				.filter(closed)
				.map((window) =>
					statement(
						StatementKind.Fact,
						`The construction window "${window.stage}" closed ${window.end}, on or before ${date}.`,
						[window.evidence.source]
					)
				),
			...completed.map((count) =>
				statement(
					StatementKind.Fact,
					`${plural(count.count, "completed unit")} ${count.count === 1 ? "is" : "are"} recorded for ${label} on ${count.at}.`,
					[count.evidence.source]
				)
			),
			...served.map((record) =>
				statement(
					StatementKind.Fact,
					`${record.provider} ${record.product} is recorded as available ${availabilityPlace(record, label)} on ${date}.`,
					[record.evidence.source]
				)
			),
			...observed(context, ExplanationKind.Installation, false),
		],
		missing: [`a completion or occupancy record for ${label} dated on or before ${date}`],
		action: `Retrieve ${label}'s completion or occupancy record and compare its date with ${date}.`,
		ifHolds: `Repeat the check on the first ${check.layer} reading dated after ${label}'s completion.`,
	}
}

/**
 * Route is supported by an established absence at the check's extent, or by records of
 * the check's layer on the same survey in a reading of the building at another extent.
 *
 * A reading is the building's when its subject is the building, or when it has no subject
 * and an admitted membership places the building in its extent.
 * A zero that supports no exclusion is never support: it is missing evidence.
 */
function routeFinding(context: RuleContext): Finding {
	const { check, input, date, failing, earlier } = context
	const building = input.building.id
	const established = failing?.class === LayerReadingClass.SurveyedEmpty

	const nearby = input.readings.filter(
		(reading) =>
			readingBuildings(reading, input.memberships ?? []).includes(building) &&
			reading.layer === check.layer &&
			reading.extent !== check.extent &&
			(reading.records ?? 0) > 0 &&
			reading.surveyedAt === failing?.vintage
	)

	const positiveAtExtent = [...earlier, ...(failing ? [failing] : [])].flatMap((group) =>
		group.readings.filter((reading) => (reading.records ?? 0) > 0)
	)

	const zeroWithoutExclusion =
		failing?.class === LayerReadingClass.SourcePresentEmpty
			? `, because a zero on a ${failing.readings[0]?.basis ?? "unstated"} basis establishes no absence`
			: ""

	return {
		kind: ExplanationKind.Route,
		hypothesis: `The ${check.layer} network may not have reached ${check.extent} on ${date}.`,
		supporting: [
			...(established ? [context.deduction] : []),
			...nearby.map(readingFact),
			...observed(context, ExplanationKind.Route, true),
		],
		conflicting: [...positiveAtExtent.map(readingFact), ...observed(context, ExplanationKind.Route, false)],
		missing: [
			...(established
				? []
				: [`a surveyed or designated reading of ${check.layer} over ${check.extent}${zeroWithoutExclusion}`]),
			`the provider's plant record for ${check.extent}`,
		],
		action: `Obtain the provider's plant record for ${check.extent}, or a surveyed reading of ${check.layer} over it, dated on or before ${date}.`,
		ifHolds: `Request the route and cost of extending the ${check.layer} network to ${check.extent}.`,
	}
}

const RULES: readonly ((context: RuleContext) => Finding)[] = [
	identityFinding,
	accessFinding,
	capacityFinding,
	installationFinding,
	routeFinding,
]

/**
 * Orders the supported explanations by documented probability, highest first.
 *
 * A ranking needs exactly one probability value for every explanation it compares.
 * Without one for any of them, the section shows scenarios.
 * Probabilities for kinds outside `kinds` are ignored.
 */
export function rankExplanations(
	kinds: readonly ExplanationKind[],
	probabilities: readonly ExplanationProbability[]
): ExplanationRanking {
	if (!kinds.length) return { kind: "none" }

	const documented: { explanation: ExplanationKind; probability: number; sources: readonly SourceRecordID[] }[] = []
	const undocumented: ExplanationKind[] = []

	for (const kind of kinds) {
		const entries = probabilities.filter((entry) => entry.kind === kind)
		const values = [...new Set(entries.map((entry) => entry.probability))]

		if (values.length === 1) {
			documented.push({
				explanation: kind,
				probability: values[0]!,
				sources: [...new Set(entries.map((entry) => entry.evidence.source))],
			})
		} else {
			undocumented.push(kind)
		}
	}

	if (undocumented.length) return { kind: "scenarios", undocumented }

	return { kind: "ranked", order: documented.toSorted((a, b) => b.probability - a.probability) }
}

function exceptionClass(group: VintageGroup | undefined): ServiceabilityException["class"] {
	const value = group?.class ?? LayerReadingClass.Unknown

	if (value === LayerReadingClass.Records) {
		throw new Error("explainCheck: readings that hold records are an answer, not an exception")
	}

	return value
}

function exceptionFor(
	check: AvailabilityCheck,
	input: ExplanationInput,
	failing: VintageGroup | undefined,
	earlier: readonly VintageGroup[],
	resolving: VintageGroup | undefined
): ServiceabilityException {
	const date = failing?.vintage ?? input.asOf
	const deduction = classDeduction(check, failing, date)
	const context: RuleContext = { check, input, label: input.building.label, date, failing, earlier, deduction }
	const findings = RULES.map((rule) => rule(context))
	const supported = findings.filter((finding) => finding.supporting.length > 0)
	const unsupported = findings.filter((finding) => finding.supporting.length === 0).map((finding) => finding.kind)
	const probabilities = input.probabilities.filter((entry) => entry.check === check.id)

	const ranking = rankExplanations(
		supported.map((finding) => finding.kind),
		probabilities
	)

	const ordered =
		ranking.kind === "ranked"
			? ranking.order.map((entry) => supported.find((finding) => finding.kind === entry.explanation)!)
			: supported

	const explanations = ordered.map((finding): Explanation => {
		const others = ordered.filter((other) => other.kind !== finding.kind).map((other) => other.kind)

		return {
			kind: finding.kind,
			hypothesis: statement(StatementKind.Hypothesis, finding.hypothesis),
			supporting: finding.supporting,
			conflicting: finding.conflicting,
			missing: finding.missing,
			investigation: {
				action: finding.action,
				ifHolds: finding.ifHolds,
				ifFails: others.length
					? `Investigate ${PROSE_LIST.format(others)} next.`
					: `No other explanation has a supporting record. Look for a record on ${PROSE_LIST.format(unsupported)}.`,
			},
		}
	})

	const resolution = resolving
		? [
				statement(
					StatementKind.Deduction,
					`The ${check.layer} readings over ${check.extent} from ${resolving.vintage ?? input.asOf} hold records, so the check passes from ${resolving.vintage ?? input.asOf} and resolves the exception recorded on ${date}. A reading dated ${resolving.vintage ?? input.asOf} does not establish whether any explanation held on ${date}.`,
					sourcesOf(resolving.readings)
				),
			]
		: []

	return {
		vintage: failing?.vintage,
		checkedAt: date,
		class: exceptionClass(failing),
		facts: readingFacts(check, failing),
		deductions: [deduction],
		explanations,
		unsupported,
		estimates: probabilities.map((entry) =>
			statement(
				StatementKind.Estimate,
				`The probability that the ${entry.kind} explanation holds is ${entry.probability} (${entry.basis}).`,
				[entry.evidence.source]
			)
		),
		ranking,
		resolution,
	}
}

function decisionStatements(check: AvailabilityCheck, dispositions: readonly OperatorDisposition[]): Statement[] {
	return dispositions
		.filter((disposition) => disposition.check === check.id)
		.toSorted((a, b) => compareISODate(a.decidedAt, b.decidedAt))
		.flatMap((disposition) => [
			statement(
				StatementKind.Decision,
				`On ${disposition.decidedAt} the operator decided to investigate ${disposition.investigated}: "${withoutFinalPeriod(disposition.decision)}".`,
				[disposition.evidence.source]
			),
			...(disposition.outcome
				? [
						statement(
							StatementKind.Fact,
							`On ${disposition.outcome.at} the operator recorded that the ${disposition.investigated} explanation ${disposition.outcome.held ? "held" : "did not hold"}.`,
							[disposition.outcome.evidence.source]
						),
					]
				: []),
		])
}

/**
 * Answers a check from the latest readings at its extent and explains its latest failing vintage.
 *
 * A failing vintage followed by one that holds records is resolved by that later reading.
 * The explanations of a resolved exception are evaluated at the failing vintage's date and stay hypotheses.
 */
export function explainCheck(check: AvailabilityCheck, input: ExplanationInput): CheckResult {
	const groups = byVintage(
		input.readings.filter((reading) => reading.layer === check.layer && reading.extent === check.extent)
	)

	const latest = groups.at(-1)
	const failingIndex = groups.findLastIndex((group) => group.class !== LayerReadingClass.Records)

	const exception = !groups.length
		? exceptionFor(check, input, undefined, [], undefined)
		: failingIndex !== -1
			? exceptionFor(check, input, groups[failingIndex], groups.slice(0, failingIndex), groups[failingIndex + 1])
			: undefined

	return {
		check,
		status: latest?.class ?? LayerReadingClass.Unknown,
		vintage: latest?.vintage,
		answer: [...readingFacts(check, latest), classDeduction(check, latest, latest?.vintage ?? input.asOf)],
		exception,
		decisions: decisionStatements(check, input.dispositions),
	}
}
