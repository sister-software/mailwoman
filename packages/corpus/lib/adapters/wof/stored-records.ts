// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 * @file Reads the WOF adapters' records from the WOF record store, in WOF-id order, with each record's
 *   ancestors resolved by primary-key lookup.
 *
 *   The adapters used to hold every record of the input in one map so that any record's ancestors could
 *   be found. That map peaked at 14,883 MiB for `wof-admin` and `wof-postalcode` together. A record and its
 *   ancestors are now read from the store as they are needed. The ancestors that recur, the counties,
 *   regions and countries, stay in a bounded cache.
 */

import {
	refreshWOFRecordStore,
	storedWOFRecord,
	storedWOFRecords,
	wofRecordStorePathFor,
	wofRepositories,
	type WOFRecordStoreDatabase,
	type WOFRepoRefresh,
} from "@mailwoman/gazetteer/whosonfirst/record-store"
import { DatabaseClient } from "@mailwoman/sqlite/client"

import type { WOFRecordEntry } from "#adapters/wof/json-rows"
import type { AdapterOptions } from "#types"
import { readRefutedParentIDs, recordFromFeature, type WOFFeature, type WOFRecord } from "#utils/wof-json"

/**
 * The most ancestor records the lookup cache holds before it drops the least recently used.
 */
const ANCESTOR_CACHE_LIMIT = 500_000

/**
 * Options for {@linkcode openStoredRecordEntries}.
 */
export interface StoredRecordEntriesOptions<A extends object> {
	/**
	 * Whether a parsed record belongs to the reader's index: a record it renders,
	 * or one an ancestor walk may reach.
	 *
	 * The adapter's `--country` filter applies on top.
	 */
	keep: (record: WOFRecord) => boolean
	/**
	 * Whether a kept record is rendered.
	 *
	 * A record that's only an ancestor, such as an admin record read by `wof-postalcode`,
	 * is kept and not rendered.
	 */
	render?: (record: WOFRecord) => boolean
	/**
	 * The ancestors a rendered record's variants read, from a lookup that returns kept records only.
	 */
	resolve: (record: WOFRecord, lookup: (id: number) => WOFRecord | undefined) => A
	onRepo?: (refresh: WOFRepoRefresh) => void
}

/**
 * Opened entries over the store, and the handle that closes it.
 */
export interface StoredRecordEntries<A extends object> extends Disposable {
	entries: Iterable<WOFRecordEntry<A>>
}

/**
 * Refreshes the store for `opts.inputPath`, then returns the rendered records in ascending WOF-id order.
 *
 * A record is kept, rendered and resolved exactly as the in-memory index read it:
 * parsed by {@linkcode recordFromFeature}, filtered by `keep` and the country,
 * with ancestors found among kept records of the same repositories.
 */
export async function openStoredRecordEntries<A extends object>(
	opts: AdapterOptions,
	reader: StoredRecordEntriesOptions<A>
): Promise<StoredRecordEntries<A>> {
	const storePath = wofRecordStorePathFor(opts.inputPath)

	await refreshWOFRecordStore(storePath, opts.inputPath, { signal: opts.signal, onRepo: reader.onRepo })

	const repos = (await wofRepositories(opts.inputPath)).map((repo) => repo.basename())
	const inScope = new Set(repos)
	const refuted = await readRefutedParentIDs()
	const db = new DatabaseClient<WOFRecordStoreDatabase>(storePath, { readOnly: true })

	const parseKept = (feature: WOFFeature): WOFRecord | null => {
		const record = recordFromFeature(feature, refuted)

		if (!record || !reader.keep(record)) return null

		if (opts.country && record.country !== opts.country) return null

		return record
	}

	// A miss is cached as `null`, so an id outside the index is read from the store once.
	const cache = new Map<number, WOFRecord | null>()

	const lookup = (id: number): WOFRecord | undefined => {
		const cached = cache.get(id)

		if (cached !== undefined) {
			cache.delete(id)
			cache.set(id, cached)

			return cached ?? undefined
		}

		const stored = storedWOFRecord<WOFFeature>(db, id)
		const record = stored && inScope.has(stored.repo) ? parseKept(stored.feature) : null

		cache.set(id, record)

		if (cache.size > ANCESTOR_CACHE_LIMIT) {
			cache.delete(cache.keys().next().value!)
		}

		return record ?? undefined
	}

	function* entries(): Generator<WOFRecordEntry<A>> {
		for (const stored of storedWOFRecords<WOFFeature>(db, {
			repos,
			...(opts.country ? { country: opts.country } : {}),
		})) {
			if (opts.signal?.aborted) return
			const record = parseKept(stored.feature)

			if (!record || (reader.render && !reader.render(record))) continue

			yield { record, ancestors: reader.resolve(record, lookup) }
		}
	}

	return {
		entries: entries(),
		[Symbol.dispose]: () => db[Symbol.dispose](),
	}
}
