/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Validation of supplied records before a dossier is built. An error is a record the dossier cannot use
 *   (a dangling reference, a duplicate id, a malformed date). A warning is a record the dossier will use
 *   with a stated limit (a missing availability date, a missing event date, unknown signing authority).
 */

import type { ProviderAvailability } from "#availability"
import type { Claim } from "#claims"
import type { UnitCount } from "#counts"
import type { LayerReading } from "#coverage"
import type { Entity } from "#entities"
import type { CommercialEvent, ConstructionWindow, OrganizationRelation } from "#events"
import type { FilingRow } from "#filings"
import type { Alias, Containment } from "#links"
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
}

export interface ValidationIssue {
	severity: "error" | "warning"
	code: string
	message: string
	ref?: string
}

export function validateRecords(records: DossierRecords): readonly ValidationIssue[] {
	const issues: ValidationIssue[] = []
	const sources = new Set<string>()
	const entities = new Set<string>()

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
			if (value !== undefined && !isISODate(value)) {
				issues.push({
					severity: "error",
					code: "malformed_date",
					message: `source ${source.id} ${field} ${value} is not an ISO 8601 date`,
					ref: source.id,
				})
			}
		}

		if (source.availableAt === undefined) {
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

		entities.add(entity.id)
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

	const checkDate = (ref: string, field: string, value: string | undefined) => {
		if (value !== undefined && !isISODate(value)) {
			issues.push({
				severity: "error",
				code: "malformed_date",
				message: `${ref} ${field} ${value} is not an ISO 8601 date`,
				ref,
			})
		}
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

	for (const claim of records.claims) {
		checkSource(claim.id, claim.evidence.source)
		checkEntity(claim.id, claim.subject)
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

		if (event.date === undefined) {
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

	records.readings.forEach((reading, index) => checkSource(`reading ${index}`, reading.evidence.source))
	records.filings.forEach((row, index) => checkSource(`filing ${index}`, row.evidence.source))

	return issues
}
