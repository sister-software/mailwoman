/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Tests for the `fr-lieudit` recipe: end-to-end over a small fixture BAN département directory
 *   (mirroring `ban/sdk/ban.test.ts`'s header/row shape), verifying the dependent_locality/locality
 *   mapping, the own-line raw rendering, junk-row exclusion (delegated to `ban/sdk`'s `cleanLieuDit`),
 *   determinism under a fixed seed, and the `--country-fraction` append.
 */

import { gzip } from "@mailwoman/core/fs/compression"
import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { writeLocalTextFile, writeLocalFile } from "@mailwoman/core/fs/writers"
import { parseJSONStrict } from "@mailwoman/core/json"
import { frLieuditRecipe } from "@mailwoman/corpus/recipes/fr-lieudit"
import type { SliceRecipeOpts } from "@mailwoman/corpus/recipes/scaffold"
import type { SliceRow } from "@mailwoman/corpus/test-kit/corpus-recipe"
import { join, resolvePath } from "path-ts"
import { afterAll, describe, expect, it } from "vitest"

const fixtures = new AsyncDisposableStack()

afterAll(() => fixtures.disposeAsync())

const HEADER =
	"id;id_fantoir;numero;rep;nom_voie;code_postal;code_insee;nom_commune;code_insee_ancienne_commune;nom_ancienne_commune;x;y;lon;lat;type_position;alias;nom_ld;libelle_acheminement;nom_afnor;source_position;source_nom_voie;certification_commune;cad_parcelles"

function row(id: string, numero: string, street: string, postcode: string, commune: string, nomLd: string): string {
	return `${id};;${numero};;${street};${postcode};48004;${commune};;;766812;6375458;3.840026;44.474983;entrée;;${nomLd};;;;;1;`
}

async function fixtureBanDir(files: Record<string, string[]>): Promise<string> {
	const dir = resolvePath(fixtures.use(await temporaryDirectory("mw-fr-lieudit-")).path)

	for (const [dept, rows] of Object.entries(files)) {
		await writeLocalTextFile([HEADER, ...rows].join("\n") + "\n", join(dir, `adresses-${dept}.csv`))
	}

	return dir
}

function baseOpts(overrides: Partial<SliceRecipeOpts> = {}): SliceRecipeOpts {
	return { output: "", seed: 42, variants: 1, count: 100, ...overrides }
}

describe("fr-lieudit recipe", () => {
	it("emits dependent_locality from nom_ld, locality from nom_commune, own-line raw", async () => {
		const banDir = await fixtureBanDir({
			"48": [row("1", "6", "Route de Pomaret", "48800", "Altier", "Le Bourg")],
		})

		const lines: string[] = []

		const stats = await frLieuditRecipe.run(baseOpts({ banDir }), (l) => lines.push(l))

		expect(stats.emitted).toBe(1)
		expect(stats.skipped).toBe(0)
		const parsed = parseJSONStrict<SliceRow>(lines[0]!)
		expect(parsed.components!.dependent_locality).toBe("Le Bourg")
		expect(parsed.components!.locality).toBe("Altier")
		expect(parsed.raw).toBe("6 Route de Pomaret\nLe Bourg\n48800 Altier")
		expect(parsed.source).toBe("synth-fr-lieudit")
		// The dependent_locality line sits BEFORE the postcode+commune line.
		const lieuIdx = parsed.raw.indexOf("Le Bourg")
		const cityIdx = parsed.raw.indexOf("48800 Altier")
		expect(lieuIdx).toBeGreaterThan(-1)
		expect(cityIdx).toBeGreaterThan(lieuIdx)
	})

	it("excludes junk/dup nom_ld rows (delegated to ban/sdk's cleanLieuDit)", async () => {
		const banDir = await fixtureBanDir({
			"48": [
				row("1", "6", "Route de Pomaret", "48800", "Altier", "Le Bourg"), // clean
				row("2", "8", "Route de Pomaret", "48800", "Altier", "lieudit_complement_nom"), // header-leak
				row("3", "9", "Route de Pomaret", "48800", "Altier", "_1"), // placeholder
				row("4", "10", "Route de Pomaret", "48800", "Altier", "Altier"), // exact dup
			],
		})

		const lines: string[] = []

		const stats = await frLieuditRecipe.run(baseOpts({ banDir }), (l) => lines.push(l))

		expect(stats.emitted).toBe(1)
		expect(parseJSONStrict<SliceRow>(lines[0]!).components!.dependent_locality).toBe("Le Bourg")
	})

	it("is deterministic under a fixed seed (same output twice)", async () => {
		const banDir = await fixtureBanDir({
			"48": Array.from({ length: 20 }, (_, i) =>
				row(String(i), String(i + 1), "Route de Pomaret", "48800", "Altier", `Lieu ${i}`)
			),
		})

		const opts = baseOpts({ banDir, count: 10 })
		const linesA: string[] = []
		const linesB: string[] = []

		await frLieuditRecipe.run(opts, (l) => linesA.push(l))
		await frLieuditRecipe.run(opts, (l) => linesB.push(l))

		expect(linesA).toEqual(linesB)
	})

	it("--country-fraction=1 appends France + a country component to every row", async () => {
		const banDir = await fixtureBanDir({
			"48": [row("1", "6", "Route de Pomaret", "48800", "Altier", "Le Bourg")],
		})

		const lines: string[] = []

		await frLieuditRecipe.run(baseOpts({ banDir, countryFraction: 1 }), (l) => lines.push(l))

		const parsed = parseJSONStrict<SliceRow>(lines[0]!)
		expect(parsed.components!.country).toBeDefined()
		expect(parsed.raw.endsWith(parsed.components!.country!)).toBe(true)
	})

	it("--country-fraction=0 (default) never appends a country component", async () => {
		const banDir = await fixtureBanDir({
			"48": Array.from({ length: 5 }, (_, i) =>
				row(String(i), String(i + 1), "Route de Pomaret", "48800", "Altier", `Lieu ${i}`)
			),
		})

		const lines: string[] = []

		await frLieuditRecipe.run(baseOpts({ banDir }), (l) => lines.push(l))

		for (const l of lines) {
			expect(parseJSONStrict<SliceRow>(l).components!.country).toBeUndefined()
		}
	})

	it("--source-name overrides the emitted source tag", async () => {
		const banDir = await fixtureBanDir({
			"48": [row("1", "6", "Route de Pomaret", "48800", "Altier", "Le Bourg")],
		})

		const lines: string[] = []

		await frLieuditRecipe.run(baseOpts({ banDir, sourceName: "synth-fr-lieudit-test" }), (l) => lines.push(l))

		expect(parseJSONStrict<SliceRow>(lines[0]!).source).toBe("synth-fr-lieudit-test")
	})

	it("throws when no BAN dept files are found", async () => {
		const banDir = await fixtureBanDir({})

		await expect(frLieuditRecipe.run(baseOpts({ banDir }), () => {})).rejects.toThrow(
			/No BAN adresses-<dept>\.csv files/
		)
	})

	it("excludes the 'merged'/'france' aggregate files (double-count guard)", async () => {
		const banDir = await fixtureBanDir({
			"48": [row("1", "6", "Route de Pomaret", "48800", "Altier", "Le Bourg")],
			merged: [row("2", "6", "Route de Pomaret", "48800", "Altier", "Le Bourg")],
			france: [row("3", "6", "Route de Pomaret", "48800", "Altier", "Le Bourg")],
		})

		const stats = await frLieuditRecipe.run(baseOpts({ banDir }), () => {})

		expect(stats.emitted).toBe(1)
	})

	it("dedupes a dept present as BOTH .csv and .csv.gz, preferring the uncompressed .csv (observed on disk for 13/2A/48/69/75)", async () => {
		const banDir = await fixtureBanDir({
			"48": [row("1", "6", "Route de Pomaret", "48800", "Altier", "Le Bourg")],
		})

		const csvBody = [
			HEADER,
			row("2", "8", "Route de Pomaret", "48800", "Altier", "Le Village"), // different id/lieu-dit
		].join("\n")

		await writeLocalFile(await gzip(csvBody + "\n"), join(banDir, "adresses-48.csv.gz"))

		const stats = await frLieuditRecipe.run(baseOpts({ banDir }), () => {})

		// Must NOT read both — exactly the one row from the uncompressed adresses-48.csv survives.
		expect(stats.emitted).toBe(1)
	})
})
