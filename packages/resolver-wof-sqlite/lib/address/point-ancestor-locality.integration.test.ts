/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file The New York State register stores every New York City row under `new york`, so a query naming a borough or a
 *   neighborhood reaches its address point only through the resolved locality's WOF ancestors. Runs against the
 *   host's candidate table and New York register, and skips when either is absent.
 */

import type { BIOLabel } from "@mailwoman/codex/component"
import { buildAddressTree, collectNodes } from "@mailwoman/core/decoder"
import type { DecoderToken } from "@mailwoman/core/decoder/types"
import { pathExists } from "@mailwoman/core/fs/readers/stat"
import { createWOFResolver } from "@mailwoman/resolver"
import { describe, expect, test } from "vitest"

import { AddressPointSqliteLookup } from "#address"
import { WOFCandidateTableLookup } from "#candidate/lookup"
import { addressPointDatabasePath, wofDatabasePath } from "#paths"

const candidatePath = wofDatabasePath("candidate.db")
const registerPath = addressPointDatabasePath("address-points-us-ny.db")
const hasStack = (await pathExists(candidatePath)) && (await pathExists(registerPath))

/**
 * Builds the tree for `<number> <street> <suffix>, <locality>, NY` with each span labeled.
 */
function nycTree(number: string, street: string, suffix: string, locality: string) {
	const raw = `${number} ${street} ${suffix}, ${locality}, NY`

	const spans: Array<[string, BIOLabel]> = [
		[number, "B-house_number"],
		[street, "B-street"],
		[suffix, "B-street_suffix"],
		[locality, "B-locality"],
		["NY", "B-region"],
	]

	let cursor = 0

	const tokens = spans.map(([piece, label]): DecoderToken => {
		const start = raw.indexOf(piece, cursor)
		cursor = start + piece.length

		return { piece, start, end: cursor, label, confidence: 0.9 }
	})

	return buildAddressTree(raw, tokens)
}

describe.skipIf(!hasStack)("an address keyed to an ancestor of the parsed locality", () => {
	test.each([
		["34-60", "48th", "St", "Long Island City"],
		["716", "Ocean", "Ave", "Brooklyn"],
	])("%s %s %s, %s reaches its address point inside the parsed place", async (number, street, suffix, locality) => {
		using backend = new WOFCandidateTableLookup({ databasePath: candidatePath })
		using register = new AddressPointSqliteLookup(registerPath)

		const resolved = await createWOFResolver(backend).resolveTree(nycTree(number, street, suffix, locality), {
			addressPoints: register,
		})

		const [place] = collectNodes(resolved.roots, (n) => n.tag === "locality")
		const [streetNode] = collectNodes(resolved.roots, (n) => n.tag === "street")
		const box = place?.metadata?.["resolver_bbox"] as { minLat: number; maxLat: number; minLon: number; maxLon: number }
		const point = streetNode?.metadata?.["address_point"] as { lat: number; lon: number } | undefined

		expect(streetNode?.metadata?.["resolution_tier"]).toBe("address_point")
		expect(streetNode?.metadata?.["address_point_ancestor_locality"]).toBeTruthy()
		expect(point!.lat).toBeGreaterThanOrEqual(box.minLat)
		expect(point!.lat).toBeLessThanOrEqual(box.maxLat)
		expect(point!.lon).toBeGreaterThanOrEqual(box.minLon)
		expect(point!.lon).toBeLessThanOrEqual(box.maxLon)
	})
})
