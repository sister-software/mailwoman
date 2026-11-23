// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 * @file The resolver that gives a POI query's anchor its coordinates, as `mailwoman poi` and the POI board build it.
 */

import { allKeyed } from "@mailwoman/core/promises"
import type { Resolver } from "@mailwoman/core/resolver"

import { createResolverBackend, resolvePOIResolverPaths } from "#engine/resolver-backend"

/**
 * The gazetteer backend an anchor resolver reads.
 */
export type POIAnchorBackend = "candidate" | "wof-fts"

/**
 * An open anchor resolver.
 * Its disposal closes the gazetteer backend.
 */
export interface POIAnchorResolver extends Disposable {
	resolver: Resolver
	/**
	 * The backend that was built.
	 *
	 * `createResolverBackend` chooses it, so the caller's options don't state it.
	 */
	backend: POIAnchorBackend
}

/**
 * Why {@linkcode openPOIAnchorResolver} opened no resolver.
 *
 * - `unconfigured`: no candidate gazetteer and no WOF admin database resolved.
 * - `unavailable`: `@mailwoman/resolver-wof-sqlite` didn't load, or the backend failed to open.
 */
export type POIAnchorResolverAbsence = "unconfigured" | "unavailable"

/**
 * Opens the resolver for a POI query's anchor, such as `Springfield IL` in `hospital near Springfield IL`.
 *
 * The candidate gazetteer answers when one resolves: `candidateDB`, then
 * `$MAILWOMAN_CANDIDATE_DB`, then the active selection's, then the conventional path.
 * Otherwise the WOF admin databases answer: `resolveDB`, else the active selection's
 * extracts, else the conventional set, each kept when it exists.
 *
 * An anchor is resolved from its parsed tree and never geocoded, so this builds
 * the gazetteer backend with zero geocode session.
 * `withResolver` in `cli/commands/parse.tsx` states what a session would cost in its place.
 *
 * @returns The resolver, or the reason it didn't open.
 * Without one an anchored query abstains with `anchor_required`.
 */
export async function openPOIAnchorResolver(options: {
	candidateDB?: string
	resolveDB?: string
}): Promise<POIAnchorResolver | POIAnchorResolverAbsence> {
	const { candidateDB, wofPaths } = await resolvePOIResolverPaths(options)

	if (!candidateDB && !wofPaths.length) return "unconfigured"

	try {
		const {
			mod,
			resolver: { createWOFResolver },
		} = await allKeyed({
			mod: import("@mailwoman/resolver-wof-sqlite"),
			resolver: import("@mailwoman/resolver"),
		})

		const lookup = await createResolverBackend(mod, { candidateDB: options.candidateDB, wofPaths })

		return {
			resolver: createWOFResolver(lookup),
			backend: lookup instanceof mod.WOFCandidateTableLookup ? "candidate" : "wof-fts",
			[Symbol.dispose]: () => lookup[Symbol.dispose](),
		}
	} catch {
		return "unavailable"
	}
}
