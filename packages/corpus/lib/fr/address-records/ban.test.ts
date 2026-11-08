// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { writeLocalTextFile } from "@mailwoman/core/fs/writers"
import { describe, expect, it } from "vitest"

import { arrondissementCity, BAN_ADDRESS_SOURCE, readBANAddressRecords } from "#fr/address-records/ban"
import { useScratchDir } from "#test-kit"

const scratch = useScratchDir("address-records-ban")

const HEADER =
	"id;id_fantoir;numero;rep;nom_voie;code_postal;code_insee;nom_commune;code_insee_ancienne_commune;nom_ancienne_commune;x;y;lon;lat;type_position;alias;nom_ld;libelle_acheminement;nom_afnor;source_position;source_nom_voie;certification_commune;cad_parcelles"

/**
 * Ten BAN rows: a Paris arrondissement, a `bis` number, a Guadeloupe commune,
 * a merged commune's former name, a lieu-dit, a Lyon arrondissement, a row without an id,
 * and three the extract or the record refuses.
 */
const ROWS = [
	"75103_ka7f7y_00001;;1;;Voie B/3;75003;75103;Paris 3e Arrondissement;;;652996.66;6862232.89;2.359369;48.858416;parcelle;;;PARIS;VOIE B 3;commune;commune;1;",
	"75103_ka7f7y_00002;;8;bis;Rue de Turenne;75003;75103;Paris 3e Arrondissement;;;0;0;2.364;48.859;entrée;;;PARIS;RUE DE TURENNE;commune;commune;1;",
	"97104_zpv4wb_00001;;1;;Ruelle des Pommes Cannelles;97123;97104;Baillif;;;0;0;-61.743132;16.020763;segment;;;BAILLIF;RUELLE DES POMMES CANNELLES;inconnue;inconnue;0;",
	"49092_ab12cd_00010;;10;;Rue du Lavoir;49120;49092;Chemillé-en-Anjou;49218;Saint-Lézin;0;0;-0.73;47.21;entrée;;;CHEMILLE EN ANJOU;RUE DU LAVOIR;commune;commune;1;",
	"48095_xy12zz_00003;;3;;Route de la Croix;48000;48095;Mende;;;0;0;3.50;44.52;entrée;;Le Chapitre;MENDE;ROUTE DE LA CROIX;commune;commune;1;",
	"69381_qq12rr_00005;;5;;Rue de la République;69001;69381;Lyon 1er Arrondissement;;;0;0;4.835;45.767;entrée;;;LYON;RUE DE LA REPUBLIQUE;commune;commune;1;",
	";;12;;Rue Haute;48000;48095;Mende;;;0;0;3.51;44.53;entrée;;;MENDE;RUE HAUTE;commune;commune;1;",
	"48095_xy12zz_00004;;;;Rue Basse;48000;48095;Mende;;;0;0;3.51;44.53;entrée;;;MENDE;RUE BASSE;commune;commune;1;",
	"48095_xy12zz_00005;;4;;;48000;48095;Mende;;;0;0;3.51;44.53;entrée;;;MENDE;;commune;commune;1;",
	"48095_xy12zz_00006;;6;;Rue Neuve;48000;48095;Mende;;;0;0;;;entrée;;;MENDE;RUE NEUVE;commune;commune;1;",
]

async function records() {
	const csv = scratch.path("adresses-test.csv")

	await writeLocalTextFile(`${[HEADER, ...ROWS].join("\n")}\n`, csv)

	return Array.fromAsync(readBANAddressRecords(csv))
}

describe("BAN address records", () => {
	it("reads the city an arrondissement belongs to", () => {
		expect(arrondissementCity("Paris 3e Arrondissement")).toBe("Paris")
		expect(arrondissementCity("Lyon 1er Arrondissement")).toBe("Lyon")
		expect(arrondissementCity("Mende")).toBeNull()
	})

	it("emits seven of ten rows under the BAN source id", async () => {
		const all = await records()

		expect(all).toHaveLength(7)
		expect(all.every((record) => record.source === BAN_ADDRESS_SOURCE)).toBe(true)
	})

	it("states an arrondissement, its city and the postal city as localities, with the INSEE code", async () => {
		const [paris] = await records()

		expect(paris).toMatchObject({
			sourceRecordID: "75103_ka7f7y_00001",
			adminCode: "75103",
			country: "FR",
			subdivision: "FR-IDF",
		})

		expect(paris!.names.map(({ level, form, value }) => `${level}:${form}:${value}`)).toEqual([
			"locality:written:Paris 3e Arrondissement",
			"locality:bare:Paris",
		])
	})

	it("keys a repetition suffix into the number, and places a Guadeloupe commune in GP", async () => {
		const all = await records()

		expect(all[1]!.number).toBe("8 bis")
		expect(all[2]).toMatchObject({ country: "GP", subdivision: null, adminCode: "97104", placement: "segment" })
	})

	it("keeps a merged commune's former name and a lieu-dit, and digests a row without an id", async () => {
		const all = await records()
		const merged = all.find((record) => record.adminCode === "49092")
		const lieuDit = all.find((record) => record.number === "3")
		const unnamed = all.find((record) => record.number === "12")

		// La Poste's routing name keys apart from the commune's accented, hyphenated spelling, so both are kept.
		expect(merged!.names.map((name) => `${name.form}:${name.value}`)).toEqual([
			"written:Chemillé-en-Anjou",
			"postal:CHEMILLE EN ANJOU",
			"written:Saint-Lézin",
		])

		expect(lieuDit!.names.find((name) => name.level === "dependent_locality")?.value).toBe("Le Chapitre")
		expect(unnamed!.sourceRecordID).toMatch(/^digest:[0-9a-f]{12}$/u)
	})
})
