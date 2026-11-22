// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   Every frame is stripped of ANSI before it is matched, because chalk's dim/reset pair
 *   around an evidence label means `\s+` cannot span the gap in a colored frame.
 */

import { pathExists } from "@mailwoman/core/fs/readers/stat"
import { workspacePath } from "@mailwoman/core/paths"
import { stripANSI } from "@mailwoman/core/strings/terminal"
import { resolveWeights } from "@mailwoman/neural/weights"
import { wofDatabasePath } from "@mailwoman/resolver-wof-sqlite/paths"
import { runStaticDebug } from "mailwoman/debug-view/command"
import { mapPaneCellSize } from "mailwoman/debug-view/DebugFrame"
import { describe, expect, test } from "vitest"

import { spec } from "#cli/native/commands/geocode"
import { resolveGeocodeCommandOptions } from "#cli/native/commands/geocode/options"
import { parseCommand } from "#cli/native/spec"
import { $public } from "#env"

/**
 * The options the geocode command resolves from these typed flags.
 */
const commandOptions = (...flags: string[]) => resolveGeocodeCommandOptions(parseCommand(spec, flags))

const DEFAULT_WOF_PATH = wofDatabasePath("admin-global-priority.db")
const wofPath = $public.MAILWOMAN_WOF_DB ?? DEFAULT_WOF_PATH
const hasWOFDB = await pathExists(wofPath)

const hasWeights = await (async () => {
	try {
		await resolveWeights({ locale: "en-us" })

		return true
	} catch {
		return false
	}
})()

const TILES_PATH = workspacePath("map-tui", "test", "fixtures", "portland.pmtiles")
const hasTiles = await pathExists(TILES_PATH)

const canRun = hasWOFDB && hasWeights && hasTiles

if (!canRun) {
	console.warn(
		"Skipping mailwoman geocode --debug static smoke: " +
			[
				!hasWeights && "no resolvable neural weights (@mailwoman/neural-weights-en-us)",
				!hasWOFDB && `no WOF admin SQLite at ${wofPath} (set $MAILWOMAN_WOF_DB)`,
				!hasTiles && `no fixture PMTiles archive at ${TILES_PATH}`,
			]
				.filter((reason) => reason !== false)
				.join("; ")
	)
}

describe.skipIf(!canRun)("runStaticDebug", { timeout: 30_000 }, () => {
	test("renders a captured DebugFrame for a real address, tier line + map ink + echoed input", async () => {
		// 31 rows is the shortest frame whose output pane reaches the tier line for this address.
		const options = await commandOptions("--tiles", TILES_PATH.toString(), "--debug-size", "100x31")

		const text = stripANSI(await runStaticDebug("3215 SE Clinton St, Portland OR", options))

		expect(text).toMatch(/address_point|admin/)

		expect(/[⠀-⣿]/u.test(text) || text.includes("●")).toBe(true)

		expect(text).toContain("3215 SE Clinton St, Portland OR")
	})

	test("the captured frame carries the dev-mode evidence rows and result sections from REAL pipeline data", async () => {
		const options = await commandOptions("--tiles", TILES_PATH.toString(), "--debug-size", "140x40")

		const text = stripANSI(await runStaticDebug("3215 SE Clinton St, Portland OR", options))

		expect(text).toMatch(/applied\s+locale en-US \(default\)  scope US hard \(inferred\)/u)
		expect(text).toMatch(/system\s+us \((auto|pinned)\)/u)
		expect(text).toContain("mode ")
		expect(text).toMatch(/locale-head\s+[A-Z]{2} \d\.\d\d/u)
		// The c6 tokenizer writes each digit as its own piece, so `3215` renders as `▁ 3 2 1 5`.
		expect(text).toMatch(/tokens\s+\d+\s+▁\s?3/u)
		expect(text).toMatch(/channels\s+anchor (not fed|\d+\/\d+)/u)
		expect(text).toMatch(/decode\s+(viterbi|argmax)/u)

		for (const heading of ["components", "kind", "timing", "resolved"]) {
			expect(text).toContain(heading)
		}

		// The renderer reports measured timing, so zero would show that the session supplied a placeholder.
		expect(text).toMatch(/parse\s+\d+\.\d ms/u)

		expect(text).toContain("static frame")
	})
})

describe("runStaticDebug --debug-size floor", () => {
	test("a --debug-size below 60x21 rejects with the minimum-size guidance, not a map-tui RangeError", async () => {
		const options = await commandOptions("--debug-size", "100x5")

		// The floor is checked before any DB or weights work, so this rejects even without a resolvable session.
		await expect(runStaticDebug("3215 SE Clinton St, Portland OR", options)).rejects.toThrow(
			/--debug-size below the 60x21 minimum: 100x5/
		)
	})

	test("the floor is exactly the frame's fixed chrome plus a 6-row map pane", async () => {
		// 20 rows leaves the map pane 5 content rows and 21 leaves it 6, so asserting the
		// pair keeps the constant and `mapPaneCellSize` from drifting apart.
		expect(mapPaneCellSize(60, 21).rows).toBe(6)
		expect(mapPaneCellSize(60, 20).rows).toBe(5)

		await expect(
			runStaticDebug("3215 SE Clinton St, Portland OR", await commandOptions("--debug-size", "60x20"))
		).rejects.toThrow(/--debug-size below the 60x21 minimum: 60x20/)
	})
})

describe("runStaticDebug empty input", () => {
	test("an empty input rejects with the one-shot path's missing-argument message, not a junk frame", async () => {
		// The empty-input guard runs before the format and size floors and before
		// `createGeocodeSession`, so this rejects even without a resolvable session.
		await expect(runStaticDebug("", await commandOptions())).rejects.toThrow(
			'geocode requires a positional address argument  (e.g. mailwoman geocode "350 5th Ave, New York, NY")'
		)
	})
})

describe("runStaticDebug --debug format guard", () => {
	test("a --format shorthand alongside --debug rejects, not a silent pick", async () => {
		const options = await commandOptions("--text")

		await expect(runStaticDebug("3215 SE Clinton St, Portland OR", options)).rejects.toThrow(
			"--debug is its own output surface; drop --text."
		)
	})

	test("an explicit non-default --format alongside --debug rejects the same way", async () => {
		const options = await commandOptions("--format", "text")

		await expect(runStaticDebug("3215 SE Clinton St, Portland OR", options)).rejects.toThrow(
			"--debug is its own output surface; drop --format text."
		)
	})
})
