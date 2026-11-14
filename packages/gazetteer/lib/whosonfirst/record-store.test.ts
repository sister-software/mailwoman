// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { readLocalTextFile } from "@mailwoman/core/fs/readers"
import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { writeLocalTextFile } from "@mailwoman/core/fs/writers"
import { GitClient } from "@mailwoman/core/git"
import { parseJSONStrict, stringifyJSON } from "@mailwoman/core/json"
import { DatabaseClient } from "@mailwoman/sqlite/client"
import type { PathBuilder } from "path-ts"
import { afterAll, describe, expect, it } from "vitest"

import {
	reduceWOFFeature,
	refreshWOFRecordStore,
	storedWOFRecord,
	storedWOFRecords,
	type WOFRecordStoreDatabase,
} from "#whosonfirst/record-store"

const fixtures = new AsyncDisposableStack()

afterAll(() => fixtures.disposeAsync())

function feature(id: number, name: string, extra: Record<string, unknown> = {}): string {
	return stringifyJSON({
		type: "Feature",
		id,
		properties: { "wof:id": id, "wof:name": name, "wof:placetype": "locality", "src:geom": "x", ...extra },
		geometry: { type: "Point", coordinates: [1, 2] },
	})
}

async function commitAll(repo: PathBuilder, message: string): Promise<void> {
	const client = new GitClient({ cwd: repo })

	await client.read(["add", "-A"])
	await client.read(["-c", "user.email=fixture@example.invalid", "-c", "user.name=Fixture", "commit", "-qm", message])
}

/**
 * A data root holding two git repositories with one record each.
 */
async function dataRoot(): Promise<{ root: PathBuilder; store: string }> {
	const root = fixtures.use(await temporaryDirectory("wof-record-store-")).path

	for (const [repo, id, name] of [
		["whosonfirst-data-admin-fr", 101_751_119, "Paris"],
		["whosonfirst-data-admin-us", 85_977_539, "New York"],
	] as const) {
		await new GitClient({ cwd: root }).read([
			"init",
			"--quiet",
			"--initial-branch=main",
			root("repos", repo).toString(),
		])

		await writeLocalTextFile(feature(id, name), root("repos", repo, "data", `${id}.geojson`))
		await commitAll(root("repos", repo), "record")
	}

	return { root: root("repos"), store: root("store.db").toString() }
}

describe("reduceWOFFeature", () => {
	it("keeps the type, the id and the properties the readers use, in source order, and drops geometry", () => {
		const reduced = reduceWOFFeature(
			feature(1, "Brooklyn", { "name:eng_x_colloquial": ["Kings"], "geom:area": 5, "lbl:latitude": 40.6 })
		)

		expect(reduced?.id).toBe(1)

		expect(parseJSONStrict(reduced!.feature)).toEqual({
			type: "Feature",
			id: 1,
			properties: {
				"wof:id": 1,
				"wof:name": "Brooklyn",
				"wof:placetype": "locality",
				"name:eng_x_colloquial": ["Kings"],
				"lbl:latitude": 40.6,
			},
		})
	})

	it("returns null for text that is not a feature with a numeric wof:id", () => {
		expect(reduceWOFFeature("{")).toBeNull()
		expect(reduceWOFFeature(stringifyJSON({ type: "Feature", properties: { "wof:name": "x" } }))).toBeNull()
	})
})

describe("refreshWOFRecordStore", () => {
	it("reduces each repository once, reuses it while its commit is unchanged, and rewrites only the changed one", async () => {
		const { root, store } = await dataRoot()

		expect((await refreshWOFRecordStore(store, root)).map((r) => `${r.repo}:${r.action}:${r.records}`)).toEqual([
			"whosonfirst-data-admin-fr:reduced:1",
			"whosonfirst-data-admin-us:reduced:1",
		])

		expect((await refreshWOFRecordStore(store, root)).map((r) => r.action)).toEqual(["reused", "reused"])

		await writeLocalTextFile(
			feature(85_977_539, "New York City"),
			root("whosonfirst-data-admin-us", "data", "85977539.geojson")
		)

		const afterEdit = await refreshWOFRecordStore(store, root)

		expect(afterEdit.map((r) => r.action)).toEqual(["reused", "reduced"])

		using db = new DatabaseClient<WOFRecordStoreDatabase>(store, { readOnly: true })

		expect(storedWOFRecord(db, 85_977_539)?.feature.properties?.["wof:name"]).toBe("New York City")
		expect([...storedWOFRecords(db)].map((r) => r.id)).toEqual([85_977_539, 101_751_119])
	})

	it("refuses two files holding one wof:id, naming both", async () => {
		const { root, store } = await dataRoot()
		const repo = root("whosonfirst-data-admin-us")

		await writeLocalTextFile(
			await readLocalTextFile(repo("data", "85977539.geojson")),
			repo("data", "copy", "85977539.geojson")
		)

		await expect(refreshWOFRecordStore(store, root)).rejects.toThrow(
			/wof:id 85977539 is in whosonfirst-data-admin-us\/data\/85977539\.geojson and whosonfirst-data-admin-us\/data\/copy\/85977539\.geojson/u
		)
	})
})
