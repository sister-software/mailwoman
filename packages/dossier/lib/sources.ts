/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   A source record is the document a claim cites. It carries the publisher, a title, and the three time
 *   concepts, so a dossier can say when a fact was observed, when the record became available, and when
 *   this application read it.
 */

import type { SourceTime } from "#time"

export type SourceRecordID = string

export interface SourceRecord extends SourceTime {
	id: SourceRecordID
	publisher: string
	title: string
	url?: string
}

export function sourceIndex(records: readonly SourceRecord[]): ReadonlyMap<SourceRecordID, SourceRecord> {
	const index = new Map<SourceRecordID, SourceRecord>()

	for (const record of records) {
		if (index.has(record.id)) throw new Error(`sourceIndex: duplicate source id ${record.id}`)

		index.set(record.id, record)
	}

	return index
}
