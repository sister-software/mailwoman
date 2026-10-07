/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Validation of supplied records before a dossier is built. An error is a record the dossier cannot use
 *   (a dangling reference, including a claim derived from a claim that is not supplied, a duplicate id, a
 *   malformed date, a reading, check, membership or position whose subject is not a building, a position
 *   outside the range of latitude and longitude, a probability outside 0 to 1 or without a basis, a
 *   negative duration). A warning is a record the dossier will use with a stated limit (a missing
 *   availability date, a missing event date, unknown signing authority, an external identifier without
 *   evidence). The report prints an identifier without evidence with the words `source unstated`.
 */

import type { ProviderAvailability } from "#availability"
import { type Claim, derivationOf } from "#claims"
import type { UnitCount } from "#counts"
import type { LayerReading } from "#coverage"
import type { Entity } from "#entities"
import type { CommercialEvent, ConstructionWindow, OrganizationRelation } from "#events"
import type { AvailabilityCheck, BlockerObservation, ExplanationProbability, OperatorDisposition } from "#explanations"
import type { FilingRow } from "#filings"
import type { EntityKind } from "#identifiers"
import type { Alias, Containment } from "#links"
import type { BuildingPosition, ExtentMembership } from "#placement"
import type { SourceRecord } from "#sources"
import { isISODate } from "#time"

export interface DossierRecords {
	sources: readonly SourceRecord[]
	entities: readonly Entity[]
	aliases: readonly Alias[]
	containment: readonly Containment[]
	claims: readonly Claim[]
	counts: readonly UnitCount[]
	events: readonly CommercialEvent[]
	relations: readonly OrganizationRelation[]
	windows: readonly ConstructionWindow[]
	availability: readonly ProviderAvailability[]
	readings: readonly LayerReading[]
	filings: readonly FilingRow[]
	/**
	 * The availability checks the dossier explains.
	 * A check is a question and cites no source.
	 */
	checks?: readonly AvailabilityCheck[]
	blockers?: readonly BlockerObservation[]
	probabilities?: readonly ExplanationProbability[]
	dispositions?: readonly OperatorDisposition[]
	/**
	 * Sources' statements that a building lies in an extent.
	 *
	 * A reading without a subject attaches to a building only through one of them.
	 */
	memberships?: readonly ExtentMembership[]
	/**
	 * Sources' statements of a building's latitude and longitude.
	 */
	positions?: readonly BuildingPosition[]
}

export interface ValidationIssue {
	severity: "error" | "warning"
	code: string
	message: string
	ref: string | null
}

/**
 * The magnitude of a WGS 84 latitude at either pole, in degrees.
 */
const POLAR_LATITUDE = 90

/**
 * The magnitude of a WGS 84 longitude at the antimeridian, in degrees.
 */
const ANTIMERIDIAN_LONGITUDE = 180

