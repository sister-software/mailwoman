/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Regression guard for `parse --default-country` (the resolver country scope). Without a country
 *   hint the WOF resolver resolves globally, so a bare region abbreviation (`NY`) lands on whatever the
 *   gazetteer ranks highest — often a foreign homonym (a Scottish locality at lat ~57) rather than the
 *   US state. The demo passes `country: "US"`; this gives the CLI parity by inferring the country from
 *   `--locale` (overridable, `none` to disable).
 *
 *   The unit tests (the locale→country inference + the override precedence) are CI-safe. The
 *   end-to-end NY-doesn't-become-Scotland check needs the GLOBAL admin DB (the US-only DB can't
 *   reproduce the homonym), so it skips when that DB is absent.
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
		exec("node", [cliBin, "parse", "--neural", "--resolve", "--resolve-db", GLOBAL_WOF, "--format", "xml", ...extra, NY], {
			env: { ...process.env, NODE_NO_WARNINGS: "1" },
			maxBuffer: 4 * 1024 * 1024,
		})

	test("default (US inferred from en-US) resolves New York to the US city, not a foreign homonym", async () => {
		const { stdout } = await run([])
		// Locality "New York" resolves to a NYC-range coordinate (lat 40–41).
		const m = /locality[^>]*lat="(4[01]\.\d+)" lon="(-7[34]\.\d+)"/.exec(stdout)
		expect(m, `expected a NYC-range locality coordinate, got:\n${stdout}`).not.toBeNull()
	})

	test("--default-country none reverts to the global homonym (the opt-out is real)", async () => {
		const { stdout } = await run(["--default-country", "none"])
		// With no country filter the region NY resolves to a high-latitude foreign place (Scotland ~57).
		const m = /region[^>]*lat="(5\d\.\d+)"/.exec(stdout)
		expect(m, `expected a foreign (lat>50) region resolution with --default-country none, got:\n${stdout}`).not.toBeNull()
	})
})
