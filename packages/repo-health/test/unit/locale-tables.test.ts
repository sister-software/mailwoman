/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file The country→locale guard over a planted tree: discovery, a missing shipping locale, a transposed pair.
 *
 *   The defect it was written for is the first case: `release.config.json` gains a locale under `charWeights`, the
 *   Latin-only census table is not touched, and every consumer reads the absence as a country with no weights
 *   package. The case that matters most for the shape is `finds a table nobody registered` — the check discovers
 *   its subjects, because a check that names them cannot see the one somebody adds.
 */

import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { writeLocalTextFile } from "@mailwoman/core/fs/writers"
import { stringifyJSON } from "@mailwoman/core/json"
import { findLocaleTables, localeTablesCheck } from "@mailwoman/repo-health/checks/locale/tables"
import { afterAll, describe, expect, it } from "vitest"

const fixtures = new AsyncDisposableStack()

afterAll(() => fixtures.disposeAsync())

const CENSUS = "packages/mailwoman/lib/coverage/census.ts"
const ROUTING = "packages/mailwoman/lib/eval-harness/gauntlet/routing.ts"

const weightsMap = (pairs: ReadonlyArray<readonly [string, string]>) =>
	`export const WEIGHTS_PACKAGE_BY_COUNTRY: ReadonlyMap<string, string> = new Map([\n${pairs
		.map(([country, locale]) => `\t["${country}", "${locale}"],`)
		.join("\n")}\n])\n`

const objectTable = (name: string, pairs: ReadonlyArray<readonly [string, string]>) =>
	`export const ${name}: Readonly<Record<string, string>> = {\n${pairs
		.map(([country, locale]) => `\t${country}: "${locale}",`)
		.join("\n")}\n}\n`

/**
 * Two entries is the discovery minimum, so every fixture's census table carries at least that many.
 */
const SHIPPING_TWO = [
	["US", "en-us"],
	["FR", "fr-fr"],
] as const

async function plant(options: {
	config: Record<string, unknown>
	weights?: ReadonlyArray<readonly [string, string]>
	extra?: Record<string, string>
}) {
	const root = fixtures.use(await temporaryDirectory("locale-tables-")).path

	const files: Record<string, string> = {
		"release.config.json": stringifyJSON(options.config),
		[CENSUS]: weightsMap(options.weights ?? SHIPPING_TWO),
		...options.extra,
	}

	for (const [file, text] of Object.entries(files)) {
		await writeLocalTextFile(text, root(file))
	}

	return { repoRoot: root.toString(), trackedFiles: Object.keys(files).filter((file) => file.endsWith(".ts")) }
}

describe("findLocaleTables", () => {
	it("finds a table nobody registered, which is why it discovers rather than lists", async () => {
		const context = await plant({
			config: { locales: ["en-us", "fr-fr"] },
			extra: {
				"packages/corpus/lib/somewhere-new.ts": objectTable("LOCALE_BY_COUNTRY", [
					["DE", "de-DE"],
					["IT", "it-IT"],
				]),
			},
		})

		const names = (await findLocaleTables(context)).map((table) => table.name).toSorted()

		expect(names).toEqual(["LOCALE_BY_COUNTRY", "WEIGHTS_PACKAGE_BY_COUNTRY"])
	})

	it("refuses a map that is mostly something else, and one with a single pair", async () => {
		const context = await plant({
			config: { locales: ["en-us", "fr-fr"] },
			extra: {
				// One locale pair among four entries: a table of something else that happens to carry one.
				"packages/corpus/lib/mixed.ts": objectTable("SOURCE_BY_COUNTRY", [
					["DE", "de-DE"],
					["IT", "overture"],
					["ES", "geonames"],
					["FR", "ban"],
				]),
				"packages/corpus/lib/single.ts": objectTable("ONE_PAIR", [["DE", "de-DE"]]),
			},
		})

		expect((await findLocaleTables(context)).map((table) => table.name)).toEqual(["WEIGHTS_PACKAGE_BY_COUNTRY"])
	})
})

describe("localeTablesCheck", () => {
	it("no longer asks completeness of any table, because the one it bound is now derived", async () => {
		// `WEIGHTS_PACKAGE_BY_COUNTRY` was a hand-written copy of `release.config.json`'s
		// two lists, which is why it could omit `ja-jp` and `zh-cn`.
		// `@mailwoman/core/release-config`'s `weightsPackageByCountry` derives it from that
		// config now, and the invariant moved to that derivation's own test.
		const context = await plant({
			config: { locales: ["en-us", "fr-fr"], charWeights: { cjk: { overlays: ["ja-jp", "zh-cn"] } } },
			weights: [
				["US", "en-us"],
				["FR", "fr-fr"],
			],
		})

		expect(await localeTablesCheck.run(context)).toEqual([])
	})

	it("reports a country key that disagrees with its locale's region, in any table", async () => {
		const context = await plant({
			config: { locales: ["en-us", "fr-fr"] },
			extra: {
				[ROUTING]: objectTable("OVERLAY_LOCALE_BY_COUNTRY", [
					["GB", "de-DE"],
					["IT", "it-IT"],
				]),
			},
		})

		const diagnostics = await localeTablesCheck.run(context)

		expect(diagnostics).toHaveLength(1)
		expect(diagnostics[0]!.message).toContain("maps GB to de-DE")
		expect(diagnostics[0]!.file).toBe(ROUTING)
	})

	it("admits a deliberate subset", async () => {
		const context = await plant({
			config: { locales: ["en-us", "fr-fr", "es-es"] },
			weights: [
				["US", "en-us"],
				["FR", "fr-fr"],
				["ES", "es-es"],
			],
			extra: {
				// A subset of what ships, which is this table's interface.
				[ROUTING]: objectTable("OVERLAY_LOCALE_BY_COUNTRY", [
					["ES", "es-ES"],
					["FR", "fr-FR"],
				]),
			},
		})

		expect(await localeTablesCheck.run(context)).toEqual([])
	})

	it("admits a table naming a locale that does not ship yet", async () => {
		const context = await plant({
			config: { locales: ["en-us", "fr-fr"] },
			extra: {
				// `FST_LOCALE_BY_COUNTRY` carries `ko-kr` ahead of the Korean package.
				// The ladder resolves an FST by path and returns no FST when the file is absent.
				"packages/mailwoman/lib/eval-harness/autocomplete-ladder.ts": objectTable("FST_LOCALE_BY_COUNTRY", [
					["US", "en-us"],
					["KR", "ko-kr"],
				]),
			},
		})

		expect(await localeTablesCheck.run(context)).toEqual([])
	})

	it("passes a tree with no census table, because it no longer binds one", async () => {
		const context = await plant({
			config: { locales: ["en-us"] },
			extra: { [CENSUS]: "export const SOMETHING_ELSE = buildIt()\n" },
		})

		expect(await localeTablesCheck.run(context)).toEqual([])
	})
})
