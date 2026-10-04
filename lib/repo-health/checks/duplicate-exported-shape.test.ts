/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file The duplicate-shape finder over planted trees: one shape under two names, a union in two workspaces, a
 *   copy inside one workspace, a test file and a body below the member floor.
 */

import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { makeDirectories, writeLocalTextFile } from "@mailwoman/core/fs/writers"
import { afterAll, describe, expect, it } from "vitest"

import {
	duplicateExportedShapeCheck,
	findDuplicateShapes,
	shapeSites,
} from "#repo-health/checks/duplicate-exported-shape"
import { DiagnosticSeverity } from "#repo-health/index"

const fixtures = new AsyncDisposableStack()

afterAll(() => fixtures.disposeAsync())

async function plant(files: Record<string, string>): Promise<{ repoRoot: string; trackedFiles: string[] }> {
	const root = fixtures.use(await temporaryDirectory("shapes-")).path

	for (const [file, text] of Object.entries(files)) {
		await makeDirectories(root(file.slice(0, file.lastIndexOf("/"))))
		await writeLocalTextFile(text, root(file))
	}

	return { repoRoot: root.toString(), trackedFiles: Object.keys(files) }
}

describe("shapeSites", () => {
	it("keys an interface by its sorted members with comments and whitespace dropped", () => {
		const [a] = shapeSites(
			"packages/a/lib/x.ts",
			"export interface LatLng {\n\t/** North. */\n\tlatitude: number\n\tlongitude:   number\n}\n"
		)

		const [b] = shapeSites(
			"packages/b/lib/y.ts",
			"export interface GeoCoordinate { longitude: number; latitude: number }\n"
		)

		expect(a?.key).toBe("shape { latitude: number; longitude: number }")
		expect(b?.key).toBe(a?.key)
		expect(a).toMatchObject({ name: "LatLng", workspace: "a", line: 1 })
	})

	it("keys a union by its sorted members and a type literal like an interface", () => {
		const sites = shapeSites(
			"packages/a/lib/x.ts",
			[
				'export type Tier = "rooftop" | "street" | "locality"',
				"export type Point = { y: number; x: number }",
				"export type Id = string",
				"export interface One { only: string }",
				"interface Private { a: string; b: string }",
			].join("\n")
		)

		expect(sites.map((site) => [site.name, site.key])).toEqual([
			["Tier", 'union "locality" | "rooftop" | "street"'],
			["Point", "shape { x: number; y: number }"],
		])
	})
})

describe("findDuplicateShapes", () => {
	it("reports one shape exported under two names from two workspaces", async () => {
		const context = await plant({
			"packages/record/lib/address.ts": "export interface GeoCoordinate { latitude: number; longitude: number }\n",
			"packages/address-id/lib/index.ts": "export interface LatLng {\n\tlatitude: number\n\tlongitude: number\n}\n",
		})

		const duplicates = await findDuplicateShapes(context)

		expect(duplicates).toHaveLength(1)

		expect(duplicates[0]?.sites.map((site) => [site.file, site.line, site.name])).toEqual([
			["packages/address-id/lib/index.ts", 1, "LatLng"],
			["packages/record/lib/address.ts", 1, "GeoCoordinate"],
		])
	})

	it("reports a union alias repeated across workspaces regardless of member order", async () => {
		const context = await plant({
			"packages/a/lib/x.ts": 'export type ResolutionTier = "rooftop" | "street" | "locality"\n',
			"packages/b/lib/y.ts": 'export type ResolutionTier = "locality" | "rooftop" | "street"\n',
		})

		expect((await findDuplicateShapes(context)).map((d) => d.sites.length)).toEqual([2])
	})

	it("leaves a copy inside one workspace, a test file, and a body below the floor alone", async () => {
		const context = await plant({
			"packages/a/lib/x.ts": "export interface Pair { a: string; b: string }\nexport interface Only { a: string }\n",
			"packages/a/lib/y.ts": "export interface PairAgain { a: string; b: string }\n",
			"packages/b/lib/only.ts": "export interface Only { a: string }\n",
			"packages/b/lib/x.test.ts": "export interface Pair { a: string; b: string }\n",
			"packages/c/lib/x.test.ts": "export interface Pair { a: string; b: string }\n",
		})

		expect(await findDuplicateShapes(context)).toEqual([])
	})

	it("keeps a generic apart from its plain twin", async () => {
		const context = await plant({
			"packages/a/lib/x.ts": "export interface Box<T> { value: T; label: string }\n",
			"packages/b/lib/y.ts": "export interface Box { value: T; label: string }\n",
		})

		expect(await findDuplicateShapes(context)).toEqual([])
	})

	it("gives the check one diagnostic per shape, carrying the first site and listing the rest", async () => {
		const context = await plant({
			"packages/a/lib/x.ts": "export interface A { lat: number; lon: number }\n",
			"packages/b/lib/y.ts": "export interface B { lat: number; lon: number }\n",
			"packages/c/lib/z.ts": "export interface C { lon: number; lat: number }\n",
		})

		const diagnostics = await duplicateExportedShapeCheck.run(context)

		expect(diagnostics).toEqual([
			expect.objectContaining({
				severity: DiagnosticSeverity.Warning,
				file: "packages/a/lib/x.ts",
				line: 1,
				details: ["packages/b/lib/y.ts:1 B", "packages/c/lib/z.ts:1 C"],
			}),
		])
	})
})
