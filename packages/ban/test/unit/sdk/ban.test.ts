/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The two contracts the BAN ingest must hold: (1) the extract locates its columns BY NAME off the
 *   header (never by fixed position) and drops coordinate-less / streetless rows; (2) the provider is
 *   FR-only and keys with the FR street locale — never a silent fold with the wrong rules. Build/probe
 *   street-key consistency is covered by `@mailwoman/osm`'s `street-locale.test.ts` (same normalizer).
 */

import { cleanLieuDit, extractBANAddrPoints } from "@mailwoman/ban/sdk/extract"
import { streetLocaleForBANCountry, supportedBANCountries } from "@mailwoman/ban/sdk/street-locale"
import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { writeLocalTextFile } from "@mailwoman/core/fs/writers"
import { join } from "path-ts"
import { afterAll, expect, test } from "vitest"

const fixtures = new AsyncDisposableStack()

afterAll(() => fixtures.disposeAsync())

const HEADER =
	"id;id_fantoir;numero;rep;nom_voie;code_postal;code_insee;nom_commune;code_insee_ancienne_commune;nom_ancienne_commune;x;y;lon;lat;type_position;alias;nom_ld;libelle_acheminement;nom_afnor;source_position;source_nom_voie;certification_commune;cad_parcelles"

/**
 * Build one BAN CSV data row with `nom_ld` set, all other fields fixed/valid.
 */
function lieuDitRow(id: string, nomLd: string, commune = "Altier"): string {
	return `${id};;6;;Route de Pomaret;48800;48004;${commune};;;766812;6375458;3.840026;44.474983;entrée;;${nomLd};;;;;1;`
}

async function fixtureCSV(rows: string[]): Promise<string> {
	const dir = fixtures.use(await temporaryDirectory("ban-test-")).path
	const path = join(dir, "adresses-48.csv")
	await writeLocalTextFile([HEADER, ...rows].join("\n") + "\n", path)

	return path
}

test("extract: yields the full tuple, folds rep to lower-case, skips coordinate-less rows", async () => {
	const path = await fixtureCSV([
		"48004_x_1;;6;;Route de Pomaret;48800;48004;Altier;;;766812;6375458;3.840026;44.474983;entrée;;;;;;;1;",
		"48005_x_2;;8;BIS;route de Laval;48310;48005;Albaret-le-Comtal;;;0;0;3.127407;44.877158;entrée;;;;;;;1;",
		"48006_x_3;;9;;Rue Sans Coord;48000;48006;Mende;;;;;;;entrée;;;;;;;1;", // empty lon/lat → skipped
	])

	const recs = []

	for await (const r of extractBANAddrPoints(path)) {
		recs.push(r)
	}

	expect(recs).toHaveLength(2)

	expect(recs[0]).toMatchObject({
		numero: "6",
		rep: null,
		street: "Route de Pomaret",
		postcode: "48800",
		city: "Altier",
		lieuDit: null, // empty nom_ld cell
	})

	expect(recs[0]!.lat).toBeCloseTo(44.474983)
	expect(recs[1]).toMatchObject({ numero: "8", rep: "bis" }) // uppercase BIS folded
})

test("provider: FR-only, keys with the FR street locale, throws otherwise", () => {
	expect(supportedBANCountries()).toEqual(["fr"])
	expect(streetLocaleForBANCountry("FR")).toBe("fr")
	expect(() => streetLocaleForBANCountry("de")).toThrow(/Add it to BAN_COUNTRY_TO_STREET_LOCALE/)
})

// --- nom_ld (lieu-dit) — survey: .superpowers/sdd/deploc-world-survey.md, FR section ---

test("cleanLieuDit: passes through a clean, distinct lieu-dit name", () => {
	expect(cleanLieuDit("Le Bourg", "Altier")).toBe("Le Bourg")
	expect(cleanLieuDit("La Varenne Saint-Hilaire", "Saint-Maur-des-Fossés")).toBe("La Varenne Saint-Hilaire")
})

test("cleanLieuDit: null/empty/whitespace-only input", () => {
	expect(cleanLieuDit(undefined, "Altier")).toBeNull()
	expect(cleanLieuDit("", "Altier")).toBeNull()
	expect(cleanLieuDit("   ", "Altier")).toBeNull()
})

test("cleanLieuDit: drops the literal header-leak value", () => {
	expect(cleanLieuDit("lieudit_complement_nom", "Altier")).toBeNull()
})

test("cleanLieuDit: drops placeholder sentinels (_1, _23, …)", () => {
	expect(cleanLieuDit("_1", "Altier")).toBeNull()
	expect(cleanLieuDit("_23", "Altier")).toBeNull()
	// Not a placeholder — a real name that happens to start with an underscore-free digit run is untouched.
	expect(cleanLieuDit("Le Bourg", "Altier")).toBe("Le Bourg")
})

test("cleanLieuDit: drops the 'ancienne commune :' prefix bucket (deferred, not raw-labeled)", () => {
	expect(cleanLieuDit("ancienne commune : Yvias", "Altier")).toBeNull()
	expect(cleanLieuDit("Ancienne Commune: Yvias", "Altier")).toBeNull() // case/space-insensitive
})

test("cleanLieuDit: drops an exact (case-insensitive) duplicate of the commune", () => {
	expect(cleanLieuDit("Arles", "Arles")).toBeNull()
	expect(cleanLieuDit("ARLES", "Arles")).toBeNull()
	expect(cleanLieuDit("Arles", null)).toBe("Arles") // no commune to compare against — passes through
})

test("extract: surfaces a clean lieuDit and filters junk end-to-end", async () => {
	const path = await fixtureCSV([
		lieuDitRow("1", "Le Bourg"),
		lieuDitRow("2", "lieudit_complement_nom"), // header-leak
		lieuDitRow("3", "_1"), // placeholder
		lieuDitRow("4", "Altier", "Altier"), // exact dup of commune
		lieuDitRow("5", "ancienne commune : Yvias"), // deferred prefix bucket
	])

	const recs = []

	for await (const r of extractBANAddrPoints(path)) {
		recs.push(r)
	}

	expect(recs).toHaveLength(5)
	expect(recs.map((r) => r.lieuDit)).toEqual(["Le Bourg", null, null, null, null])
})
