/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Smoke test for the `--debug` non-TTY path ({@link runStaticDebug} in `command.tsx`). Runs IN PROCESS — no CLI
 *   spawn — so it needs both prerequisites the compiled CLI would otherwise hide behind a subprocess: the neural
 *   weights ({@link resolveWeights}, same probe `mailwoman doctor` and `geocode-session.ts` use) AND a WOF admin
 *   SQLite distribution. Guard mirrors `commands/geocode.test.ts`'s `hasWOFDb` predicate exactly (same env var,
 *   same convention path) so the two suites skip and run together rather than disagreeing about the environment.
 *
 *   The `--debug-size` floor test below runs UNCONDITIONALLY (no guard): `assertDebugSizeFloor` fires before
 *   `runStaticDebug` ever calls `createGeocodeSession`, so the rejection needs neither weights nor a database.
 */

import { existsSync } from "node:fs"

import { $public } from "@mailwoman/core/env"
import { dataRootPath, repoRootPath } from "@mailwoman/core/utils"
import { resolveWeights } from "@mailwoman/neural/weights"
import { describe, expect, test } from "vitest"

import { options as geocodeOptionsSchema } from "../commands/geocode.tsx"
import { runStaticDebug } from "./command.tsx"

// MARK: Environment guard

// Same predicate as commands/geocode.test.ts's `hasWOFDb`.
const DEFAULT_WOF_PATH = String(dataRootPath("wof", "admin-global-priority.db"))
const wofPath = $public.MAILWOMAN_WOF_DB ?? DEFAULT_WOF_PATH
const hasWOFDb = existsSync(wofPath)

const hasWeights = (() => {
	try {
		resolveWeights({ locale: "en-us" })

		return true
	} catch {
		return false
	}
})()

const TILES_PATH = String(repoRootPath("map-tui", "test", "fixtures", "portland.pmtiles"))
const hasTiles = existsSync(TILES_PATH)

const canRun = hasWOFDb && hasWeights && hasTiles

if (!canRun) {
	console.warn(
		"Skipping mailwoman geocode --debug static smoke: " +
			[
				!hasWeights && "no resolvable neural weights (@mailwoman/neural-weights-en-us)",
				!hasWOFDb && `no WOF admin SQLite at ${wofPath} (set $MAILWOMAN_WOF_DB)`,
				!hasTiles && `no fixture PMTiles archive at ${TILES_PATH}`,
			]
				.filter(Boolean)
				.join("; ")
	)
}

// MARK: Smoke test

describe.skipIf(!canRun)("runStaticDebug", () => {
	test("renders a captured DebugFrame for a real address, tier line + map ink + echoed input", async () => {
		const options = geocodeOptionsSchema.parse({ tiles: TILES_PATH, debugSize: "100x30" })

		const text = await runStaticDebug("3215 SE Clinton St, Portland OR", options)

		// The resolved tier line — street-level when the shard is present, admin centroid otherwise; either is a
		// legitimate resolve for this environment, so the assertion accepts both.
		expect(text).toMatch(/address_point|admin/)

		// The map pane inked SOMETHING: a rendered braille cell (U+2800..U+28FF) from the tile geometry, or at
		// minimum the marker glyph at the resolved coordinate.
		expect(/[⠀-⣿]/u.test(text) || text.includes("●")).toBe(true)

		// The raw query echoed back in the input row.
		expect(text).toContain("3215 SE Clinton St, Portland OR")
	})
})

// MARK: --debug-size floor

describe("runStaticDebug --debug-size floor", () => {
	test("a --debug-size below 60x14 rejects with the minimum-size guidance, not a map-tui RangeError", async () => {
		const options = geocodeOptionsSchema.parse({ debugSize: "100x5" })

		// Regression for the raw `RangeError: Invalid typed array length: -4608` `new RGBAGrid` threw at this size
		// (mapPaneCellSize's row math goes negative before map-tui's allocation does) — assertDebugSizeFloor now
		// catches it before any DB/weights work, so this rejects even without a resolvable session.
		await expect(runStaticDebug("3215 SE Clinton St, Portland OR", options)).rejects.toThrow(
			/--debug-size below the 60x14 minimum: 100x5/
		)
	})
})
