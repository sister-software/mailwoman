/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Migration discovery on a legacy layout: it finds what the readers select, classifies each file with its
 *   reason, reports symlinks, hard links and WAL sidecars, and leaves the data root's files as they were.
 */

import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { createSymbolicLink, makeDirectories, writeLocalTextFile } from "@mailwoman/core/fs/writers"
import { ServingRole } from "@mailwoman/core/layers"
import { Globerator } from "spliterator/node/fs"
import { describe, expect, it } from "vitest"

import { MigrationClass, planMigration } from "#data/migrate"
import { writeFixtureAddressPoints } from "#test-kit/fixture-registry"

async function listTree(root: string): Promise<string[]> {
	return (await Globerator.from("**/*", { cwd: root, onlyFiles: false }).toArray()).toSorted()
}

describe("planMigration", () => {
	it("classifies each file the readers select on a legacy layout and writes nothing", async () => {
		await using root = await temporaryDirectory("mw-migrate-")

		await makeDirectories(root.path("store"), root.path("db", "address-points"), root.path("db", "osm"))

		// A candidate gazetteer at its conventional path, with no layer_manifest.
		await writeFixtureAddressPoints(root.path("store", "candidate.db"))
		await createSymbolicLink(root.path("store", "candidate.db"), root.path("db", "wof", "candidate.db"))
		// The District of Columbia's legacy per-state name, and Alabama's with a WAL sidecar.
		await writeFixtureAddressPoints(root.path("db", "address-points", "address-points-us-dc.db"))
		await writeFixtureAddressPoints(root.path("db", "address-points", "address-points-us-al.db"))
		await writeLocalTextFile("wal", root.path("db", "address-points", "address-points-us-al.db-wal"))
		// An OpenStreetMap extract with no layer_manifest.
		await writeFixtureAddressPoints(root.path("db", "osm", "address-points-nz-nz.db"))

		const before = await listTree(root.path.toString())
		const plan = await planMigration(root.path)

		await expect(listTree(root.path.toString())).resolves.toEqual(before)
		expect(plan.basedOnGeneration).toBeNull()
		expect(plan.bytesToCopy).toBe(0)

		const byPath = new Map(plan.artifacts.map((artifact) => [artifact.path, artifact]))
		const candidate = byPath.get(root.path("db", "wof", "candidate.db").toString())

		expect(candidate).toMatchObject({
			reader: "candidate-convention",
			role: ServingRole.Candidate,
			classification: MigrationClass.RegistryManifest,
			linkTarget: root.path("store", "candidate.db").toString(),
		})

		expect(byPath.get(root.path("db", "address-points", "address-points-us-dc.db").toString())).toMatchObject({
			reader: "us-state",
			role: ServingRole.AddressPoints,
			scope: { country: "US", subdivision: "US-DC" },
			classification: MigrationClass.RegistryManifest,
		})

		expect(byPath.get(root.path("db", "address-points", "address-points-us-al.db").toString())).toMatchObject({
			classification: MigrationClass.BlockedWAL,
			walBytes: 3,
		})

		expect(byPath.get(root.path("db", "osm", "address-points-nz-nz.db").toString())).toMatchObject({
			reader: "osm-extract",
			classification: MigrationClass.SourceRebuild,
		})

		expect(plan.rollback).toMatch(/^remove .*active\.json/u)
	})
})
