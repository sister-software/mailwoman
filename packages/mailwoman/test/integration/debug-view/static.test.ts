/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Smoke test for the `--debug` non-TTY path ({@link runStaticDebug} in `command.tsx`). Runs IN PROCESS — no CLI
 *   spawn — so it needs both prerequisites the compiled CLI would otherwise hide behind a subprocess: the neural
 *   weights ({@link resolveWeights}, same probe `mailwoman doctor` and `geocode-session.ts` use) AND a WOF admin
 *   SQLite distribution. Guard mirrors `commands/geocode.test.ts`'s `hasWOFDB` predicate exactly (same env var,
 *   same convention path) so the two suites skip and run together rather than disagreeing about the environment.
 *
 *   The `--debug-size` floor, empty-input, and `--debug` format-guard tests below all run UNCONDITIONALLY (no guard):
 *   each rejection fires before `runStaticDebug` ever calls `createGeocodeSession`, so none of the three needs
 *   weights or a database.
 */

import { dataRootPath } from "@mailwoman/core/data-root"
import { pathExists } from "@mailwoman/core/fs/readers"
import { workspacePath } from "@mailwoman/core/paths"
import { resolveWeights } from "@mailwoman/neural/weights"
import { runStaticDebug } from "mailwoman/debug-view/command"
import { mapPaneCellSize } from "mailwoman/debug-view/DebugFrame"
import { $public } from "mailwoman/env"
import { createGeocodeCommandOptions } from "mailwoman/geocode"
import { describe, expect, test } from "vitest"

// MARK: Environment guard

// Same predicate as commands/geocode.test.ts's `hasWOFDB`.
const DEFAULT_WOF_PATH = String(dataRootPath("wof", "admin-global-priority.db"))
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

const TILES_PATH = String(workspacePath("map-tui", "test", "fixtures", "portland.pmtiles"))
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

// MARK: Smoke test

describe.skipIf(!canRun)("runStaticDebug", () => {
	test("renders a captured DebugFrame for a real address, tier line + map ink + echoed input", async () => {
		const options = createGeocodeCommandOptions({ tiles: TILES_PATH, debugSize: "100x30" })

		const text = await runStaticDebug("3215 SE Clinton St, Portland OR", options)

		// The resolved tier line — street-level when the database is present, admin centroid otherwise; either is a
		// legitimate resolve for this environment, so the assertion accepts both.
		expect(text).toMatch(/address_point|admin/)

		// The map pane inked SOMETHING: a rendered braille cell (U+2800..U+28FF) from the tile geometry, or at
		// minimum the marker glyph at the resolved coordinate.
		expect(/[⠀-⣿]/u.test(text) || text.includes("●")).toBe(true)

		// The raw query echoed back in the input row.
		expect(text).toContain("3215 SE Clinton St, Portland OR")
	})

	test("the captured frame carries the dev-mode evidence rows and result sections from REAL pipeline data", async () => {
		const options = createGeocodeCommandOptions({ tiles: TILES_PATH, debugSize: "140x40" })

		const text = await runStaticDebug("3215 SE Clinton St, Portland OR", options)

		// The evidence rows, each with a value only the live classifier can produce: the conventions system and how
		// it was chosen, the locale head's own axis, the SentencePiece stream, the channels as fed, the decode.
		expect(text).toMatch(/system\s+us \((auto|pinned)\)/u)
		expect(text).toContain("mode ")
		expect(text).toMatch(/locale-head\s+[A-Z]{2} \d\.\d\d/u)
		expect(text).toMatch(/tokens\s+\d+\s+▁3/u)
		expect(text).toMatch(/channels\s+anchor (not fed|\d+\/\d+)/u)
		expect(text).toMatch(/decode\s+(viterbi|argmax)/u)

		// The result panel's sections.
		for (const heading of ["components", "kind", "timing", "resolved"]) {
			expect(text).toContain(heading)
		}

		// Timing is measured, not defaulted — a zero here would mean the session handed over a placeholder.
		expect(text).toMatch(/parse\s+\d+\.\d ms/u)

		// And the footer says what this frame is.
		expect(text).toContain("static frame")
	})
})

// MARK: --debug-size floor

describe("runStaticDebug --debug-size floor", () => {
	test("a --debug-size below 60x20 rejects with the minimum-size guidance, not a map-tui RangeError", async () => {
		const options = createGeocodeCommandOptions({ debugSize: "100x5" })

		// Regression for the raw `RangeError: Invalid typed array length: -4608` `new RGBAGrid` threw at this size
		// (mapPaneCellSize's row math goes negative before map-tui's allocation does) — assertDebugSizeFloor now
		// catches it before any DB/weights work, so this rejects even without a resolvable session.
		await expect(runStaticDebug("3215 SE Clinton St, Portland OR", options)).rejects.toThrow(
			/--debug-size below the 60x20 minimum: 100x5/
		)
	})

	test("the floor is exactly the frame's fixed chrome plus a 6-row map pane", async () => {
		// The floor is arithmetic, not taste: 19 rows leaves the map pane 5 content rows, 20 leaves it 6. Asserting
		// the pair is what keeps the constant and `mapPaneCellSize` from drifting apart the next time a row is added
		// to the input area.
		expect(mapPaneCellSize(60, 20).rows).toBe(6)
		expect(mapPaneCellSize(60, 19).rows).toBe(5)

		await expect(
			runStaticDebug("3215 SE Clinton St, Portland OR", createGeocodeCommandOptions({ debugSize: "60x19" }))
		).rejects.toThrow(/--debug-size below the 60x20 minimum: 60x19/)
	})
})

// MARK: empty input

describe("runStaticDebug empty input", () => {
	test("an empty input rejects with the one-shot path's missing-argument message, not a junk frame", async () => {
		// `runStaticDebug`'s empty-input guard runs before assertDebugFormatSanity/assertDebugSizeFloor and before
		// createGeocodeSession, so this rejects even without a resolvable session — same unconditional posture as
		// the --debug-size floor test above.
		await expect(runStaticDebug("", createGeocodeCommandOptions())).rejects.toThrow(
			'geocode requires a positional address argument  (e.g. mailwoman geocode "350 5th Ave, New York, NY")'
		)
	})
})

// MARK: --debug format guard

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
