/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Tests for {@link stampNameRoles} — pass 3c of the candidate build, whose two detectors decide
 *   which alias rows carry a `name_role`.
 *
 *   Each case is one of the checks the detectors are made of, because the failure mode is a check
 *   quietly widening: `gloss` is an ANOMALY signal that must never reach a place with measured
 *   prominence or an admin placetype (a country legitimately carries a name in every language), and
 *   `abbr` is a PROVENANCE signal that must never reach a variant recorded in a language the country
 *   does not speak. Both stamp non-primary rows only.
 */

import {
	CANDIDATE_COLUMNS,
	type CandidateDatabase,
	createCandidateStagingTables,
} from "@mailwoman/resolver-wof-sqlite/candidate-schema"
import { GLOSS_EXCLUDED_PLACETYPES, stampNameRoles } from "@mailwoman/resolver-wof-sqlite/candidate/name-roles"
import type { PlaceAttrs } from "@mailwoman/resolver-wof-sqlite/candidate/place-attrs"
import type { WOFDatabase } from "@mailwoman/resolver-wof-sqlite/schema"
import { allRows } from "@mailwoman/resolver-wof-sqlite/sqlite-utils"
import { normalizeLocalityForKey } from "@mailwoman/resolver-wof-sqlite/street"
import { DatabaseClient } from "@mailwoman/sqlite/client"
import { describe, expect, test } from "vitest"

const CCODES = new Map([
	["FR", 0],
	["US", 1],
	["ES", 2],
])

const PTCODES = new Map([
	["locality", 0],
	["country", 1],
])

/**
 * Fixture-scale stand-in for {@link GLOSS_KEY_THRESHOLD}: the production threshold is a property of the real key
 * distribution, so a test that reused it would need 50 aliases per place to say anything.
 */
const THRESHOLD = 3

interface PlaceSpec {
	sid: number
	name: string
	country: "FR" | "US" | "ES"
	placetype: "locality" | "country"
	pop?: number
	imp?: number | null
	aliases: string[]
}

interface NameSpec {
	sid: number
	name: string
	language: string
	privateuse?: string
}

/**
 * Stage each place's primary row plus one non-primary row per alias, then run the detectors over the result and read
 * the stamps back.
 */
async function stamp(places: PlaceSpec[], names: NameSpec[] | undefined) {
	using src = DatabaseClient.temp<WOFDatabase>()
	using kdb = DatabaseClient.temp<CandidateDatabase>()

	await createCandidateStagingTables(kdb)

	if (names) {
		src.exec(
			"CREATE TABLE names (id INTEGER NOT NULL, name TEXT NOT NULL, language TEXT NOT NULL DEFAULT '', privateuse TEXT NOT NULL DEFAULT '')"
		)

		const insert = src.prepare("INSERT INTO names VALUES (?, ?, ?, ?)")

		for (const n of names) {
			insert.run(n.sid, n.name, n.language, n.privateuse ?? "")
		}
	}

	const attrs = new Map<number, PlaceAttrs>()
	const keyCounts = new Map<number, number>()
	const insStage = kdb.prepare(`INSERT INTO cand_stage VALUES (${CANDIDATE_COLUMNS.map(() => "?").join(", ")})`)

	for (const spec of places) {
		const pkey = normalizeLocalityForKey(spec.name)

		const a: PlaceAttrs = {
			cid: CCODES.get(spec.country)!,
			rid: 0,
			ptid: PTCODES.get(spec.placetype)!,
			name: spec.name,
			lat: 0,
			lon: 0,
			mnLat: 0,
			mnLon: 0,
			mxLat: 0,
			mxLon: 0,
			pop: spec.pop ?? 0,
			neg: 0,
			pkey,
			imp: spec.imp ?? null,
		}

		attrs.set(spec.sid, a)

		const keys = [pkey, ...spec.aliases.map((alias) => normalizeLocalityForKey(alias))]

		for (const [i, key] of keys.entries()) {
			insStage.run(
				key,
				a.cid,
				a.rid,
				a.ptid,
				a.neg,
				spec.sid,
				a.name,
				0,
				0,
				0,
				0,
				0,
				0,
				a.pop,
				i === 0 ? 1 : 0,
				a.imp,
				null
			)
		}

		keyCounts.set(spec.sid, new Set(keys).size)
	}

	const messages: string[] = []

	const result = stampNameRoles({
		src,
		out: kdb,
		attrs,
		keyCounts,
		glossThreshold: THRESHOLD,
		ptcodes: PTCODES,
		ccodes: CCODES,
		progress: (_phase, message) => messages.push(message),
	})

	const rows = allRows<{
		spr_id: number
		name_key: string
		is_primary: number
		name_role: string | null
	}>(kdb.prepare("SELECT spr_id, name_key, is_primary, name_role FROM cand_stage"))

	const roleOf = new Map(rows.map((r) => [`${r.spr_id}:${r.name_key}`, r.name_role]))

	return { ...result, rows, roleOf, messages }
}

