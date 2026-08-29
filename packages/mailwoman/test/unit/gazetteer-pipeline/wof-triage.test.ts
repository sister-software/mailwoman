/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Tests for the WOF currency triage. The fixture is the Medway cluster that motivated the pass — the real four
 *   records, with their real currency states — plus the legal-form and ghost-town shapes the ledger must tell apart.
 *
 *   The required assertion is the containment verdict: a same-NAME-STRING test called 21,010 US rows holes, and the
 *   samples were `Commonwealth of Pennsylvania` and `Town of Cary`. If containment stops working, the ledger's hole
 *   count silently inflates by an order of magnitude and every review built on it is wrong.
 */

import { mkdtemp, rm, writeFile } from "@mailwoman/platform/fs/promises"
import { tmpdir } from "@mailwoman/platform/os"
import { join } from "@mailwoman/platform/path"
import type { WOFDatabase } from "@mailwoman/resolver-wof-sqlite/schema"
import { DatabaseClient } from "@mailwoman/sqlite/client"
import { CoverageVerdict, CurrencyClass, triageWOFCurrency } from "mailwoman/gazetteer-pipeline/wof-triage"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

let scratch: string

beforeEach(async () => {
	scratch = await mkdtemp(join(tmpdir(), "wof-triage-"))
})

afterEach(async () => {
	await rm(scratch, { recursive: true, force: true })
})

/**
 * A minimal admin gazetteer in the shape the triage reads.
 */
function buildFixtureAdmin(path: string): void {
	using db = new DatabaseClient<WOFDatabase>(path)

	db.exec(`
		CREATE TABLE spr (
			id INTEGER PRIMARY KEY, name TEXT, placetype TEXT, country TEXT,
			latitude REAL, longitude REAL,
			is_current INTEGER, is_deprecated INTEGER, is_superseded INTEGER NOT NULL DEFAULT 0
		);
		CREATE TABLE place_population (id INTEGER PRIMARY KEY, population INTEGER NOT NULL DEFAULT 0);

		-- The Medway cluster, real states: Chatham survived, Rochester + Gillingham were deprecated with no
		-- successor, and the replacement Medway localadmin is itself not current.
		INSERT INTO spr VALUES (1, 'Chatham',    'locality',   'GB', 51.3691, 0.5525, -1, 0, 0);
		INSERT INTO spr VALUES (2, 'Rochester',  'locality',   'GB', 51.3668, 0.5060,  0, 1, 0);
		INSERT INTO spr VALUES (3, 'Gillingham', 'locality',   'GB', 51.3756, 0.5770,  0, 1, 0);
		INSERT INTO spr VALUES (4, 'Medway',     'localadmin', 'GB', 51.3898, 0.5271,  0, 0, 0);

		-- The legal-form class: a live plain-named locality plus its not-current administrative twin.
		INSERT INTO spr VALUES (10, 'Gilbert',         'locality',   'US', 33.3110, -111.7460, -1, 0, 0);
		INSERT INTO spr VALUES (11, 'Town of Gilbert', 'localadmin', 'US', 33.3112, -111.7461,  0, 0, 0);

		-- The cross-band shape: the Swansea class — the locality is deprecated while a live COUNTY of the
		-- same name stands 6 km away, so the place answers only at principal-area granularity.
		INSERT INTO spr VALUES (30, 'Swansea', 'locality', 'GB', 51.6303, -3.9584, 0, 1, 0);
		INSERT INTO spr VALUES (31, 'Swansea', 'county',   'GB', 51.6860, -3.9560, 1, 0, 0);

		-- The two defects the first live run exposed, pinned: a NAMELESS live record (its empty key
		-- substring-matches every name) and a live record whose name merely CONTAINS the dead one
		-- ('Telford' inside 'Telford and Wrekin' — no query for Telford resolves through it).
		INSERT INTO spr VALUES (40, 'Telford',           'locality', 'GB', 52.7048, -2.4556, 0, 1, 0);
		INSERT INTO spr VALUES (41, 'Telford and Wrekin','county',   'GB', 52.7100, -2.4400, 1, 0, 0);
		INSERT INTO spr VALUES (42, '',                  'localadmin','GB', 52.7050, -2.4550, 1, 0, 0);

		-- A superseded record: has a successor, so the pass must never judge it.
		INSERT INTO spr VALUES (20, 'Oldtown', 'locality', 'GB', 52.0, -1.0, 0, 1, 1);

		-- A placeholder-coordinate record: excluded, its 0,0 is the build's unlocated sentinel.
		INSERT INTO spr VALUES (21, 'Nowhere', 'locality', 'GB', 0, 0, 0, 1, 0);

		INSERT INTO place_population VALUES (2, 62982);
		INSERT INTO place_population VALUES (10, 208453);
	`)
}

/**
 * GeoNames dump lines: 19 tab-separated columns; the pass reads 1 name, 2 ascii, 4 lat, 5 lon, 6 class, 14 population.
 */
function geonamesLine(id: number, name: string, lat: number, lon: number, fclass: string, pop: number): string {
	const f = new Array(19).fill("")

	f[0] = String(id)
	f[1] = name
	f[2] = name
	f[4] = String(lat)
	f[5] = String(lon)
	f[6] = fclass
	f[14] = String(pop)

	return f.join("\t")
}

