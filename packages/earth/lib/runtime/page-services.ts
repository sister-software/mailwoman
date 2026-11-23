// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   The range-read handles the map page opens on demand, as services on an `async-init` registry.
 *
 *   Each handle runs a dedicated worker with its own sqlite-wasm heap.
 *   The registry opens a handle on the first read, shares that open with every later read,
 *   forgets an open that failed, and closes the handle when the page's scope is disposed.
 *
 *   A read that fails on an open handle invalidates the service.
 *   The registry then closes that handle's worker, and the next read opens a new one.
 */

import { AbortKind, AbortReason } from "@mailwoman/core/async/abort"
import type { MailwomanLookupLike } from "@mailwoman/resolver-wof-wasm/browser-cascade"
import { createToken, ServiceRegistry, type ServiceToken } from "async-init"
import { openCandidateTableLookup } from "mailwoman/browser-runtime/load-assets"
import { wofPolygonsURL } from "mailwoman/browser-runtime/resources"

import { type Gazetteer, openGazetteer } from "#explorers/Gazette/gazetteer"
import { loadPolygonDB, type PolygonDB } from "#runtime/basemap"

/**
 * The token of the crisp-polygon database.
 */
export const PolygonDatabaseService: ServiceToken<PolygonDB> = createToken("polygon-database")

/**
 * The token of the gazetteer handle a `wof:` query reads the containment chain through.
 */
export const GazetteerService: ServiceToken<Gazetteer> = createToken("gazetteer")

/**
 * The token of the candidate-table lookup the resolver reads places through.
 *
 * A release bundle reads it and never closes it, so a classifier reload keeps the open lookup.
 * An invalidation closes it, and the next read opens a new one.
 */
export const CandidateLookupService: ServiceToken<MailwomanLookupLike | null> = createToken("candidate-lookup")

/**
 * What a page scope opens its handles with, so a test can count opens and closes.
 */
interface PageServiceOpeners {
	openPolygons: (sqliteRuntimeBaseURL: string) => Promise<PolygonDB>
	openGazetteer: (sqliteRuntimeBaseURL: string) => Promise<Gazetteer>
	openCandidateLookup: (sqliteRuntimeBaseURL: string) => Promise<MailwomanLookupLike | null>
}

const BROWSER_OPENERS: PageServiceOpeners = {
	openPolygons: (sqliteRuntimeBaseURL) => loadPolygonDB(wofPolygonsURL(), sqliteRuntimeBaseURL),
	openGazetteer,
	openCandidateLookup: (sqliteRuntimeBaseURL) => openCandidateTableLookup(sqliteRuntimeBaseURL),
}

/**
 * Defines the page's range-read handles on a new registry, opened from the staged
 * sqlite runtime at `sqliteRuntimeBaseURL`.
 */
export function createPageScope(
	sqliteRuntimeBaseURL: string,
	openers: PageServiceOpeners = BROWSER_OPENERS
): ServiceRegistry {
	const scope = new ServiceRegistry()

	scope.define(PolygonDatabaseService, {
		build: () => openers.openPolygons(sqliteRuntimeBaseURL),
		release: (polygons) => polygons.close(),
	})

	scope.define(GazetteerService, {
		build: () => openers.openGazetteer(sqliteRuntimeBaseURL),
		release: (gazetteer) => gazetteer.database.close?.(),
	})

	scope.define(CandidateLookupService, {
		build: () => openers.openCandidateLookup(sqliteRuntimeBaseURL),
		release: (lookup) => lookup?.close?.(),
	})

	return scope
}

/**
 * The candidate lookup a release bundle shows, with the reason it's missing.
 */
export interface CandidateLookupReading {
	lookup: MailwomanLookupLike | null
	/**
	 * Why the lookup failed to open, or `null` when it opened.
	 */
	gazetteerError: string | null
}

/**
 * Closes the open candidate lookup and opens a new one.
 *
 * The old lookup's range worker ends before the new one starts, so the page holds
 * one sqlite-wasm heap for the lookup at a time.
 * A failed open resolves with a null lookup and the reason, and the next read of the service tries again.
 */
export async function reopenCandidateLookup(scope: ServiceRegistry): Promise<CandidateLookupReading> {
	try {
		await scope.invalidate(CandidateLookupService, new AbortReason(AbortKind.Superseded))

		return { lookup: await scope.resolve(CandidateLookupService), gazetteerError: null }
	} catch (error) {
		return { lookup: null, gazetteerError: error instanceof Error ? error.message : String(error) }
	}
}

/**
 * Invalidates a service after a read on `handle` failed, when `handle` is still the service's open instance.
 *
 * The registry then closes that handle, and the next read opens a new one.
 *
 * A closed handle rejects the reads still in flight on it, and each of those
 * reads reports its own failure here.
 * By then another read may have opened a newer handle.
 *
 * The comparison keeps a failure on a closed handle from closing the newer one.
 */
export function retireFailedHandle<T extends object>(
	scope: ServiceRegistry,
	token: ServiceToken<T>,
	handle: T,
	reason: unknown
): void {
	if (scope.get(token).instance !== handle) return

	void scope.invalidate(token, reason).catch(() => {})
}
