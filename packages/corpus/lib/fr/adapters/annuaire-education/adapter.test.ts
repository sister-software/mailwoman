/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { type TemporaryDirectory, temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { writeLocalFile } from "@mailwoman/core/fs/writers"
import { stringifyJSON } from "@mailwoman/core/json"
import type { PathBuilderLike } from "path-ts"
import { describe, expect, it } from "vitest"

import {
	type AnnuaireRecord,
	AnnuaireRefusal,
	AnnuaireTrim,
	createAnnuaireEducationAdapter,
	FR_ANNUAIRE_EDUCATION_ADAPTER_ID,
	FR_ANNUAIRE_EDUCATION_COUNTRIES,
	FR_ANNUAIRE_EDUCATION_LICENSE,
	readAnnuaireLine,
	readAnnuaireRecord,
} from "#fr/adapters/annuaire-education/adapter"
import { runAdapter } from "#runner"
import { readCanonicalRows, useScratchDir } from "#test-kit"

const scratch = useScratchDir("fr-annuaire-education-overseas")

/**
 * Thirteen of the 3,145 overseas records the export served on 2026-10-03,
 * keeping the nine fields the adapter reads with their published values.
 *
 * The export file's sha256 is `6e2da15f828bbbdaa4f08bebb325a777cb2193793384ec2972a38ec3aed665d7`.
 */
const RECORDS: readonly AnnuaireRecord[] = [
	{
		identifiant_de_l_etablissement: "9870034Y",
		nom_etablissement: "Circonscription d'inspection du 1er degré d'Uvea",
		adresse_1: "MATA UTU",
		adresse_2: "MATA UTU",
		adresse_3: "98600 UVEA",
		code_postal: "98600",
		nom_commune: "Uvea",
		code_departement: "986",
		etat: "OUVERT",
	},
	{
		identifiant_de_l_etablissement: "9870009W",
		nom_etablissement: "Ecole primaire privée de Kolopelu",
		adresse_1: "KOLOPELU  ALO",
		adresse_2: "ALO",
		adresse_3: "98610 ALO",
		code_postal: "98610",
		nom_commune: "Alo",
		code_departement: "986",
		etat: "OUVERT",
	},
	{
		identifiant_de_l_etablissement: "9710035L",
		nom_etablissement: "Lycée Mireille Choisy",
		adresse_1: "Gustavia",
		adresse_2: "BP 58",
		adresse_3: null,
		code_postal: "97098",
		nom_commune: "Saint-Barthélemy",
		code_departement: "977",
		etat: "OUVERT",
	},
	{
		identifiant_de_l_etablissement: "9711336A",
		nom_etablissement: "Ecole élémentaire privée hors contrat We Care SBH",
		adresse_1: "Chez Patricia R.Lédée_Grand Cul de Sac",
		adresse_2: "Grand Cul de Sac",
		adresse_3: "97133 ST BARTHELEMY",
		code_postal: "97133",
		nom_commune: "Saint-Barthélemy",
		code_departement: "977",
		etat: "OUVERT",
	},
	{
		identifiant_de_l_etablissement: "9840004G",
		nom_etablissement: "Vice-rectorat de la Polynésie Française",
		adresse_1: "25 avenue Pierre Loti",
		adresse_2: "BP 1632",
		adresse_3: "98713 PAPEETE",
		code_postal: "98713",
		nom_commune: "Papeete",
		code_departement: "987",
		etat: "OUVERT",
	},
	{
		identifiant_de_l_etablissement: "9830666G",
		nom_etablissement: "DIRECTION DE L'ENSEIGNEMENT DE LA NOUVELLE-CALEDONIE",
		adresse_1: "19 avenue Maréchal FOCH",
		adresse_2: "BP M2",
		adresse_3: "98849 NOUMEA CEDEX",
		code_postal: "98849",
		nom_commune: "Nouméa",
		code_departement: "988",
		etat: "OUVERT",
	},
	{
		identifiant_de_l_etablissement: "9710768H",
		nom_etablissement: "Ecole maternelle Eliane CLARKE",
		adresse_1: "Rue Rue Britain, Spring",
		adresse_2: "Quartier d'Orléans",
		adresse_3: "97150 ST MARTIN",
		code_postal: "97150",
		nom_commune: "Saint-Martin",
		code_departement: "978",
		etat: "OUVERT",
	},
	{
		identifiant_de_l_etablissement: "9830442N",
		nom_etablissement: "Antenne de Poindimié du Centre d'information et d'orientation de Nouméa",
		adresse_1: "Lycée de Poindimié",
		adresse_2: "BP 147",
		adresse_3: null,
		code_postal: "98822",
		nom_commune: "Poindimié",
		code_departement: "988",
		etat: "OUVERT",
	},
	{
		identifiant_de_l_etablissement: "9740659Y",
		nom_etablissement: "Ecole primaire publique Josée LEGER",
		adresse_1: "22 bis rue Gabriel Vayaboury",
		adresse_2: null,
		adresse_3: "97440 ST ANDRE",
		code_postal: "97440",
		nom_commune: "Saint-André",
		code_departement: "974",
		etat: "OUVERT",
	},
	{
		identifiant_de_l_etablissement: "9840104R",
		nom_etablissement: "Ecole primaire Amanu Tagiiereere",
		adresse_1: "ATOLL DE AMANU",
		adresse_2: "TG HAO (Amanu)",
		adresse_3: "98790 MANUHANGI",
		code_postal: "98790",
		nom_commune: "Hao",
		code_departement: "987",
		etat: "OUVERT",
	},
	{
		identifiant_de_l_etablissement: "9760301Y",
		nom_etablissement: "Ecole primaire publique Djabou Ahamadi",
		adresse_1: "1  Rue aloe vera",
		adresse_2: "TSOUNDZOU 2",
		adresse_3: "97600 MAMOUDZOU",
		code_postal: "97600",
		nom_commune: "Mamoudzou",
		code_departement: "976",
		etat: "OUVERT",
	},
	{
		identifiant_de_l_etablissement: "9760536D",
		nom_etablissement: "Ecole élémentaire publique Djabou Ahamadi",
		adresse_1: "1 rue aloe vera",
		adresse_2: "ALOE VERA",
		adresse_3: "97600 MAMOUDZOU",
		code_postal: "97600",
		nom_commune: "Mamoudzou",
		code_departement: "976",
		etat: "OUVERT",
	},
	{
		identifiant_de_l_etablissement: "9840027G",
		nom_etablissement: "Ecole primaire Hakamaii",
		adresse_1: "MARQ UA POU (Hakamaii)",
		adresse_2: "MARQ UA POU (Hakamaii)",
		adresse_3: "98746 HAAKUTI",
		code_postal: "98746",
		nom_commune: "Ua-pou",
		code_departement: "987",
		etat: "OUVERT",
	},
]

async function writeExport(directory: TemporaryDirectory): Promise<PathBuilderLike> {
	const path = directory.path("fr-en-annuaire-education-overseas.jsonl")

	await writeLocalFile(`${RECORDS.map((record) => stringifyJSON(record)).join("\n")}\n`, path)

	return path
}

function admitted(record: AnnuaireRecord) {
	const reading = readAnnuaireRecord(record)

	if (!("admitted" in reading)) throw new Error(`refused: ${reading.refused}`)

	return reading.admitted
}

describe("fr-annuaire-education-overseas adapter against thirteen export records", () => {
	it("emits ten rows and counts each refusal and each line left out", async () => {
		await using input = await temporaryDirectory("mailwoman-fr-annuaire-")
		const dropped = new Map<string, number>()

		const manifest = await runAdapter({
			adapter: createAnnuaireEducationAdapter(),
			adapterOptions: { inputPath: await writeExport(input), dropped },
			outputDir: scratch.path,
			corpusVersion: "0.1.0",
		})

		expect(Object.fromEntries(dropped)).toEqual({
			[AnnuaireRefusal.CareOfPerson]: 1,
			[AnnuaireRefusal.DigitUnplaced]: 1,
			[AnnuaireRefusal.DeliveryLineAbsent]: 1,
			[AnnuaireTrim.LinePremiseDescriptor]: 1,
			[AnnuaireTrim.ArchipelagoCode]: 1,
		})

		expect(manifest.yielded).toBe(10)

		const rows = await readCanonicalRows(scratch.path, FR_ANNUAIRE_EDUCATION_ADAPTER_ID)

		expect(rows.every((row) => row.license === FR_ANNUAIRE_EDUCATION_LICENSE)).toBe(true)
		expect(rows.every((row) => FR_ANNUAIRE_EDUCATION_COUNTRIES.includes(row.country))).toBe(true)
		expect(new Set(rows.map((row) => row.country))).toEqual(new Set(["WF", "BL", "PF", "NC", "MF", "RE", "YT"]))
	})

	it("honors limit and refuses a jurisdiction it does not publish", async () => {
		await using input = await temporaryDirectory("mailwoman-fr-annuaire-limit-")
		const inputPath = await writeExport(input)

		const limited = await runAdapter({
			adapter: createAnnuaireEducationAdapter(),
			adapterOptions: { inputPath, limit: 3 },
			outputDir: scratch.path,
			corpusVersion: "0.1.0",
		})

		expect(limited.yielded).toBe(3)

		const caledonian = await runAdapter({
			adapter: createAnnuaireEducationAdapter(),
			adapterOptions: { inputPath, country: "NC" },
			outputDir: scratch.path,
			corpusVersion: "0.1.0",
		})

		expect(caledonian.yielded).toBe(2)

		await expect(
			runAdapter({
				adapter: createAnnuaireEducationAdapter(),
				adapterOptions: { inputPath, country: "FR" },
				outputDir: scratch.path,
				corpusVersion: "0.1.0",
			})
		).rejects.toThrow(/fr-annuaire-education-overseas/)
	})
})

describe("readAnnuaireRecord", () => {
	it("reads a line with no street as the place the school stands in", () => {
		const row = admitted(RECORDS[0]!)

		expect(row.country).toBe("WF")
		expect(row.raw).toBe("Circonscription d'inspection du 1er degré d'Uvea, MATA UTU, 98600 UVEA")
		expect(row.components).toMatchObject({ dependent_locality: "MATA UTU", postcode: "98600", locality: "UVEA" })
	})

	it("falls back to the commune when the routing line is empty", () => {
		const row = admitted(RECORDS[2]!)

		expect(row.country).toBe("BL")
		expect(row.raw).toBe("Lycée Mireille Choisy, BP 58, Gustavia, 97098 Saint-Barthélemy")
	})

	it("keeps New Caledonia's lettered box and the CEDEX phrase", () => {
		const row = admitted(RECORDS[5]!)

		expect(row.components).toMatchObject({
			po_box: "BP M2",
			house_number: "19",
			street_prefix: "avenue",
			street: "Maréchal FOCH",
			locality: "NOUMEA",
			cedex: "CEDEX",
		})
	})

	it("reads a quarter under a street as the district", () => {
		const row = admitted(RECORDS[6]!)

		expect(row.country).toBe("MF")
		expect(row.components).toMatchObject({ street_prefix: "Rue", dependent_locality: "Quartier d'Orléans" })
	})

	it("keeps the repetition index with the number", () => {
		expect(admitted(RECORDS[8]!).components).toMatchObject({ house_number: "22 bis", street: "Gabriel Vayaboury" })
	})

	it("drops a complement that repeats the street's name", () => {
		expect(admitted(RECORDS[11]!).components.dependent_locality).toBeUndefined()
	})

	it("refuses an address written care of a person, and a numbered quarter it cannot place", () => {
		expect(readAnnuaireRecord(RECORDS[3]!)).toEqual({ refused: AnnuaireRefusal.CareOfPerson })
		expect(readAnnuaireRecord(RECORDS[10]!)).toEqual({ refused: AnnuaireRefusal.DigitUnplaced })
	})

	it("refuses a metropolitan or closed record", () => {
		expect(readAnnuaireRecord({ ...RECORDS[8]!, code_departement: "075" })).toEqual({
			refused: AnnuaireRefusal.NotOverseas,
		})

		expect(readAnnuaireRecord({ ...RECORDS[8]!, etat: "FERME" })).toEqual({ refused: AnnuaireRefusal.NotOpen })
	})
})

describe("readAnnuaireLine", () => {
	it("tells a street, a place, a building and an archipelago code apart", () => {
		expect(readAnnuaireLine("5 rue Maréchal Leclerc")).toEqual({
			kind: "street",
			house_number: "5",
			street_prefix: "rue",
			street: "Maréchal Leclerc",
		})

		expect(readAnnuaireLine("Lieu-dit NETCHAOT")).toEqual({ kind: "place", place: "NETCHAOT" })
		expect(readAnnuaireLine("Bourg")).toEqual({ kind: "place", place: "Bourg" })
		expect(readAnnuaireLine("ENCEINTE ECOLE DE TIAPA")).toEqual({ kind: "premise" })
		expect(readAnnuaireLine("IDV TAHITI (Papeete)")).toEqual({ kind: "archipelago" })
	})

	it("refuses a kilometer point and a type word with no name", () => {
		expect(readAnnuaireLine("PK 4 APOOITI UTUROA RAIATEA")).toEqual({
			kind: "refused",
			reason: AnnuaireRefusal.DigitUnplaced,
		})

		expect(readAnnuaireLine("0 route")).toEqual({ kind: "refused", reason: AnnuaireRefusal.StreetNameAbsent })
	})
})
