/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Every frame is stripped of ANSI before it is matched, because chalk's dim/reset pair around an evidence label means `\s+` cannot span the gap in a colored frame.
 */

import { pathExists } from "@mailwoman/core/fs/readers"
import { workspacePath } from "@mailwoman/core/paths"
import { resolveWeights } from "@mailwoman/neural/weights"
import { wofDatabasePath } from "@mailwoman/resolver-wof-sqlite/paths"
import { runStaticDebug } from "mailwoman/debug-view/command"
import { mapPaneCellSize } from "mailwoman/debug-view/DebugFrame"
import { describe, expect, test } from "vitest"

import { stripAnsi } from "#cli-kit"
import { $public } from "#env"
import { createGeocodeCommandOptions } from "#geocode"

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

describe.skipIf(!canRun)("runStaticDebug", () => {
	test("renders a captured DebugFrame for a real address, tier line + map ink + echoed input", async () => {
		const options = createGeocodeCommandOptions({ tiles: TILES_PATH, debugSize: "100x30" })

		const text = stripAnsi(await runStaticDebug("3215 SE Clinton St, Portland OR", options))

		expect(text).toMatch(/address_point|admin/)

		expect(/[⠀-⣿]/u.test(text) || text.includes("●")).toBe(true)

		expect(text).toContain("3215 SE Clinton St, Portland OR")
	})

	test("the captured frame carries the dev-mode evidence rows and result sections from REAL pipeline data", async () => {
		const options = createGeocodeCommandOptions({ tiles: TILES_PATH, debugSize: "140x40" })

		const text = stripAnsi(await runStaticDebug("3215 SE Clinton St, Portland OR", options))

		expect(text).toMatch(/system\s+us \((auto|pinned)\)/u)
		expect(text).toContain("mode ")
		expect(text).toMatch(/locale-head\s+[A-Z]{2} \d\.\d\d/u)
		expect(text).toMatch(/tokens\s+\d+\s+▁3/u)
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
	test("a --debug-size below 60x20 rejects with the minimum-size guidance, not a map-tui RangeError", async () => {
		const options = createGeocodeCommandOptions({ debugSize: "100x5" })

		// The floor is checked before any DB or weights work, so this rejects even without a resolvable session.
		await expect(runStaticDebug("3215 SE Clinton St, Portland OR", options)).rejects.toThrow(
			/--debug-size below the 60x20 minimum: 100x5/
		)
	})

	test("the floor is exactly the frame's fixed chrome plus a 6-row map pane", async () => {
		// 19 rows leaves the map pane 5 content rows and 20 leaves it 6, so asserting the
		// pair keeps the constant and `mapPaneCellSize` from drifting apart.
		expect(mapPaneCellSize(60, 20).rows).toBe(6)
		expect(mapPaneCellSize(60, 19).rows).toBe(5)

		await expect(
			runStaticDebug("3215 SE Clinton St, Portland OR", createGeocodeCommandOptions({ debugSize: "60x19" }))
		).rejects.toThrow(/--debug-size below the 60x20 minimum: 60x19/)
	})
})

describe("runStaticDebug empty input", () => {
	test("an empty input rejects with the one-shot path's missing-argument message, not a junk frame", async () => {
		// The empty-input guard runs before the format and size floors and before
		// `createGeocodeSession`, so this rejects even without a resolvable session.
		await expect(runStaticDebug("", createGeocodeCommandOptions())).rejects.toThrow(
			'geocode requires a positional address argument  (e.g. mailwoman geocode "350 5th Ave, New York, NY")'
		)
	})
})

describe("runStaticDebug --debug format guard", () => {
	test("a --format shorthand alongside --debug rejects, not a silent pick", async () => {
		const options = createGeocodeCommandOptions({ text: true })

		await expect(runStaticDebug("3215 SE Clinton St, Portland OR", options)).rejects.toThrow(
			"--debug is its own output surface; drop --text."
		)
	})

	test("an explicit non-default --format alongside --debug rejects the same way", async () => {
		const options = createGeocodeCommandOptions({ format: "text" })

		await expect(runStaticDebug("3215 SE Clinton St, Portland OR", options)).rejects.toThrow(
			"--debug is its own output surface; drop --format text."
		)
	})
})
