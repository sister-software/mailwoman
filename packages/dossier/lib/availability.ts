/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Provider presence as a dated relation between a provider and an entity. The answer for a date is
 *   available, withdrawn or unknown. It records what the provider advertised. Uptake needs its own record.
 *   A record can state the extent at which its source states availability, such as a census block, so a
 *   reader can tell an answer for the premises from an answer for a wider area.
 */

import type { EntityID } from "#identifiers"
import type { Evidence } from "#links"
import { compareISODate, type ISODate } from "#time"

export interface ProviderAvailability {
	provider: string
	subject: EntityID
	product: string
	from: ISODate
	to?: ISODate
	/**
	 * The extent at which the record's source states availability.
	 *
	 * It is written as a layer reading writes its extent, such as `census-block:<GEOID>`.
	 */
	extent?: string
	evidence: Evidence
}

export interface AvailabilityAnswer {
	status: "available" | "withdrawn" | "unknown"
	records: readonly ProviderAvailability[]
}

export function availabilityAt(
	records: readonly ProviderAvailability[],
	provider: string,
	subject: EntityID,
	date: ISODate
): AvailabilityAnswer {
	const mine = records.filter((record) => record.provider === provider && record.subject === subject)

	if (!mine.length) return { status: "unknown", records: [] }

	const current = mine.filter(
		(record) =>
			compareISODate(record.from, date) <= 0 && (record.to === undefined || compareISODate(date, record.to) <= 0)
	)

	if (current.length) return { status: "available", records: mine }

	const past = mine.filter((record) => record.to !== undefined && compareISODate(date, record.to) > 0)

	return { status: past.length ? "withdrawn" : "unknown", records: mine }
}