describe("triageWOFCurrency", () => {
	it("classes the Medway cluster: deprecated-no-successor and not-current-unstated, all uncovered", async () => {
		const adminDB = join(scratch, "admin.db")

		buildFixtureAdmin(adminDB)

		const { rows } = await triageWOFCurrency({ adminDB, countries: ["GB"] })
		const byName = new Map(rows.map((r) => [r.name, r]))

		expect(byName.get("Rochester")?.currencyClass).toBe(CurrencyClass.DeprecatedNoSuccessor)
		expect(byName.get("Gillingham")?.currencyClass).toBe(CurrencyClass.DeprecatedNoSuccessor)
		expect(byName.get("Medway")?.currencyClass).toBe(CurrencyClass.NotCurrentUnstated)

		// Chatham is live, so it is not a subject at all — and no live record bears the other three names.
		expect(byName.has("Chatham")).toBe(false)

		for (const name of ["Rochester", "Gillingham", "Medway"]) {
			expect(byName.get(name)?.coverage, name).toBe(CoverageVerdict.Uncovered)
		}

		expect(byName.get("Rochester")?.population).toBe(62_982)
	})

	it("calls a same-name live record in ANOTHER BAND cross-band, not covered — the Swansea class", async () => {
		const adminDB = join(scratch, "admin.db")

		buildFixtureAdmin(adminDB)

		const { rows } = await triageWOFCurrency({ adminDB, countries: ["GB"] })
		const swansea = rows.find((r) => r.name === "Swansea")

		expect(swansea?.coverage).toBe(CoverageVerdict.CoveredCrossBand)
		expect(swansea?.coveredBy).toMatchObject({ placetype: "county" })
		// The distance is the point: the city answers ~6 km away at principal-area granularity.
		expect(swansea?.coveredBy?.distanceKm).toBeGreaterThan(5)
	})

	it("calls the legal-form duplicate COVERED by containment — the verdict that keeps 11k US rows out of the hole count", async () => {
		const adminDB = join(scratch, "admin.db")

		buildFixtureAdmin(adminDB)

		const { rows } = await triageWOFCurrency({ adminDB, countries: ["US"] })
		const gilbert = rows.find((r) => r.name === "Town of Gilbert")

		expect(gilbert?.coverage).toBe(CoverageVerdict.CoveredContainment)
		expect(gilbert?.coveredBy?.name).toBe("Gilbert")
		expect(gilbert?.coveredBy?.distanceKm).toBeLessThan(1)
	})

	it("refuses both cover mirages the first live run exposed: a nameless neighbour and reverse containment", async () => {
		const adminDB = join(scratch, "admin.db")

		buildFixtureAdmin(adminDB)

		const { rows } = await triageWOFCurrency({ adminDB, countries: ["GB"] })
		const telford = rows.find((r) => r.name === "Telford")

		// The nameless localadmin sits 0.1 km away and the county contains the name — neither is a cover.
		expect(telford?.coverage).toBe(CoverageVerdict.Uncovered)
		expect(telford?.coveredBy).toBeUndefined()
	})

	it("never judges a SUPERSEDED record — its successor is the answer", async () => {
		const adminDB = join(scratch, "admin.db")

		buildFixtureAdmin(adminDB)

		const { rows } = await triageWOFCurrency({ adminDB, countries: ["GB"] })

		expect(rows.some((r) => r.name === "Oldtown")).toBe(false)
	})

	it("excludes placeholder 0,0 coordinates rather than measuring distances against the sentinel", async () => {
		const adminDB = join(scratch, "admin.db")

		buildFixtureAdmin(adminDB)

		const { rows } = await triageWOFCurrency({ adminDB, countries: ["GB"] })

		expect(rows.some((r) => r.name === "Nowhere")).toBe(false)
	})

	it("reports attestation as UNMEASURED when the country has no dump — absence is not a negative", async () => {
		const adminDB = join(scratch, "admin.db")

		buildFixtureAdmin(adminDB)

		const { rows, summary } = await triageWOFCurrency({ adminDB, countries: ["GB"], geonamesDir: scratch })

		expect(rows.every((r) => r.attestation.state === "unmeasured")).toBe(true)
		// And the summary refuses to publish an attested count it could not measure.
		expect(summary.every((s) => s.uncoveredAttested === undefined)).toBe(true)
	})

	it("attests an uncovered record a second source independently carries, and separates it from one it does not", async () => {
		const adminDB = join(scratch, "admin.db")

		buildFixtureAdmin(adminDB)

		await writeFile(
			join(scratch, "GB.txt"),
			[
				geonamesLine(1, "Rochester", 51.388, 0.505, "P", 28_671),
				// An S-class row for Gillingham must not attest — feature class is the gate.
				geonamesLine(2, "Gillingham", 51.376, 0.577, "S", 90_000),
			].join("\n") + "\n"
		)

		const { rows, summary } = await triageWOFCurrency({ adminDB, countries: ["GB"], geonamesDir: scratch })
		const byName = new Map(rows.map((r) => [r.name, r]))

		expect(byName.get("Rochester")?.attestation).toMatchObject({ state: "attested", population: 28_671 })
		expect(byName.get("Gillingham")?.attestation.state).toBe("unattested")

		const deprecated = summary.find((s) => s.currencyClass === CurrencyClass.DeprecatedNoSuccessor)

		// Three deprecated GB rows in the fixture; Swansea is cross-band, so only Rochester + Gillingham are
		// uncovered, and only Rochester is attested (Gillingham's dump row is S-class).
		expect(deprecated).toMatchObject({
			country: "GB",
			total: 4,
			coveredCrossBand: 1,
			uncovered: 3,
			uncoveredAttested: 1,
		})
	})
})
