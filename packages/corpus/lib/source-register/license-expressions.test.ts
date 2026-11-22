// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 * Holds `@mailwoman/license`'s linear expression reader to the regular expressions
 * it replaced, over every string the committed register holds.
 *
 * The oracle below is the replaced implementation, kept here only as the reference the reader must match.
 * Its `\s+(?:AND|OR)\s+` backtracks polynomially on a long whitespace run, and no register string has one.
 */

import { readLocalJSONFile } from "@mailwoman/core/fs/readers"
import { stringifyJSON } from "@mailwoman/core/json"
import { readPackageJSON } from "@mailwoman/core/module/resolve-from"
import { isPresent } from "@mailwoman/core/objects"
import { repoRootPath } from "@mailwoman/core/paths"
import { readWorkspaceDirectories } from "@mailwoman/core/workspaces"
import { ExpressionOperator, licenseExpressionTerms, licenseWithoutException } from "@mailwoman/license/expression"
import { licenseIdentifiers } from "@mailwoman/license/obligations"
import { soldUnderCommercialTerms } from "@mailwoman/license/operations"
import { resolvePath } from "path-ts"
import { describe, expect, it } from "vitest"

import { addressSourceRegisterPath } from "#source-register/register"

const oracle = {
	identifiers: (expression: string) =>
		expression
			.replaceAll(/[()]/g, " ")
			.split(/\s+(?:AND|OR)\s+/i)
			.map((part) => part.trim())
			.filter((part) => part.length),
	branches: (expression: string) =>
		expression
			.replaceAll(/[()]/g, " ")
			.split(/\s+OR\s+/i)
			.map((part) => part.trim())
			.filter((part) => part.length),
	withoutException: (identifier: string) => identifier.split(/\s+WITH\s+/i)[0]!,
	soldUnderCommercialTerms: (expression: string) => expression.split(/[\s()]+/u).includes("LicenseRef-Commercial"),
}

function collectStrings(value: unknown, into: Set<string>): Set<string> {
	if (typeof value === "string") {
		into.add(value)
	} else if (Array.isArray(value)) {
		for (const entry of value) {
			collectStrings(entry, into)
		}
	} else if (value && typeof value === "object") {
		for (const entry of Object.values(value)) {
			collectStrings(entry, into)
		}
	}

	return into
}

describe("the linear license-expression reader over the committed register", () => {
	it("returns the replaced splitters' terms for every string the register holds", async () => {
		const strings = [...collectStrings(await readLocalJSONFile<unknown>(addressSourceRegisterPath()), new Set())]
		const mismatches: string[] = []

		for (const text of strings) {
			const identifiers = licenseIdentifiers(text)

			if (stringifyJSON(identifiers) !== stringifyJSON(oracle.identifiers(text))) {
				mismatches.push(`identifiers: ${text}`)
			}

			if (
				stringifyJSON(licenseExpressionTerms(text, [ExpressionOperator.Or])) !== stringifyJSON(oracle.branches(text))
			) {
				mismatches.push(`branches: ${text}`)
			}

			for (const identifier of identifiers) {
				if (licenseWithoutException(identifier) !== oracle.withoutException(identifier)) {
					mismatches.push(`exception: ${identifier}`)
				}
			}
		}

		expect(strings.length).toBeGreaterThan(0)
		expect(mismatches).toEqual([])
	})

	it("reads the commercial offering of every workspace's license expression as the replaced token match did", async () => {
		const repoRoot = repoRootPath()
		const directories = await readWorkspaceDirectories(repoRoot)

		const expressions = await Promise.all(
			directories.map(
				async (directory) => (await readPackageJSON(resolvePath(repoRoot, directory, "package.json"))).license
			)
		)

		const read = expressions.filter(isPresent)

		const mismatches = read.filter(
			(expression) => soldUnderCommercialTerms(expression) !== oracle.soldUnderCommercialTerms(expression)
		)

		expect(read).toHaveLength(directories.length)
		expect(mismatches).toEqual([])
	})
})
