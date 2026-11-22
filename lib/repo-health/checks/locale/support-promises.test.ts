// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 * @file The support-promises check over planted promises.
 *
 *   The check takes no input from its context: it reads the promises from the imported `@mailwoman/codex/support`
 *   module and the gauntlet cases and release specification from this repository. These cases replace the module's
 *   promise list and leave the cases and the specification as committed, so a planted promise is judged against
 *   the evidence a declared one would be.
 */

import type { SupportPromise } from "@mailwoman/codex/support"
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest"

import { DiagnosticSeverity, type RepoContext } from "#repo-health/check"

const planted = vi.hoisted(() => ({ promises: [] as unknown[] }))

vi.mock("@mailwoman/codex/support", async (importOriginal) => ({
	...(await importOriginal<typeof import("@mailwoman/codex/support")>()),
	get SUPPORT_PROMISES() {
		return planted.promises
	},
}))

const context: RepoContext = { repoRoot: "/checkout", trackedFiles: [] }

// Test files share one module graph per worker, so an earlier file may have
// loaded the check with the declared promise list.
// Each case loads the check again after the reset.
beforeEach(() => {
	vi.resetModules()
})

// The next test file in this worker loads its modules without the replacement.
afterAll(() => {
	vi.resetModules()
})

/**
 * The messages of the errors the check reports when the declaration holds `promises`.
 */
async function errorsFor(promises: readonly SupportPromise[]): Promise<string[]> {
	planted.promises = [...promises]

	const { supportPromisesCheck } = await import("#repo-health/checks/locale/support-promises")
	const diagnostics = await supportPromisesCheck.run(context)

	return diagnostics
		.filter((diagnostic) => diagnostic.severity === DiagnosticSeverity.Error)
		.map((diagnostic) => diagnostic.message)
}

async function declaredPromises(): Promise<readonly SupportPromise[]> {
	const actual = await vi.importActual<typeof import("@mailwoman/codex/support")>("@mailwoman/codex/support")

	return actual.SUPPORT_PROMISES
}

describe("supportPromisesCheck", () => {
	it("reports a promise whose country the registry refuses", async () => {
		const errors = await errorsFor([{ country: "ZZ", input: "en-Latn", embeddedNameScripts: [], depth: "street" }])

		expect(errors).toContainEqual(expect.stringMatching(/^ZZ × en-Latn: country ZZ/u))
	})

	it("reports a promise in a script no gauntlet case of its country is written in", async () => {
		const [declared] = await declaredPromises()

		// Ogham is registered, and no address in the gauntlet is written in it.
		const errors = await errorsFor([{ ...declared!, input: "en-Ogam" }])

		expect(errors).toHaveLength(1)
		expect(errors[0]).toContain(`${declared!.country} × en-Ogam`)
	})

	it("reports a promise declared twice", async () => {
		const [declared] = await declaredPromises()
		const errors = await errorsFor([declared!, declared!])

		expect(errors).toHaveLength(1)
		expect(errors[0]).toContain(`${declared!.country} × ${declared!.input}`)
	})

	it("reports no error for a promise this repository declares", async () => {
		const [declared] = await declaredPromises()

		await expect(errorsFor([declared!])).resolves.toEqual([])
	})
})
