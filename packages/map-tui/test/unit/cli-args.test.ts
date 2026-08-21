/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { type BrowseArgs, CLIArgsError, HELP_TEXT, parseCLIArgs } from "@mailwoman/map-tui/cli-args"
import { describe, expect, it } from "vitest"

function browse(argv: string[], environment?: { MAILWOMAN_TILES?: string }): BrowseArgs {
	const args = parseCLIArgs(argv, environment)

	if (args.mode !== "browse") throw new Error(`expected a browse result, got ${args.mode}`)

	return args
}

describe("parseCLIArgs", () => {
	it("opens the world view when only an archive is given", () => {
		expect(browse(["--tiles", "planet.pmtiles"])).toEqual({
			mode: "browse",
			tiles: "planet.pmtiles",
			lat: 0,
			lon: 0,
			zoom: 2,
		})
	})

	it("takes the archive from MAILWOMAN_TILES", () => {
		expect(browse([], { MAILWOMAN_TILES: "/data/planet.pmtiles" }).tiles).toBe("/data/planet.pmtiles")
	})

	it("prefers an explicit --tiles over the environment", () => {
		expect(browse(["--tiles", "flag.pmtiles"], { MAILWOMAN_TILES: "env.pmtiles" }).tiles).toBe("flag.pmtiles")
	})

	it("reads a center and zoom", () => {
		const args = browse(["--tiles", "p.pmtiles", "--lat", "45.5034", "--lon", "-122.6023", "--zoom", "12"])

		expect(args.lat).toBe(45.5034)
		expect(args.lon).toBe(-122.6023)
		expect(args.zoom).toBe(12)
	})

	// Half the planet has a negative longitude, and `node:util` refuses a space-separated value that starts with a
	// dash. Both spellings have to reach the same viewport.
	it("accepts a negative coordinate in either spelling", () => {
		const spaced = browse(["--tiles", "p.pmtiles", "--lon", "-122.6023", "--lat", "-33.87"])
		const joined = browse(["--tiles", "p.pmtiles", "--lon=-122.6023", "--lat=-33.87"])

		expect(spaced).toEqual(joined)
		expect(spaced.lon).toBe(-122.6023)
		expect(spaced.lat).toBe(-33.87)
	})

	it("rounds a fractional zoom to the tile pyramid's own levels", () => {
		expect(browse(["--tiles", "p.pmtiles", "--zoom", "12.6"]).zoom).toBe(13)
	})

	it("reports help and version before anything else can fail", () => {
		expect(parseCLIArgs(["--help"])).toEqual({ mode: "help" })
		expect(parseCLIArgs(["-h"])).toEqual({ mode: "help" })
		expect(parseCLIArgs(["--version"])).toEqual({ mode: "version" })
		expect(parseCLIArgs(["-v"])).toEqual({ mode: "version" })
	})

	describe("rejections", () => {
		it("names the archive flag and where to get one when neither source is set", () => {
			expect(() => parseCLIArgs([])).toThrow(CLIArgsError)
			expect(() => parseCLIArgs([])).toThrow(/--tiles/)
			expect(() => parseCLIArgs([])).toThrow(/MAILWOMAN_TILES/)
			expect(() => parseCLIArgs([])).toThrow(/protomaps\.com\/downloads/)
		})

		it("treats a blank archive path as no archive at all", () => {
			expect(() => parseCLIArgs(["--tiles", "   "])).toThrow(/--tiles/)
			expect(() => parseCLIArgs([], { MAILWOMAN_TILES: "" })).toThrow(/--tiles/)
		})

		it("rejects an unparseable number", () => {
			expect(() => parseCLIArgs(["--tiles", "p.pmtiles", "--lat", "north"])).toThrow(/--lat expects a number/)
			expect(() => parseCLIArgs(["--tiles", "p.pmtiles", "--zoom", ""])).toThrow(/--zoom expects a number/)
		})

		it("rejects an out-of-range coordinate or zoom", () => {
			expect(() => parseCLIArgs(["--tiles", "p.pmtiles", "--lat", "91"])).toThrow(/--lat must be between -90 and 90/)

			expect(() => parseCLIArgs(["--tiles", "p.pmtiles", "--lon", "181"])).toThrow(/--lon must be between -180 and 180/)

			expect(() => parseCLIArgs(["--tiles", "p.pmtiles", "--zoom", "25"])).toThrow(/--zoom must be between 0 and 24/)
			expect(() => parseCLIArgs(["--tiles", "p.pmtiles", "--zoom", "-1"])).toThrow(/--zoom must be between 0 and 24/)
		})

		it("points an unknown or misplaced argument at --help", () => {
			expect(() => parseCLIArgs(["--bogus"])).toThrow(/map-tui --help/)
			expect(() => parseCLIArgs(["planet.pmtiles"])).toThrow(/map-tui --help/)
		})
	})
})

describe("HELP_TEXT", () => {
	it("documents every flag, the keys, and where tiles come from", () => {
		for (const fragment of ["--tiles", "--lat", "--lon", "--zoom", "--help", "--version"]) {
			expect(HELP_TEXT).toContain(fragment)
		}

		expect(HELP_TEXT).toContain("https://protomaps.com/downloads")
		expect(HELP_TEXT).toContain("q, Esc, Ctrl+C")
	})
})
