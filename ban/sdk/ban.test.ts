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

import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { expect, test } from "vitest"

import { extractBANAddrPoints } from "./extract.js"
import { streetLocaleForBANCountry, supportedBANCountries } from "./street-locale.js"

const HEADER =
	"id;id_fantoir;numero;rep;nom_voie;code_postal;code_insee;nom_commune;code_insee_ancienne_commune;nom_ancienne_commune;x;y;lon;lat;type_position;alias;nom_ld;libelle_acheminement;nom_afnor;source_position;source_nom_voie;certification_commune;cad_parcelles"

function fixtureCSV(rows: string[]): string {
	const dir = mkdtempSync(join(tmpdir(), "ban-test-"))
	const path = join(dir, "adresses-48.csv")
	writeFileSync(path, [HEADER, ...rows].join("\n") + "\n")

	return path
}

test("extract: yields the full tuple, folds rep to lower-case, skips coordinate-less rows", async () => {
	const path = fixtureCSV([
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
	})
	expect(recs[0]!.lat).toBeCloseTo(44.474983)
	expect(recs[1]).toMatchObject({ numero: "8", rep: "bis" }) // uppercase BIS folded
})

test("provider: FR-only, keys with the FR street locale, throws otherwise", () => {
	expect(supportedBANCountries()).toEqual(["fr"])
	expect(streetLocaleForBANCountry("FR")).toBe("fr")
	expect(() => streetLocaleForBANCountry("de")).toThrow(/No BAN street-normalization locale/)
})
