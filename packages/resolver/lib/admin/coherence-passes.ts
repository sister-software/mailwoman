/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The three post-walk admin coherence passes (#263 / #822 / the region-country pass) — split from
 *   `resolve.ts` on the `bare-toponym-race.ts` precedent: the walk file holds the walk, this one
 *   holds the joint-consistency re-picks that run after it. Each pass's contract, triggers, and
 *   byte-stability guarantees are documented on the pass itself; `resolveTree` sequences them.
 */

import { matchCountry, matchSubdivision } from "@mailwoman/codex/country"
import type { AddressNode } from "@mailwoman/core/decoder"
import type { ResolvedPlace, ResolverBackend } from "@mailwoman/core/resolver"

import { decorateNode, isResolvedWithCoord } from "#decorate-node"

/**
 * Admin descendant-consistency (#263) — the joint-consistency resolve, scoped to the admin assignment. The greedy walk
 * resolves a region on its own (name + population), so "ME" picks Messina (IT) over Maine, then scopes "Portland" to
 * Messina's descendants, finds nothing, and the result falls back to the region centroid (Sicily). The region's
 * same-named runner-ups (Maine, Missouri, …) were already captured as `alternatives`; this pass asks the question the
 * greedy order skipped — _which "ME" has a "Portland" under it?_ — and re-picks the (region, locality) pair where a
 * same-named locality descends from a same-named region candidate. Geography decides; no country prior, no list.
 *
 * Fires ONLY for a resolved region whose child locality fell through (the unresolved-locality signal), so a
 * well-resolved tree ("Springfield, IL" → Illinois, Springfield) is byte-identical. Costs one unscoped locality lookup
 * per triggering pair. Needs {@link ResolverBackend.ancestors}; no-op without it. See `ResolveOpts.adminCoherence`.
 */
export async function applyAdminCoherence(roots: readonly AddressNode[], backend: ResolverBackend): Promise<void> {
	const visit = async (node: AddressNode, regionAncestor: AddressNode | null): Promise<void> => {
		const regionHere = node.tag === "region" && isResolvedWithCoord(node) ? node : regionAncestor

		if (
			regionHere &&
			(node.tag === "locality" || node.tag === "dependent_locality") &&
			!isResolvedWithCoord(node) &&
			node.value.trim().length
		) {
			await reconcileAdminPair(regionHere, node, backend)
		}

		for (const child of node.children) {
			await visit(child, regionHere)
		}
	}

	for (const root of roots) {
		await visit(root, null)
	}
}

/**
 * Re-pick a (region, locality) pair so the locality descends from the region. `alternatives` on the node are the
 * `ResolvedPlace` runner-ups `decorateNode` attached (typed `unknown[]` in the decoder, which can't import resolver
 * types — the cast is sound). Picks the FIRST same-named locality (already score-ordered) that descends from a
 * same-named region candidate, then swaps both nodes. Leaves both untouched when no consistent pair exists (a genuinely
 * un-gazetteered locality — "Portland, VT" with no Portland in Vermont — stays as the region centroid, not a foreign
 * namesake).
 */
async function reconcileAdminPair(
	regionNode: AddressNode,
	localityNode: AddressNode,
	backend: ResolverBackend
): Promise<void> {
	// EXACT region matches only: the alternatives for a 2-letter token are loose ("ME" also surfaces
	// Missouri/Michigan/Mississippi as fuzzy M-state runner-ups). Restricting to exact name/alias matches
	// (Maine/Messina/Medway for "ME") keeps the join honest. `exactMatch` is stamped by exactMatchTiering.
	const regionCands = ((regionNode.alternatives as ResolvedPlace[] | undefined) ?? []).filter((r) => r.exactMatch)

	// For each exact region candidate, ask the gazetteer directly: is there a same-named locality UNDER it?
	// The `parentID` scope is the descendant test (over the #832-repaired ancestors table), and it finds the
	// instance regardless of its global population rank — "Springfield, ME" reaches the small Springfield in
	// Maine that an unscoped top-N window would drop. First region with an exact-named descendant wins; the
	// region candidates are score-ordered, so a tie breaks toward the more prominent place.
	for (const region of regionCands) {
		const scoped = await backend.findPlace({
			text: localityNode.value,
			placetype: "locality",
			parentID: region.id,
			limit: 3,
		})

		const lc = scoped.find((l) => l.exactMatch && !(l.lat === 0 && l.lon === 0))

		if (lc) {
			decorateNode(
				regionNode,
				region,
				regionCands.filter((r) => r !== region)
			)

			regionNode.metadata = { ...regionNode.metadata, admin_coherence_repicked: true }

			decorateNode(
				localityNode,
				lc,
				scoped.filter((l) => l !== lc)
			)

			localityNode.metadata = { ...localityNode.metadata, admin_coherence_repicked: true }

			return
		}
	}

	// #267 follow-up: the token may name a COUNTRY whose namesake is a more-populous foreign region — "Tbilisi,
	// Georgia" parses region("Georgia") → the US state, but Tbilisi descends from Georgia the COUNTRY. When no
	// region candidate holds the locality, try same-named country candidates: a foreign capital under its
	// country out-votes the state namesake. Needs the country + the locality's ancestry in the gazetteer (the
	// #267 admin fold). The re-picked region node then carries the country place; the locality coordinate wins.
	const countryCands = (await backend.findPlace({ text: regionNode.value, placetype: "country", limit: 3 })).filter(
		(c) => c.exactMatch
	)

	for (const country of countryCands) {
		const scoped = await backend.findPlace({
			text: localityNode.value,
			placetype: "locality",
			parentID: country.id,
			limit: 3,
		})

		const lc = scoped.find((l) => l.exactMatch && !(l.lat === 0 && l.lon === 0))

		if (lc) {
			decorateNode(regionNode, country, regionCands)
			regionNode.metadata = { ...regionNode.metadata, admin_coherence_repicked: true }

			decorateNode(
				localityNode,
				lc,
				scoped.filter((l) => l !== lc)
			)

			localityNode.metadata = { ...localityNode.metadata, admin_coherence_repicked: true }

			return
		}
	}

	// #1023: the admin gazetteer may carry NO `country`-placetype node for the token AND the same-named
	// foreign locality may be ORPHANED (parent_id = -1) — the 2026-07-07 rebuild flattened Georgia's admin
	// hierarchy to localities-only, so the country-node lookup above finds nothing and the `parentID`
	// descendant test can never reach Tbilisi. Fall back to matchCountry: normalize the token to an
	// ISO-3166 alpha-2 and scope the locality by the gazetteer's `country` COLUMN (set even on an orphaned
	// row). Same primitive reconcileExplicitCountry (#822) uses, so the region-parsed namesake path
	// ("Tbilisi, Georgia") converges with the country-parsed one ("Vienna, Austria"). matchCountry returns
	// null for a US state name/abbrev ("Illinois" / "ME" / "IL"), so a real US (region, locality) pair
	// never reaches here — this stays inert on the domestic path.
	const mc = matchCountry(regionNode.value)

	if (mc) {
		const scoped = await backend.findPlace({
			text: localityNode.value,
			placetype: "locality",
			country: mc.iso2,
			limit: 3,
		})

		const lc = scoped.find((l) => l.exactMatch && !(l.lat === 0 && l.lon === 0))

		if (lc) {
			decorateNode(
				localityNode,
				lc,
				scoped.filter((l) => l !== lc)
			)

			localityNode.metadata = { ...localityNode.metadata, admin_coherence_repicked: true }
			// The token named a foreign country the admin gazetteer has no node for, but the greedy walk had
			// already decorated the region node with the US-state namesake. Revert that stale decoration so the
			// node stops asserting the wrong-country coordinate + `resolver_country` (which would otherwise leak
			// into the result's `countryCode`); the re-picked locality carries the winning coordinate, and the
			// region node falls back to the parsed "Georgia" token, unresolved (the admin DB has nothing truer).
			revertResolverDecoration(regionNode)
		}
	}
}

/**
 * Undo a resolver decoration on a node: restore the classifier attribution {@link decorateNode} displaced into
 * `metadata.classifier_source(_id)` and drop the resolver-supplied coordinate/identity/alternatives. Used by the #1023
 * country fall-through when the region token turns out to name a foreign country the admin gazetteer holds no node for
 * — the greedy walk had bound it to the US-state namesake, and that stale claim must not survive the locality re-pick.
 */
function revertResolverDecoration(node: AddressNode): void {
	const meta = { ...node.metadata }
	const priorSource = meta["classifier_source"]
	const priorSourceID = meta["classifier_source_id"]
	node.source = typeof priorSource === "string" ? priorSource : undefined
	node.sourceID = typeof priorSourceID === "string" ? priorSourceID : undefined

	for (const key of [
		"classifier_source",
		"classifier_source_id",
		"resolver_score",
		"resolver_prominence",
		"resolver_name",
		"resolver_country",
		"resolution_quality",
		"postcode_city_mismatch",
	]) {
		// oxlint-disable-next-line typescript/no-dynamic-delete -- removing one key from a plain record; the object is not on a hot path
		delete meta[key]
	}

	node.metadata = meta
	node.lat = undefined
	node.lon = undefined
	node.placeID = undefined
	node.alternatives = undefined
}

/**
 * Explicit-country coherence (#822) — the joint-consistency resolve keyed on the query's own EXPLICIT country token.
 * The greedy walk resolves a locality on name + population alone, so "Vienna, Austria" picks the populous US namesake
 * (Vienna WV) and IGNORES the "Austria" the address named. This pass asks the question the greedy order skipped —
 * _which "Vienna" is in the country the address names?_ — and re-picks the locality to the same-named place under that
 * country. The country code comes from the parser's OWN `country` emission via codex's ISO-3166 table (a name→code
 * normalization of a token the model already classified, NOT a routing prior or safelist); the gazetteer's `country`
 * column does the geographic confirmation. No pin, no list; generalizes to every country.
 *
 * Disjoint from {@link applyAdminCoherence} by the region guard: that pass owns the case where a REGION scopes the
 * locality; this one fires only when the explicit country is the locality's nearest admin context (no region between),
 * and then regardless of the locality's resolution state — so it covers both the resolved-but-foreign locality (Sydney
 * → the greedy AU pick was wrong) and the unresolved locality the span-rescore tier would otherwise back-fill with the
 * US namesake (Vienna → Vienna WV). Byte-stable when the locality already resolved in-country (the id guard) or the
 * named country holds no same-named locality (the fail-safe — what also protects "Turkey, TX": no country token ⇒ no
 * trigger; and an in-country lookup that finds nothing keeps the greedy result). Costs one country-scoped locality
 * lookup per triggering pair. See `ResolveOpts.adminCoherence`.
 */
export async function applyExplicitCountryCoherence(
	roots: readonly AddressNode[],
	backend: ResolverBackend
): Promise<void> {
	const visit = async (node: AddressNode, countryToken: AddressNode | null, regionAbove: boolean): Promise<void> => {
		const countryHere = node.tag === "country" && node.value.trim().length ? node : countryToken

		// A region suppresses the country re-pick only when it RESOLVED: the suppression's rationale is
		// that applyAdminCoherence + the region's `parentID` scope already disambiguate the locality
		// ("Springfield, IL" must not re-pick to the most populous US Springfield), and an UNRESOLVED
		// region disambiguates nothing — 'NIC-38' (an ISO-3166-2 code the gazetteer holds no node for)
		// silently swallowed the explicit 'Nicaragua', and El Sauce resolved a US namesake. This pass
		// runs post-walk, so resolution state is known.
		const regionHere = regionAbove || ((node.tag === "region" || node.tag === "subregion") && isResolvedWithCoord(node))

		// Fire only when the explicit country is the locality's NEAREST RESOLVED admin context.
		// Fires regardless of the locality's resolution state, so it PRE-EMPTS the span-rescore tier
		// (which would otherwise back-fill the unresolved locality with the US namesake).
		if (countryHere && !regionHere && (node.tag === "locality" || node.tag === "dependent_locality")) {
			await reconcileExplicitCountry(countryHere, node, backend)
		}

		for (const child of node.children) {
			await visit(child, countryHere, regionHere)
		}
	}

	for (const root of roots) {
		await visit(root, null, false)
	}
}

/**
 * Re-pick a resolved locality to its same-named place UNDER the explicitly-named country. `matchCountry` turns the
 * country token into an ISO-3166 alpha-2 (returns null for an unrecognized token → no-op); the backend then surfaces
 * the in-country namesake the population-first unscoped window buried. Leaves the node untouched when the country is
 * unrecognized, the named country has no exact same-named locality (the fail-safe), or the locality already resolved to
 * that place (the id guard → byte-stable). The country node itself stays as the parser emitted it — the named
 * well-covered countries carry no `country`-placetype row in the admin gazetteer, so there is nothing to decorate it
 * with; the locality coordinate is what the re-pick fixes.
 */
async function reconcileExplicitCountry(
	countryNode: AddressNode,
	localityNode: AddressNode,
	backend: ResolverBackend
): Promise<void> {
	const mc = matchCountry(countryNode.value)

	if (!mc) return

	const scoped = await backend.findPlace({
		text: localityNode.value,
		placetype: "locality",
		country: mc.iso2,
		limit: 3,
	})

	const lc = scoped.find((l) => l.exactMatch && !(l.lat === 0 && l.lon === 0))

	if (!lc) return

	// Already the in-country place? (placeID encodes the WOF id.) Then the greedy walk was right — byte-stable.
	if (localityNode.placeID === `wof:${lc.id}`) return

	decorateNode(
		localityNode,
		lc,
		scoped.filter((l) => l !== lc)
	)

	localityNode.metadata = { ...localityNode.metadata, explicit_country_repicked: true }
}

/**
 * Region-country coherence — the joint-consistency resolve keyed on a REGION token the locale-inferred default-country
 * filter could not resolve. Companion to {@link applyExplicitCountryCoherence} (which keys on an explicit COUNTRY token)
 * and disjoint from {@link applyAdminCoherence} (which needs a region that DID resolve): this pass owns the mirror case,
 * where the region qualifier is a foreign subdivision the default-country hard filter (`spr.country = ?`) discarded.
 *
 * "Montreal QC" under a US locale: the walk applies `defaultCountry="US"` as a hard candidate filter to every admin
 * lookup, so the region "QC" (a Canadian subdivision) resolves to nothing and is dropped — the one signal that would
 * redirect the country to CA — and the locality "Montreal" is force-matched to the populous US namesake (Montreal, WI).
 * The greedy order threw away the evidence that could correct it.
 *
 * The fix expands the region token to its country via codex's ISO-3166-2 subdivision table (`matchSubdivision`: "QC" →
 * `{ name: "Quebec", country: "CA" }`, handling the FTS index's missing "QC" alt-name code-side), then asks the two
 * questions the greedy walk skipped: does that subdivision genuinely resolve UNDER its own country, and is there a
 * same-named locality under it? Only when BOTH hold does it swap the region and locality to the in-country pair.
 * Geography confirms; the subdivision table is a soft name→country prior, not a routing decision.
 *
 * Evidence-conditional to stay byte-stable on the domestic path. It fires ONLY when (a) a default country is in force,
 * (b) the region node is UNRESOLVED (the default-country filter came up empty — a US region resolves fine under `US`,
 * so a well-formed US query never trips this), (c) the token is a subdivision of a DIFFERENT country than the default,
 * and (d) both the foreign region and a same-named foreign locality resolve. "Springfield, IL" / "Portland, ME": the
 * region resolves under `US`, so gate (b) fails and the tree is untouched. Costs one region + one locality lookup per
 * triggering pair. See `ResolveOpts.adminCoherence`.
 */
export async function applyRegionCountryCoherence(
	roots: readonly AddressNode[],
	backend: ResolverBackend,
	defaultCountry: string | undefined
): Promise<void> {
	// No default country → no hard country filter was applied, so no region qualifier was discarded by one. The bug
	// this pass corrects is specific to the locale-inferred default country; without it, there is nothing to rescue.
	if (!defaultCountry) return

	const visit = async (node: AddressNode, regionAncestor: AddressNode | null): Promise<void> => {
		// Track the nearest region ancestor regardless of its resolution state (the trigger is an UNRESOLVED region).
		const regionHere = node.tag === "region" || node.tag === "subregion" ? node : regionAncestor

		// Fire for an UNRESOLVED region (the default-country filter came up empty) whose companion locality node
		// exists — regardless of the locality's resolution state, so it covers both the resolved-but-foreign namesake
		// (Montreal → the greedy US pick, Montreal WI) and the unresolved locality the span-rescore tier would
		// otherwise back-fill with a US namesake. The in-country lookups below are the evidence gate.
		if (
			regionHere &&
			!isResolvedWithCoord(regionHere) &&
			(node.tag === "locality" || node.tag === "dependent_locality") &&
			node.value.trim().length
		) {
			await reconcileRegionCountry(regionHere, node, backend, defaultCountry)
		}

		for (const child of node.children) {
			await visit(child, regionHere)
		}
	}

	for (const root of roots) {
		await visit(root, null)
	}
}

/**
 * Re-pick an (unresolved region, resolved-but-foreign-namesake locality) pair to the in-country instance the
 * default-country filter hid. `matchSubdivision` turns the region token into `{ name, country }` (null for anything
 * that isn't a US state or CA province → no-op); the region's full name then resolves it under that country (expanding
 * the abbreviation the gazetteer FTS index lacks), and the locality is re-scoped to the same country. Leaves both nodes
 * untouched unless every check holds — the subdivision names a different country than the default, the region resolves
 * under it, and a same-named locality exists there — so the domestic path stays byte-identical.
 */
async function reconcileRegionCountry(
	regionNode: AddressNode,
	localityNode: AddressNode,
	backend: ResolverBackend,
	defaultCountry: string
): Promise<void> {
	const sub = matchSubdivision(regionNode.value)

	if (!sub) return

	// The subdivision must belong to a DIFFERENT country than the locale default. A US-state token under a US default
	// (sub.country === defaultCountry) never reaches the swap — the pass is inert on the domestic path.
	if (sub.country.toUpperCase() === defaultCountry.toUpperCase()) return

	// The locality already resolved in the subdivision's country? Then the greedy walk was already right — byte-stable.
	const localityCountry = (localityNode.metadata?.["resolver_country"] as string | undefined)?.toUpperCase()

	if (localityCountry === sub.country.toUpperCase()) return

	// Confirm the subdivision genuinely resolves under its own country, by its full name (expands "QC" → "Quebec", the
	// form the FTS index carries). No resolvable region → no evidence the token is a real foreign subdivision; abstain.
	const regionScoped = await backend.findPlace({
		text: sub.name,
		placetype: "region",
		country: sub.country,
		limit: 3,
	})

	const rc = regionScoped.find((r) => r.exactMatch && !(r.lat === 0 && r.lon === 0))

	if (!rc) return

	// Is there a same-named locality under that country? (the descendant test, by country column — the same primitive
	// reconcileExplicitCountry uses.) No in-country namesake → keep the greedy result (fail-safe).
	const scoped = await backend.findPlace({
		text: localityNode.value,
		placetype: "locality",
		country: sub.country,
		limit: 3,
	})

	const lc = scoped.find((l) => l.exactMatch && !(l.lat === 0 && l.lon === 0))

	if (!lc) return

	// Adopt the in-country pair: the region gets the foreign subdivision, the locality its same-named foreign instance.
	decorateNode(
		regionNode,
		rc,
		regionScoped.filter((r) => r !== rc)
	)

	regionNode.metadata = { ...regionNode.metadata, region_country_repicked: true }

	decorateNode(
		localityNode,
		lc,
		scoped.filter((l) => l !== lc)
	)

	localityNode.metadata = { ...localityNode.metadata, region_country_repicked: true }
}
