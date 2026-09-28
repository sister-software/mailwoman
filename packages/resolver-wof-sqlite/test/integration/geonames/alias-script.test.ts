/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 * Tests for `ingestGeonamesAliases`, where the fold admits an alternate name in any script while the display name stays Latin.
 */

import { temporaryDirectory, type TemporaryDirectory } from "@mailwoman/core/fs/temporary"
import { writeLocalFile } from "@mailwoman/core/fs/writers"
import { ingestGeonamesAliases, type GeonamesIngestProgress } from "@mailwoman/resolver-wof-sqlite/geonames"
import type { WOFDatabase } from "@mailwoman/resolver-wof-sqlite/schema"
import { DatabaseClient } from "@mailwoman/sqlite/client"
import { afterAll, beforeAll, expect, test } from "vitest"

type Row = Record<string, string | number | null>

let dir: TemporaryDirectory
let db: DatabaseClient<WOFDatabase>
const events: GeonamesIngestProgress[] = []

/**
 * One GeoNames `geoname` row: 19 tab-separated columns.
 */
function row(over: Record<number, string>): string {
	const f = new Array(19).fill("")

	for (const [i, v] of Object.entries(over)) {
		f[Number(i)] = v
	}

	return f.join("\t")
}

beforeAll(async () => {
	dir = await temporaryDirectory("geonames-alias-script-")

	const lines = [
		row({
			0: "1818446",
			1: "Tuen Mun",
			2: "Tuen Mun",
			3: "Tuen Mun,屯門,屯门,Т'юен-Мун",
			4: "22.39175",
			5: "113.97157",
			6: "P",
			7: "PPL",
			8: "HK",
			14: "507900",
		}),
		row({
			0: "1818953",
			1: "Sham Shui Po",
			2: "Sham Shui Po",
			3: "深水埗,Sham Shui Po",
			4: "22.33023",
			5: "114.15945",
			6: "P",
			7: "PPL",
			8: "HK",
			14: "431090",
		}),
		row({
			0: "1818999",
			1: "Noise Town",
			2: "Noise Town",
			3: "(( Noise Town )),Noise Town [old],噪音鎮",
			4: "22.3",
			5: "114.1",
			6: "P",
			7: "PPL",
			8: "HK",
			14: "1000",
		}),
	].join("\n")

	await writeLocalFile(lines, dir.path("HK.txt"))

	db = DatabaseClient.temp<WOFDatabase>()

	db.exec(
		`CREATE TABLE spr (id INTEGER PRIMARY KEY, parent_id INTEGER, name TEXT, placetype TEXT, country TEXT,
		 latitude REAL, longitude REAL, min_latitude REAL, min_longitude REAL, max_latitude REAL, max_longitude REAL,
		 is_current INTEGER, is_deprecated INTEGER, is_ceased INTEGER, is_superseded INTEGER, is_superseding INTEGER, lastmodified INTEGER)`
	)

	db.exec(
		`CREATE TABLE names (id INTEGER, name TEXT, placetype TEXT, country TEXT, language TEXT, privateuse TEXT, official INTEGER, lastmodified INTEGER)`
	)

	db.exec(`CREATE TABLE ancestors (id INTEGER, ancestor_id INTEGER, ancestor_placetype TEXT, lastmodified INTEGER)`)
	db.exec(`CREATE TABLE place_population (id INTEGER PRIMARY KEY, population INTEGER)`)

	await ingestGeonamesAliases(db, ["HK"], dir.path, (event) => events.push(event))
})

afterAll(() => {
	db.destroy()
	dir[Symbol.asyncDispose]()
})

function namesFor(spelling: string): Row[] {
	return db.prepare("SELECT id, name, country FROM names WHERE name = ?").all(spelling) as Row[]
}

test("a Han-script alternate name reaches the names table", () => {
	expect(namesFor("屯門")).toHaveLength(1)
	expect(namesFor("屯门")).toHaveLength(1)
	expect(namesFor("深水埗")).toHaveLength(1)
})

test("the Han alias belongs to the same place as its romanization", () => {
	const latin = db.prepare("SELECT id FROM spr WHERE name = 'Tuen Mun'").get() as Row
	const han = namesFor("屯門")[0]!

	expect(han.id).toBe(latin.id)
})

test("a Cyrillic alternate name reaches it on the same rule", () => {
	expect(namesFor("Т'юен-Мун")).toHaveLength(1)
})

test("the DISPLAY name stays Latin — reachability is not rendering", () => {
	const place = db.prepare("SELECT name FROM spr WHERE id = (SELECT id FROM names WHERE name='屯門')").get() as Row

	expect(place.name).toBe("Tuen Mun")
})

test("packing noise is still refused, in every script", () => {
	expect(namesFor("(( Noise Town ))")).toHaveLength(0)
	expect(namesFor("Noise Town [old]")).toHaveLength(0)
	// Admitting a script must not admit packing noise: the clean Han name on the same row still lands.
	expect(namesFor("噪音鎮")).toHaveLength(1)
})

test("the fold reports names REFUSED, so a script gap is visible in the build and not only in the artifact", () => {
	const hk = events.find((e) => e.country === "HK")

	expect(hk?.aliasesRefused).toBe(2)
})
