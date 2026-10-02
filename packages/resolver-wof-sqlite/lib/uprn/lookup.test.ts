import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { DatabaseClient } from "@mailwoman/sqlite/client"
import { describe, expect, it, vi } from "vitest"

import { UPRNLookup } from "#uprn/lookup"
import type { UPRNDatabase } from "#uprn/schema"

describe("UPRNLookup construction", () => {
	it("closes an owned connection when the uprn table is missing", async () => {
		await using directory = await temporaryDirectory("uprn-construction-")
		const path = directory.path("empty.db")

		{
			using database = new DatabaseClient<UPRNDatabase>(path)

			database.exec("PRAGMA user_version = 1")
		}

		const dispose = vi.spyOn(DatabaseClient.prototype, Symbol.dispose)

		try {
			expect(() => new UPRNLookup({ databasePath: path })).toThrow("no such table: uprn")
			expect(dispose).toHaveBeenCalledTimes(1)
		} finally {
			dispose.mockRestore()
		}
	})

	it("leaves a borrowed connection open when construction fails", () => {
		using database = DatabaseClient.temp<UPRNDatabase>()
		const dispose = vi.spyOn(database, Symbol.dispose)

		try {
			expect(() => new UPRNLookup({ database })).toThrow("no such table: uprn")
			expect(dispose).not.toHaveBeenCalled()
			expect(database.prepare("SELECT 1 AS value").get()).toEqual({ value: 1 })
		} finally {
			dispose.mockRestore()
		}
	})
})