describe("stampNameRoles: the gloss anomaly detector", () => {
	test("stamps the alias rows of a key-tail place with no measured prominence", async () => {
		const { roleGloss, rows, roleOf } = await stamp(
			[{ sid: 1, name: "Poisson", country: "FR", placetype: "locality", aliases: ["Fish", "Pesce", "Pescado"] }],
			[]
		)

		expect(roleGloss).toBe(3)
		expect(roleOf.get("1:poisson")).toBeNull()
		expect(rows.filter((r) => r.name_role === "gloss").every((r) => r.is_primary === 0)).toBe(true)
	})

	test("refuses a place below the key-count threshold", async () => {
		const { roleGloss, keyTailPlaces } = await stamp(
			[{ sid: 1, name: "Poisson", country: "FR", placetype: "locality", aliases: ["Fish"] }],
			[]
		)

		expect(keyTailPlaces).toBe(0)
		expect(roleGloss).toBe(0)
	})

	test("prominence rescues a famous place — population OR a measured importance", async () => {
		const { roleGloss, keyTailPlaces } = await stamp(
			[
				{
					sid: 1,
					name: "New York",
					country: "US",
					placetype: "locality",
					pop: 8_000_000,
					aliases: ["Nueva York", "Nova Iorque", "Neuyork"],
				},
				{
					sid: 2,
					name: "Sunday",
					country: "US",
					placetype: "locality",
					imp: 0.4,
					aliases: ["Dimanche", "Domingo", "Sonntag"],
				},
			],
			[]
		)

		// Both are in the tail the detector reports on; neither is stamped.
		expect(keyTailPlaces).toBe(2)
		expect(roleGloss).toBe(0)
	})

	test("never flags an admin placetype, where an exonym set is the expected shape", async () => {
		expect(GLOSS_EXCLUDED_PLACETYPES.has("country")).toBe(true)

		const { roleGloss, keyTailPlaces } = await stamp(
			[
				{
					sid: 1,
					name: "France",
					country: "FR",
					placetype: "country",
					aliases: ["Francia", "Frankreich", "Frankrijk"],
				},
			],
			[]
		)

		expect(keyTailPlaces).toBe(1)
		expect(roleGloss).toBe(0)
	})
})

describe("stampNameRoles: the abbr provenance detector", () => {
	test("stamps a variant recorded in one of the country's official languages", async () => {
		const { roleAbbr, roleOf } = await stamp(
			[{ sid: 1, name: "Toledo", country: "ES", placetype: "locality", aliases: ["Tolete"] }],
			[{ sid: 1, name: "Tolete", language: "spa", privateuse: "variant" }]
		)

		expect(roleAbbr).toBe(1)
		expect(roleOf.get("1:tolete")).toBe("abbr")
	})

	test("refuses a variant in a language the country does not speak", async () => {
		const { roleAbbr, roleOf } = await stamp(
			[{ sid: 1, name: "Toledo", country: "ES", placetype: "locality", aliases: ["Tolete"] }],
			[{ sid: 1, name: "Tolete", language: "cat", privateuse: "variant" }]
		)

		expect(roleAbbr).toBe(0)
		expect(roleOf.get("1:tolete")).toBeNull()
	})

	test("takes an abbreviation/short name by KIND, whatever language column it arrives in", async () => {
		const { roleAbbr, roleOf } = await stamp(
			[{ sid: 1, name: "Toledo", country: "ES", placetype: "locality", aliases: ["TO", "Tol"] }],
			[
				{ sid: 1, name: "TO", language: "abbr" },
				{ sid: 1, name: "Tol", language: "short" },
			]
		)

		expect(roleAbbr).toBe(2)
		expect(roleOf.get("1:to")).toBe("abbr")
		expect(roleOf.get("1:tol")).toBe("abbr")
	})

	test("wins the row where both detectors fire — gloss only fills what abbr left unclaimed", async () => {
		const { roleAbbr, roleGloss, roleOf } = await stamp(
			[{ sid: 1, name: "Poisson", country: "FR", placetype: "locality", aliases: ["Fish", "Pesce", "Pescado"] }],
			[{ sid: 1, name: "Fish", language: "eng", privateuse: "variant" }]
		)

		expect(roleAbbr).toBe(1)
		expect(roleOf.get("1:fish")).toBe("abbr")
		// The other two alias rows still take the anomaly stamp.
		expect(roleGloss).toBe(2)
		expect(roleOf.get("1:pesce")).toBe("gloss")
	})

	test("says so when the source carries no `names` table, and still runs the gloss detector", async () => {
		const { roleAbbr, roleGloss, messages } = await stamp(
			[{ sid: 1, name: "Poisson", country: "FR", placetype: "locality", aliases: ["Fish", "Pesce", "Pescado"] }],
			undefined
		)

		expect(roleAbbr).toBe(0)
		expect(roleGloss).toBe(3)
		// Zero abbr stamps from a skipped detector is a different fact from zero variants found.
		expect(messages.some((m) => m.includes("no `names` table"))).toBe(true)
	})
})

describe("stampNameRoles: the key-tail census", () => {
	test("reports the stamped fraction with its denominator", async () => {
		const { keyTailPlaces, keyTailWithRole } = await stamp(
			[
				{ sid: 1, name: "Poisson", country: "FR", placetype: "locality", aliases: ["Fish", "Pesce", "Pescado"] },
				{
					sid: 2,
					name: "New York",
					country: "US",
					placetype: "locality",
					pop: 8_000_000,
					aliases: ["Nueva York", "Nova Iorque", "Neuyork"],
				},
				{ sid: 3, name: "Toledo", country: "ES", placetype: "locality", aliases: ["Tolete"] },
			],
			[]
		)

		// Toledo is below the threshold, so it is not in the denominator; New York is, and carries no role.
		expect(keyTailPlaces).toBe(2)
		expect(keyTailWithRole).toBe(1)
	})
})