export function validateRecords(records: DossierRecords): readonly ValidationIssue[] {
	const issues: ValidationIssue[] = []
	const sources = new Set<string>()
	const entities = new Map<string, EntityKind>()

	for (const source of records.sources) {
		if (sources.has(source.id)) {
			issues.push({
				severity: "error",
				code: "duplicate_source",
				message: `source ${source.id} appears twice`,
				ref: source.id,
			})
		}

		sources.add(source.id)

		for (const [field, value] of Object.entries({
			observedAt: source.observedAt,
			availableAt: source.availableAt,
			retrievedAt: source.retrievedAt,
		})) {
			if (value !== null && !isISODate(value)) {
				issues.push({
					severity: "error",
					code: "malformed_date",
					message: `source ${source.id} ${field} ${value} is not an ISO 8601 date`,
					ref: source.id,
				})
			}
		}

		if (source.availableAt === null) {
			issues.push({
				severity: "warning",
				code: "source_without_available_date",
				message: `source ${source.id} has no availability date and is undated in every as-of dossier`,
				ref: source.id,
			})
		}
	}

	for (const entity of records.entities) {
		if (entities.has(entity.id)) {
			issues.push({
				severity: "error",
				code: "duplicate_entity",
				message: `entity ${entity.id} appears twice`,
				ref: entity.id,
			})
		}

		entities.set(entity.id, entity.kind)
	}

	const checkSource = (ref: string, source: string) => {
		if (!sources.has(source)) {
			issues.push({
				severity: "error",
				code: "unknown_source",
				message: `${ref} cites source ${source}, which is not supplied`,
				ref,
			})
		}
	}

	const checkEntity = (ref: string, entity: string) => {
		if (!entities.has(entity)) {
			issues.push({
				severity: "error",
				code: "unknown_entity",
				message: `${ref} refers to entity ${entity}, which is not supplied`,
				ref,
			})
		}
	}

	const checkDate = (ref: string, field: string, value: string | null | undefined) => {
		if (value != null && !isISODate(value)) {
			issues.push({
				severity: "error",
				code: "malformed_date",
				message: `${ref} ${field} ${value} is not an ISO 8601 date`,
				ref,
			})
		}
	}

	for (const entity of records.entities) {
		entity.externalIDs.forEach((id, index) => {
			const ref = `${entity.id} identifier ${index}`

			if (id.evidence) {
				checkSource(ref, id.evidence.source)
			} else {
				issues.push({
					severity: "warning",
					code: "identifier_without_evidence",
					message: `${ref} (${id.namespace} ${id.value}) has no evidence, so the report prints it with the words source unstated`,
					ref,
				})
			}
		})
	}

	records.aliases.forEach((alias, index) =>
		alias.candidates.forEach((candidate) => {
			checkSource(`alias ${index}`, candidate.evidence.source)
			checkEntity(`alias ${index}`, candidate.entity)
		})
	)

	records.containment.forEach((link, index) => {
		checkSource(`containment ${index}`, link.evidence.source)
		checkEntity(`containment ${index}`, link.child)
		checkEntity(`containment ${index}`, link.parent)
	})

	const claims = new Set(records.claims.map((claim) => claim.id))

	for (const claim of records.claims) {
		checkSource(claim.id, claim.evidence.source)
		checkEntity(claim.id, claim.subject)

		for (const parent of derivationOf(claim)) {
			if (!claims.has(parent)) {
				issues.push({
					severity: "error",
					code: "unknown_claim",
					message: `${claim.id} derives from claim ${parent}, which is not supplied`,
					ref: claim.id,
				})
			}
		}
	}

	for (const count of records.counts) {
		checkSource(count.id, count.evidence.source)
		checkEntity(count.id, count.subject)
		checkDate(count.id, "at", count.at)
	}

	for (const event of records.events) {
		checkSource(event.id, event.evidence.source)
		event.scope.forEach((entity) => checkEntity(event.id, entity))
		checkDate(event.id, "date", event.date)

		if (event.date === null) {
			issues.push({
				severity: "warning",
				code: "event_without_date",
				message: `event ${event.id} has no date and is never counted`,
				ref: event.id,
			})
		}
	}

	records.relations.forEach((relation, index) => {
		checkSource(`relation ${index}`, relation.evidence.source)
		checkEntity(`relation ${index}`, relation.subject)

		if (relation.signingAuthority === "unknown") {
			issues.push({
				severity: "warning",
				code: "signing_authority_unknown",
				message: `${relation.organization} holds the ${relation.role} role for ${relation.subject}. Signing authority is unknown`,
				ref: `relation ${index}`,
			})
		}
	})

	records.windows.forEach((window, index) => {
		checkSource(`window ${index}`, window.evidence.source)
		checkEntity(`window ${index}`, window.subject)
		checkDate(`window ${index}`, "start", window.start)
		checkDate(`window ${index}`, "end", window.end)
	})

	records.availability.forEach((record, index) => {
		checkSource(`availability ${index}`, record.evidence.source)
		checkEntity(`availability ${index}`, record.subject)
		checkDate(`availability ${index}`, "from", record.from)
		checkDate(`availability ${index}`, "to", record.to)
	})

	const checkBuilding = (ref: string, what: string, subject: string) => {
		const kind = entities.get(subject)

		if (kind === undefined) {
			checkEntity(ref, subject)
		} else if (kind !== "building") {
			issues.push({
				severity: "error",
				code: "subject_not_building",
				message: `${ref} has subject ${subject}, a ${kind}. A ${what}'s subject must be a building`,
				ref,
			})
		}
	}

	records.readings.forEach((reading, index) => {
		const ref = `reading ${index}`

		checkSource(ref, reading.evidence.source)

		if (reading.subject !== null) {
			checkBuilding(ref, "reading", reading.subject)
		}
	})

	records.memberships?.forEach((membership, index) => {
		const ref = `membership ${index}`

		checkSource(ref, membership.evidence.source)
		checkBuilding(ref, "membership", membership.subject)
	})

	records.positions?.forEach((position, index) => {
		const ref = `position ${index}`

		checkSource(ref, position.evidence.source)
		checkBuilding(ref, "position", position.subject)

		// A comparison with NaN is false, so a missing or non-finite coordinate fails here too.
		if (!(Math.abs(position.latitude) <= POLAR_LATITUDE && Math.abs(position.longitude) <= ANTIMERIDIAN_LONGITUDE)) {
			issues.push({
				severity: "error",
				code: "position_out_of_range",
				message: `${ref} gives latitude ${position.latitude} and longitude ${position.longitude}. A latitude lies from -${POLAR_LATITUDE} to ${POLAR_LATITUDE} degrees and a longitude from -${ANTIMERIDIAN_LONGITUDE} to ${ANTIMERIDIAN_LONGITUDE}`,
				ref,
			})
		}
	})

	records.filings.forEach((row, index) => checkSource(`filing ${index}`, row.evidence.source))

	const checks = new Set<string>()

	for (const check of records.checks ?? []) {
		if (checks.has(check.id)) {
			issues.push({
				severity: "error",
				code: "duplicate_check",
				message: `check ${check.id} appears twice`,
				ref: check.id,
			})
		}

		checks.add(check.id)
		checkBuilding(check.id, "check", check.subject)
	}

	const checkCheck = (ref: string, check: string) => {
		if (!checks.has(check)) {
			issues.push({
				severity: "error",
				code: "unknown_check",
				message: `${ref} refers to check ${check}, which is not supplied`,
				ref,
			})
		}
	}

	const checkDuration = (ref: string, field: string, value: number | null | undefined) => {
		if (value != null && !(value >= 0)) {
			issues.push({
				severity: "error",
				code: "negative_duration",
				message: `${ref} ${field} ${value} is not a duration of zero or more minutes`,
				ref,
			})
		}
	}

	for (const blocker of records.blockers ?? []) {
		checkSource(blocker.id, blocker.evidence.source)
		checkEntity(blocker.id, blocker.subject)
	}

	records.probabilities?.forEach((probability, index) => {
		const ref = `probability ${index}`

		checkSource(ref, probability.evidence.source)
		checkCheck(ref, probability.check)

		if (!(probability.probability >= 0 && probability.probability <= 1)) {
			issues.push({
				severity: "error",
				code: "probability_out_of_range",
				message: `${ref} gives ${probability.probability}, which is not a probability from 0 to 1`,
				ref,
			})
		}

		if (!probability.basis.trim()) {
			issues.push({
				severity: "error",
				code: "probability_without_basis",
				message: `${ref} states no basis for its probability`,
				ref,
			})
		}
	})

	for (const disposition of records.dispositions ?? []) {
		const ref = disposition.id

		checkSource(ref, disposition.evidence.source)
		checkCheck(ref, disposition.check)
		checkDate(ref, "decidedAt", disposition.decidedAt)

		if (disposition.outcome) {
			checkSource(ref, disposition.outcome.evidence.source)
			checkDate(ref, "outcome.at", disposition.outcome.at)
			checkDuration(ref, "outcome.minutesSpent", disposition.outcome.minutesSpent)
			checkDuration(ref, "outcome.baselineMinutes", disposition.outcome.baselineMinutes)
		}
	}

	return issues
}
