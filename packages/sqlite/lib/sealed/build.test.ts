// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { describe, expect, it } from "vitest"

import { openBuiltClient } from "#sealed"
import { buildSealedArtifact } from "#sealed/build"

interface Database {
	t: { v: string }
}

describe("buildSealedArtifact", () => {
	it("builds into an output directory that does not exist yet", async () => {
		await using dir = await temporaryDirectory("sealed-build-")
		const out = dir.path("new-version", "artifact.db")

		await buildSealedArtifact<Database, null, void>({
			out,
			createTables: async (database) => {
				await database.schema.createTable("t").addColumn("v", "text").execute()
			},
			ingest: async (database) => {
				database.exec("INSERT INTO t (v) VALUES ('x')")

				return null
			},
			batched: async () => null,
			finish: async () => undefined,
		})

		using built = await openBuiltClient(out)

		expect(built.prepare("SELECT v FROM t").get()).toEqual({ v: "x" })
	})
})
