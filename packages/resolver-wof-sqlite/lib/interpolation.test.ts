import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { DatabaseClient } from "@mailwoman/sqlite/client"
import { describe, expect, it, vi } from "vitest"

import { AddressPointInterpolator } from "#address/point/interpolation"
import type { AddressPointDatabase } from "#address/point/schema"
import { StreetInterpolator } from "#interpolation"
import type { StreetSegmentDatabase } from "#street/segment-schema"

type InterpolationFixtureDatabase = StreetSegmentDatabase & AddressPointDatabase

describe.each([
	{
		name: "StreetInterpolator",
		table: "street_segment",
		construct: (options: ConstructorParameters<typeof StreetInterpolator<InterpolationFixtureDatabase>>[0]) =>
			new StreetInterpolator<InterpolationFixtureDatabase>(options),
	},
	{
		name: "AddressPointInterpolator",
		table: "address_point",
		construct: (options: ConstructorParameters<typeof AddressPointInterpolator<InterpolationFixtureDatabase>>[0]) =>
			new AddressPointInterpolator<InterpolationFixtureDatabase>(options),
	},
])("$name construction", ({ table, construct }) => {
	it("closes an owned connection when statement preparation fails", async () => {
		await using directory = await temporaryDirectory("interpolation-construction-")
		const path = directory.path("malformed.db")

		{
			using database = new DatabaseClient<InterpolationFixtureDatabase>(path)

			await database.schema.createTable(table).addColumn("unrelated", "text").execute()
		}

		const dispose = vi.spyOn(DatabaseClient.prototype, Symbol.dispose)

		try {
			expect(() => construct({ dbPath: path.toString() })).toThrow(/no such column/)
			expect(dispose).toHaveBeenCalledTimes(1)
		} finally {
			dispose.mockRestore()
		}
	})

	it("leaves a borrowed connection open when construction fails", async () => {
		using database = DatabaseClient.temp<InterpolationFixtureDatabase>()

		await database.schema.createTable(table).addColumn("unrelated", "text").execute()

		const dispose = vi.spyOn(database, Symbol.dispose)

		try {
			expect(() => construct({ database })).toThrow(/no such column/)
			expect(dispose).not.toHaveBeenCalled()
			expect(database.prepare("SELECT 1 AS value").get()).toEqual({ value: 1 })
		} finally {
			dispose.mockRestore()
		}
	})
})
