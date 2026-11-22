// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 * @file The shipping-scope comparison: an unplaced shipping country, an admitted reason, and two kinds of stale reason.
 */

import { describe, expect, it } from "vitest"

import { compareShippingScope, localeScopeCheck } from "#repo-health/checks/locale/scope"
import { plantFixtureRepository } from "#repo-health/test/fixture-repository"

const messages = (scope: Parameters<typeof compareShippingScope>[0]): string[] =>
	compareShippingScope(scope).map((diagnostic) => diagnostic.message)

describe("compareShippingScope", () => {
	it("passes when every shipping country holds a promise", () => {
		expect(messages({ shipping: new Set(["US", "FR"]), promised: new Set(["US", "FR"]), unpromised: {} })).toEqual([])
	})

	it("reports a shipping country with neither a promise nor a reason", () => {
		expect(messages({ shipping: new Set(["US", "CN"]), promised: new Set(["US"]), unpromised: {} })).toEqual([
			"CN ships a weights package, holds no support promise, and has no entry in unpromisedShippingLocales saying why",
		])
	})

	it("admits a shipping country without a promise when a reason is stated", () => {
		expect(
			messages({ shipping: new Set(["US", "CN"]), promised: new Set(["US"]), unpromised: { CN: "no open source" } })
		).toEqual([])
	})

	it("reports a reason whose country now holds a promise", () => {
		expect(messages({ shipping: new Set(["GB"]), promised: new Set(["GB"]), unpromised: { GB: "stale" } })).toEqual([
			"unpromisedShippingLocales still lists GB, which now holds a support promise; remove the entry",
		])
	})

	it("reports a reason whose country stopped shipping", () => {
		expect(messages({ shipping: new Set(), promised: new Set(), unpromised: { NZ: "stale" } })).toEqual([
			"unpromisedShippingLocales lists NZ, which no longer ships a weights package; remove the entry",
		])
	})
})

describe("localeScopeCheck", () => {
	/**
	 * A tree that ships one locale in `ZZ`, a code no support promise can hold,
	 * with `unpromised` as the reasons its scope config states.
	 */
	const scopeTree = (unpromised: Record<string, string>) => ({
		"release.config.json": { version: "1.0.0", locales: ["en-zz"] },
		"scope.config.json": { unpromisedShippingLocales: unpromised },
	})

	it("reports a shipping country the scope config gives no reason for", async () => {
		await using context = await plantFixtureRepository(scopeTree({}))

		const diagnostics = await localeScopeCheck.run(context)

		expect(diagnostics.map((diagnostic) => diagnostic.file)).toEqual(["scope.config.json"])
		expect(diagnostics[0]!.message).toMatch(/^ZZ /u)
	})

	it("accepts the country once the scope config states a reason", async () => {
		await using context = await plantFixtureRepository(scopeTree({ ZZ: "a fixture country with no evidence" }))

		await expect(localeScopeCheck.run(context)).resolves.toEqual([])
	})
})
