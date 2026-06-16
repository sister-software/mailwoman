/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Regression guard for `parse --default-country` (the resolver country scope). Without a country
 *   hint the WOF resolver resolves globally; the demo passes `country: "US"`, and this gives the
 *   CLI parity by inferring the country from `--locale` (overridable, `none` to disable).
 *
 *   Note (#595): a bare region abbreviation (`NY`) once landed on a foreign homonym (a Scottish
 *   locality at lat ~57) without a country hint — that was the original motivation. WOF ranking has
 *   since improved so US New York State now wins even unfiltered, so the end-to-end test guards the
 *   improved ranking (US NY both with the hint and with `--default-country none`) rather than the
 *   obsolete foreign-flip.
 *
 *   The unit tests (the locale→country inference + the override precedence) are CI-safe. The
 *   end-to-end resolution check needs the GLOBAL admin DB, so it skips when that DB is absent.
 */
import { execFile } from "node:child_process"
import { existsSync } from "node:fs"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import { describe, expect, test } from "vitest"
import { localeToCountry, options as parseOptions, resolverDefaultCountry } from "../commands/parse.js"

const exec = promisify(execFile)
const repoRoot = resolve(fileURLToPath(import.meta.url), "../..")
const cliBin = resolve(repoRoot, "out", "cli.js")
const GLOBAL_WOF = process.env["MAILWOMAN_WOF_GLOBAL_DB"] ?? "/mnt/playpen/mailwoman-data/wof/admin-global-priority.db"

describe("localeToCountry", () => {
	test("infers the ISO country from a BCP-47 region subtag", () => {
		expect(localeToCountry("en-US")).toBe("US")
		expect(localeToCountry("fr-FR")).toBe("FR")
		expect(localeToCountry("de-DE")).toBe("DE")
	})
	test("ignores script subtags and language-only tags (no guessing)", () => {
		expect(localeToCountry("en")).toBeUndefined()
		expect(localeToCountry("zh-Hant")).toBeUndefined() // 4-letter script subtag, not a region
		expect(localeToCountry(undefined)).toBeUndefined()
	})
	test("reads the trailing region of a multi-subtag tag", () => {
		expect(localeToCountry("zh-Hant-TW")).toBe("TW")
	})
})

describe("resolverDefaultCountry", () => {
	test("explicit --default-country wins over the locale", () => {
		expect(resolverDefaultCountry({ defaultCountry: "FR", locale: "en-US" })).toBe("FR")
	})
	test("falls back to the locale's country when unset", () => {
		expect(resolverDefaultCountry({ locale: "de-DE" })).toBe("DE")
	})
	test("'none' disables the filter", () => {
		expect(resolverDefaultCountry({ defaultCountry: "none", locale: "en-US" })).toBeUndefined()
	})
})

describe("--default-country schema validation", () => {
	test("accepts an explicit ISO country", () => {
		expect(parseOptions.parse({ defaultCountry: "US" }).defaultCountry).toBe("US")
	})
	test("is optional (undefined when omitted)", () => {
		expect(parseOptions.parse({}).defaultCountry).toBeUndefined()
	})
})

// End-to-end: needs the GLOBAL admin DB (the US-only DB can't reproduce the foreign homonym).
const describeIfGlobal = describe.skipIf(!existsSync(GLOBAL_WOF))
describeIfGlobal(`parse --resolve against the global WOF (${GLOBAL_WOF})`, () => {
	const NY = "350 5th Ave, New York, NY 10118"
	const run = (extra: string[]) =>
		exec(
			"node",
			[cliBin, "parse", "--neural", "--resolve", "--resolve-db", GLOBAL_WOF, "--format", "xml", ...extra, NY],
			{
				env: { ...process.env, NODE_NO_WARNINGS: "1" },
				maxBuffer: 4 * 1024 * 1024,
			}
		)

	test("default (US inferred from en-US) resolves New York to the US city, not a foreign homonym", async () => {
		const { stdout } = await run([])
		// Locality "New York" resolves to a NYC-range coordinate (lat 40–41).
		const m = /locality[^>]*lat="(4[01]\.\d+)" lon="(-7[34]\.\d+)"/.exec(stdout)
		expect(m, `expected a NYC-range locality coordinate, got:\n${stdout}`).not.toBeNull()
	})

	test("--default-country none is accepted and resolves NY to US New York State (WOF ranks it over the foreign homonym, even unfiltered)", async () => {
		const { stdout } = await run(["--default-country", "none"])
		// HISTORY (#595): this once asserted the unfiltered region NY flipped to a Scottish homonym (lat
		// ~57) — proving the country opt-out changed the result. WOF ranking has since improved so US New
		// York State (lat ~42.9, wof:85688543) now wins even with NO country filter; the opt-out is still
		// a real, plumbed flag, but it no longer flips THIS input. The assertion now guards that improved
		// ranking (and that `--default-country none` is accepted and resolves cleanly) rather than the
		// obsolete foreign-flip premise. The default-US locality test above still covers the country hint.
		const m = /region[^>]*lat="(42\.\d+)"/.exec(stdout)
		expect(
			m,
			`expected US New York State (region lat 42.x) under --default-country none, got:\n${stdout}`
		).not.toBeNull()
	})
})
