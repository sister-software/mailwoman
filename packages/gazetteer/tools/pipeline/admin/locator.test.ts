// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { stringifyJSON } from "@mailwoman/core/json"
import type { WOFDatabase } from "@mailwoman/resolver-wof-sqlite/schema"
import type { PolygonDatabase } from "@mailwoman/resolver-wof-sqlite/schema/polygon"
import { DatabaseClient } from "@mailwoman/sqlite/client"
import { describe, expect, it } from "vitest"

import { AdminLocator } from "#tools/pipeline/admin/locator"

const square = (minLon: number): string =>
	stringifyJSON({
		type: "Polygon",
		coordinates: [
			[
				[minLon, 0],
				[minLon + 2, 0],
				[minLon + 2, 2],
				[minLon, 2],
				[minLon, 0],
			],
		],
	})

describe("AdminLocator", () => {
	it("reads each place's boundary from the first polygon database holding it", async () => {
		await using dir = await temporaryDirectory("admin-locator-")
		const adminPath = dir.path("admin.db")

		{
			using admin = new DatabaseClient<WOFDatabase>(adminPath)

			admin.exec(`
				CREATE TABLE spr (id INTEGER PRIMARY KEY, name TEXT, placetype TEXT, country TEXT, is_current INTEGER);
				INSERT INTO spr VALUES (1, 'Alpha', 'region', 'VI', 1), (2, 'Beta', 'region', 'VI', 1), (3, 'Gamma', 'region', 'VI', 1);
			`)
		}

		const polygonDatabase = (name: string, rows: Array<[number, string]>) => {
			using db = new DatabaseClient<PolygonDatabase>(dir.path(name))

			db.exec("CREATE TABLE polygons (id INTEGER PRIMARY KEY, geom TEXT)")

			for (const [id, geom] of rows) {
				db.prepare("INSERT INTO polygons VALUES (?, ?)").run(id, geom)
			}

			return dir.path(name)
		}

		// Alpha's boundary in the first database wins.
		// Its boundary in the second lies over Beta's square.
		const first = polygonDatabase("first.db", [[1, square(0)]])

		const second = polygonDatabase("second.db", [
			[1, square(2)],
			[2, square(2)],
		])

		const locator = new AdminLocator({ adminPath, polygonPaths: [first, second], placetype: "region", country: "VI" })

		expect(locator.located).toBe(2)
		expect(locator.withoutGeometry).toBe(1)
		expect(locator.locate(1, 1)?.name).toBe("Alpha")
		expect(locator.locate(3, 1)?.name).toBe("Beta")
		expect(locator.locate(5, 1)).toBeNull()
	})
})
