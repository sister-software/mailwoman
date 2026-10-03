/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { type TemporaryDirectory, temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { writeLocalFile } from "@mailwoman/core/fs/writers"
import type { PathBuilderLike } from "path-ts"
import { describe, expect, it } from "vitest"

import {
	createFinessAdapter,
	FinessRefusal,
	FinessTrim,
	finessCountry,
	FR_FINESS_ADAPTER_ID,
	FR_FINESS_LICENSE,
	readFinessRecord,
} from "#fr/adapters/finess/adapter"
import { runAdapter } from "#runner"
import { readCanonicalRows, useScratchDir } from "#test-kit"

const scratch = useScratchDir("fr-finess-overseas")

/**
 * Fifteen lines of the 103,023 in `etalab-cs1100502-stock-20260512-0339.csv`,
 * copied verbatim: the comment line, one metropolitan establishment, and thirteen
 * overseas establishments chosen to exercise one reading each.
 *
 * The source file's sha256 is `9fc18a2103cc94c66b00ab9e2cee6d33f28c7b8522ec8975288c954e3d8535c2`.
 */
const EXTRACT_LINES = [
	"finess;etalab;111;2026-05-12",
	"structureet;010000024;010780054;CH DE FLEYRIAT;CENTRE HOSPITALIER DE BOURG-EN-BRESSE FLEYRIAT;;;900;RTE;DE PARIS;;;451;01;AIN;01440 VIRIAT;0474454647;0474454114;355;Centre Hospitalier (C.H.);1102;Centres Hospitaliers;26010004500012;8610Z;03;ARS établissements Publics de santé dotation globale;1;Etablissement public de santé;1979-02-13;1979-02-13;2020-02-04;",
	"structureet;970102018;970113015;PMI SAINT BARTHELEMY;PMI SAINT BARTHELEMY;PMI CMS DE GUSTAVIA;;4;R;AUGUST NYMAN;;;123;9A;GUADELOUPE;97133 ST BARTHELEMY;0590276027;;223;Protection Maternelle et Infantile (P.M.I.);2202;Etablissements de PMI et de Planification Familiale;;;01;Etablissement Tarif Libre;;;1964-01-01;1964-01-01;2019-02-15;",
	"structureet;970100400;970100186;C.H. LOUIS CONSTANT FLEMING;CENTRE HOSPITALIER LOUIS CONSTANT FLEMING;CH LOUIS CONSTANT FLEMING;;;;;;BP 381;127;9A;GUADELOUPE;97150 ST MARTIN;0590522525;0590522630;355;Centre Hospitalier (C.H.);1102;Centres Hospitaliers;26971036400028;;03;ARS établissements Publics de santé dotation globale;1;Etablissement public de santé;1951-01-01;1951-01-01;2024-04-08;",
	"structureet;970102059;970112611;CLASS DE MARIGOT;CLASS DE MARIGOT;;;;;;;;127;9A;GUADELOUPE;97150 ST MARTIN;0590875093;;223;Protection Maternelle et Infantile (P.M.I.);2202;Etablissements de PMI et de Planification Familiale;;;01;Etablissement Tarif Libre;;;1964-01-01;1964-01-01;2016-09-09;",
	"structureet;970210126;970210118;CMPP  INTERSECTORIEL ALOES;CMPP INTERSECTORIEL;;;;;ZAC CHAMPIGNY;;BP 71 IMMEUBLE SEMAFA;207;9B;MARTINIQUE;97224 DUCOS;0596748677;0596748631;189;Centre Médico-Psycho-Pédagogique (C.M.P.P.);4106;Services à Domicile ou Ambulatoires pour Handicapés;50254756500015;;57;DGS ARS & hébergement PCD - sous CPOM;;;2008-04-14;2007-11-14;2017-02-21;",
	"structureet;970300026;970302022;CENTRE HOSPITALIER DE CAYENNE;CENTRE HOSPITALIER  DE CAYENNE;;;;AV;ALEXIS BLAISE;;BP 6006;302;9C;GUYANE;97306 CAYENNE CEDEX;0594395050;0594305250;355;Centre Hospitalier (C.H.);1102;Centres Hospitaliers;26973302800022;;03;ARS établissements Publics de santé dotation globale;1;Etablissement public de santé;1904-04-04;1998-04-29;2024-04-22;",
	"structureet;970400024;970408589;CHU SITE FELIX GUYON (SAINT DENIS);CHU SITE FELIX GUYON (SAINT DENIS);;;;ALL;DES TOPAZES;;CS 11021;411;9D;LA REUNION;97405 ST DENIS CEDEX;0262905050;0262905051;101;Centre Hospitalier Régional (C.H.R.);1101;Centres Hospitaliers Régionaux;20003001300011;8610Z;03;ARS établissements Publics de santé dotation globale;1;Etablissement public de santé;1957-07-01;1957-07-01;2023-11-13;",
	"structureet;970405767;970400149;CENTRE EDUCATIF FERME JULES PALANT;CENTRE EDUCATIF FERME JULES PALANT (STE ANNE);;;40;CHE;CHEMIN SAFER MORANGE;;;410;9D;LA REUNION;97437 ST BENOIT;0262508105;0262508505;241;Etablissement de Placement;4502;Etab.et Services du Ministère de la Justice pour Mineurs;31822647900117;;99;Indéterminé;;;2007-05-25;2005-06-02;2007-09-03;",
	"structureet;970409645;970463600;UAD (LA POSSESSION)-ASDR;UNITE AUTODIALYSE (LA POSSESSION)-ASDR;;;1;R;RAYMOND BARRE;C;ZAC MOULIN JOLI;408;9D;LA REUNION;97419 LA POSSESSION;0262202820;0262285269;146;Structure d'Alternative à la dialyse en centre;1203;Dialyse Ambulatoire;37875112700101;;07;ARS établissements de santé non financés dotation globale;0;Non concerné;2016-09-15;2014-03-31;2023-10-26;",
	'structureet;980501506;980501498;"LIEU DE VIE ""MAVOUNA MEMA 1""";"LIEU DE VIE ET D\'ACCUEIL ""MAVOUNA MEMA 1""";ASSOCIATION MESSO;;12;R;ANCIEN TERRAIN DE FOOT;;;606;9F;MAYOTTE;97620 CHIRONGUI;0269666815;;462;Lieux de Vie et d\'Accueil;4605;Etablissements et services multi-clientèles;82967998400015;;08;Président du Conseil Départemental;;;2019-04-01;2019-03-18;2025-05-07;',
	"structureet;980502199;980502181;UBIPHARM-MAYOTTE;;;;;ZI;VALLÉE 3 BP 208;;;610;9F;MAYOTTE;97600 KOUNGOU;0269665008;;699;Entité Ayant Autorisation;1205;Autres Etablissements Relevant de la Loi Hospitalière;;4646Z;99;Indéterminé;0;Non concerné;2020-09-01;2018-10-01;2021-12-09;",
	"structureet;980600027;980600019;HOPITAL DE SIA;;;;;;;;BP 4 - MATA'UTU;613;9J;WALLIS ET FUTUNA;98600 UVEA;;;355;Centre Hospitalier (C.H.);1102;Centres Hospitaliers;13000323900014;;99;Indéterminé;1;Etablissement public de santé;2024-10-30;2024-10-30;2024-10-30;",
	"structureet;970302287;970302022;E.H.P.A.D. EDMAR LAMA DE CAYENNE;E.H.P.A.D. DU CENTRE HOSPITALIER DE CAYENNE;;;;AV;ALEXIS BLAISE;;BP 6006;302;9C;GUYANE;97306 CAYENNE CEDEX;0594395050;0594305150;500;Etablissement d'hébergement pour personnes âgées dépendantes;4401;Etablissements d'Hébergement pour Personnes Âgées;;8710A;40;ARS/PCD, Tarif global, habilité aide sociale, recours PUI;;;1988-05-02;2017-01-03;2024-04-22;",
	"structureet;970216057;590799730;ALEFPA S.M.J.P.M;;CITE BON AIR;ROUTE DES RELIGIEUSES;;;;;;209;9B;MARTINIQUE;97200 FORT DE FRANCE;0596712806;0596705342;340;Service mandataire judiciaire à la protection des majeurs;4608;Protection des majeurs;;;99;Indéterminé;;;2025-04-15;2025-04-01;2026-04-21;",
]

async function writeExtract(directory: TemporaryDirectory): Promise<PathBuilderLike> {
	const path = directory.path("etalab-cs1100502-stock-20260512-0339.csv")

	await writeLocalFile(`${EXTRACT_LINES.join("\n")}\n`, path)

	return path
}

function cellsOf(line: string): string[] {
	return line.split(";")
}

describe("fr-finess-overseas adapter against fifteen extract lines", () => {
	it("emits the overseas establishments and counts each refusal under its reason", async () => {
		await using input = await temporaryDirectory("mailwoman-fr-finess-")
		const dropped = new Map<string, number>()

		const manifest = await runAdapter({
			adapter: createFinessAdapter(),
			adapterOptions: { inputPath: await writeExtract(input), dropped },
			outputDir: scratch.path,
			corpusVersion: "0.1.0",
		})

		// Fifteen lines: the comment, one metropolitan row, five overseas refusals
		// (a lieu de vie, the ambiguous `C` index, a box inside the street name,
		// and two establishments with no street, lieu-dit or box), and eight rows.
		// The CMPP's `IMMEUBLE SEMAFA` is left out of its row.
		expect(Object.fromEntries(dropped)).toEqual({
			[FinessRefusal.NotEstablishment]: 1,
			[FinessRefusal.NotOverseas]: 1,
			[FinessRefusal.FamilyPlacement]: 1,
			[FinessRefusal.RepetitionIndexAmbiguous]: 1,
			[FinessRefusal.StreetDigitUnplaced]: 1,
			[FinessRefusal.DeliveryLineAbsent]: 2,
			[FinessTrim.LieuDitPremiseDescriptor]: 1,
		})

		expect(manifest.yielded).toBe(8)

		const rows = await readCanonicalRows(scratch.path, FR_FINESS_ADAPTER_ID)

		expect(rows.every((row) => row.license === FR_FINESS_LICENSE)).toBe(true)
		expect(rows.every((row) => row.locale === `fr-${row.country}`)).toBe(true)
		expect(rows.map((row) => row.country).toSorted()).toEqual(["BL", "GF", "GF", "MF", "MQ", "RE", "RE", "WF"])
	})

	it("reads a directory for the newest extract in it", async () => {
		await using input = await temporaryDirectory("mailwoman-fr-finess-dir-")

		await writeExtract(input)

		const manifest = await runAdapter({
			adapter: createFinessAdapter(),
			adapterOptions: { inputPath: input.path, country: "WF" },
			outputDir: scratch.path,
			corpusVersion: "0.1.0",
		})

		expect(manifest.yielded).toBe(1)
	})

	it("honors limit and refuses a jurisdiction it does not publish", async () => {
		await using input = await temporaryDirectory("mailwoman-fr-finess-limit-")
		const inputPath = await writeExtract(input)

		const limited = await runAdapter({
			adapter: createFinessAdapter(),
			adapterOptions: { inputPath, limit: 2 },
			outputDir: scratch.path,
			corpusVersion: "0.1.0",
		})

		expect(limited.yielded).toBe(2)

		await expect(
			runAdapter({
				adapter: createFinessAdapter(),
				adapterOptions: { inputPath, country: "FR" },
				outputDir: scratch.path,
				corpusVersion: "0.1.0",
			})
		).rejects.toThrow(/fr-finess-overseas/)
	})
})

describe("readFinessRecord", () => {
	function admitted(line: string) {
		const reading = readFinessRecord(cellsOf(line))

		if (!("admitted" in reading)) throw new Error(`refused: ${reading.refused}`)

		return reading.admitted
	}

	it("writes the expanded street type before the name and keeps the routing locality", () => {
		const row = admitted(EXTRACT_LINES[2]!)

		expect(row.country).toBe("BL")
		expect(row.raw).toBe("PMI SAINT BARTHELEMY, 4 RUE AUGUST NYMAN, 97133 ST BARTHELEMY")
		expect(row.components).toMatchObject({ house_number: "4", street_prefix: "RUE", street: "AUGUST NYMAN" })
	})

	it("assigns Saint-Martin's postcode under the Guadeloupe code to MF", () => {
		const row = admitted(EXTRACT_LINES[3]!)

		expect(row.country).toBe("MF")
		expect(row.raw).toBe("CENTRE HOSPITALIER LOUIS CONSTANT FLEMING, BP 381, 97150 ST MARTIN")
	})

	it("splits a CEDEX routing line and keeps the box", () => {
		const row = admitted(EXTRACT_LINES[6]!)

		expect(row.components).toMatchObject({
			po_box: "BP 6006",
			street_prefix: "AVENUE",
			street: "ALEXIS BLAISE",
			postcode: "97306",
			locality: "CAYENNE",
			cedex: "CEDEX",
		})
	})

	it("does not write a street type the name already opens with", () => {
		const row = admitted(EXTRACT_LINES[8]!)

		expect(row.components).toMatchObject({ house_number: "40", street_prefix: "CHEMIN", street: "SAFER MORANGE" })
	})

	it("reads Wallis-et-Futuna's box and lieu-dit from one line", () => {
		const row = admitted(EXTRACT_LINES[12]!)

		expect(row.country).toBe("WF")
		expect(row.components).toMatchObject({ po_box: "BP 4", dependent_locality: "MATA'UTU", locality: "UVEA" })
	})

	it("leaves a building out of the lieu-dit and reports it", () => {
		const reading = readFinessRecord(cellsOf(EXTRACT_LINES[5]!))

		expect("admitted" in reading && reading.trimmed).toEqual([FinessTrim.LieuDitPremiseDescriptor])
		expect("admitted" in reading && reading.admitted.components.dependent_locality).toBeUndefined()
	})

	it("refuses a lieu de vie, whose address can be its staff's home", () => {
		const cells = [
			"structureet",
			"980501506",
			"980501498",
			'LIEU DE VIE "MAVOUNA MEMA 1"',
			'LIEU DE VIE ET D\'ACCUEIL "MAVOUNA MEMA 1"',
			"ASSOCIATION MESSO",
			"",
			"12",
			"R",
			"ANCIEN TERRAIN DE FOOT",
			"",
			"",
			"606",
			"9F",
			"MAYOTTE",
			"97620 CHIRONGUI",
			"0269666815",
			"",
			"462",
		]

		expect(readFinessRecord(cells)).toEqual({ refused: FinessRefusal.FamilyPlacement })
	})

	it("refuses the C index and a street name holding a box", () => {
		expect(readFinessRecord(cellsOf(EXTRACT_LINES[9]!))).toEqual({
			refused: FinessRefusal.RepetitionIndexAmbiguous,
		})

		expect(readFinessRecord(cellsOf(EXTRACT_LINES[11]!))).toEqual({ refused: FinessRefusal.StreetDigitUnplaced })
	})
})

describe("finessCountry", () => {
	it("reads the departement code, and the postcode under 9A", () => {
		expect(finessCountry("9A", "97100")).toBe("GP")
		expect(finessCountry("9A", "97133")).toBe("BL")
		expect(finessCountry("9A", "97150")).toBe("MF")
		expect(finessCountry("9D", "97743")).toBe("RE")
		expect(finessCountry("9J", "98600")).toBe("WF")
		expect(finessCountry("75", "75013")).toBeNull()
	})
})
