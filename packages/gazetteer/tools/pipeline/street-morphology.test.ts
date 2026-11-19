// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   The builder reports each phase and its detail unformatted, so the CLI's stage line formats it once.
 */

import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { expect, test } from "vitest"

import { buildStreetMorphologyArtifact } from "./street-morphology.ts"

test("reports phases and details without a bracket, indent or prefix of its own", async () => {
	await using scratch = await temporaryDirectory()
	const reports: Array<[string, string | undefined]> = []

	await buildStreetMorphologyArtifact({
		locales: ["en"],
		output: scratch.path("fst-street-morphology.bin").toString(),
		onProgress: (phase, detail) => reports.push([phase, detail]),
	})

	expect(reports.length).toBeGreaterThan(0)

	for (const [phase, detail] of reports) {
		expect(phase).toMatch(/^[\w-]+$/u)
		expect(detail ?? "").not.toMatch(/^\s|^\[/u)
	}

	expect(reports.at(-1)?.[0]).toBe("morphology")
	expect(reports.at(-1)?.[1]).toMatch(/^wrote /u)
})
