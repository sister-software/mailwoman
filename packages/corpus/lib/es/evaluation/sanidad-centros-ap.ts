// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   `es-sanidad-centros-ap`: the Ministerio de Sanidad's catalogue of the national health system's
 *   primary-care centers (`Catálogo de Centros de Atención Primaria del SNS`), an evaluation-only source.
 *
 *   The ministry's microdata page (`https://www.sanidad.gob.es/estadisticas/microdatos.do`, type CatCentrosAP)
 *   serves the catalogue as one zip of semicolon-separated Windows-1252 text files without a header row.
 *   `SIAP_CENTROS.txt` holds one center per line: its id, the health area and basic zone,
 *   its type, its name, its code, its street line (`CALLE MAYOR, Nº 42`),
 *   its locality, its phone, whether it heads its zone, its municipality code
 *   (INE province and municipality plus a check digit), its postcode and its managing body.
 *
 *   The locality is the census settlement's name, written with its article
 *   after it in brackets (`REBOLLAR (EL)`).
 *   The reader moves the article in front (`EL REBOLLAR`), the order an address writes.
 *   A street line without a number (`S/N`) yields no record.
 *
 *   ## License
 *
 *   The ministry's legal notice (`https://www.sanidad.gob.es/avisoLegal/home.htm`)
 *   states that the site's information « es susceptible de reutilización; quedando
 *   autorizada su reproducción total o parcial, modificación, distribución y comunicación,
 *   para usos comerciales y no comerciales », on condition of citing the source
 *   and the date of the last update (`data/licenses/es-sanidad-aviso-legal.md`).
 */

import { readZipEntry } from "@mailwoman/core/fs/zip"
import type { PathBuilder } from "path-ts"
import { CSVSpliterator } from "spliterator"

import {
	type EvaluationAddressRecord,
	type EvaluationSource,
	evaluationStreetLine,
	fetchEvaluationFile,
	readEvaluationFetch,
} from "#evaluation/source"

/**
 * The catalogue as of 2026, the file the microdata page serves for the year 2025.
 */
export const ES_SANIDAD_CENTROS_AP_URL =
	"https://www.sanidad.gob.es/estadEstudios/estadisticas/microdatos/CatCentrosAP/2026_C__Catalogo_de_Centros_AP_txt.zip"

/**
 * The zip the fetch writes and the reader opens, under the publisher's own name.
 */
export const ES_SANIDAD_CENTROS_AP_FILENAME = "2026_C__Catalogo_de_Centros_AP_txt.zip"

/**
 * The zip member that lists the centers.
 * The other members are code tables.
 */
export const ES_SANIDAD_CENTROS_MEMBER = "SIAP_CENTROS.txt"

/**
 * The columns of `SIAP_CENTROS.txt` the reader takes, by position.
 */
const Column = { ID: 0, Street: 6, Locality: 7, Municipality: 10, Postcode: 11 } as const

/**
 * A settlement name whose article the census writes after it: `REBOLLAR (EL)`, `PALMAS (LAS)`.
 */
const TRAILING_ARTICLE = /^(.+?)\s*\(([^()]+)\)$/u

/**
 * The number marker between the street and its number: `CALLE MAYOR, Nº 42`.
 */
const NUMBER_MARKER = /,\s*(?:N[º°o]\.?|NUM\.?|NÚM\.?)\s*(?=\d)/iu

/**
 * The settlement name in address order.
 */
export function spanishSettlementName(name: string): string {
	const match = TRAILING_ARTICLE.exec(name)

	if (!match) return name

	const article = match[2]!.trim()
	// An apostrophe article (`L'`) joins its word without a space.
	const joiner = article.endsWith("'") ? "" : " "

	return `${article}${joiner}${match[1]!.trim()}`
}

/**
 * One catalogue line as an address record, or the reason it yields none.
 */
export function readSanidadCentre(columns: readonly string[]): EvaluationAddressRecord | { refused: string } {
	const cell = (index: number) => (columns[index] ?? "").replaceAll(/\s+/gu, " ").trim()

	const id = cell(Column.ID)
	const postcode = cell(Column.Postcode)
	const municipality = cell(Column.Municipality)
	const locality = spanishSettlementName(cell(Column.Locality))

	if (!id) return { refused: "row:identifier-absent" }

	if (!/^\d{5}$/u.test(postcode)) return { refused: "row:postcode-absent" }

	if (!locality) return { refused: "row:locality-absent" }

	if (!/^\d{5,6}$/u.test(municipality)) return { refused: "row:municipality-absent" }

	const street = evaluationStreetLine(cell(Column.Street).replace(NUMBER_MARKER, " "), "ES")

	if ("refused" in street) return street

	return {
		id,
		stratum: `province ${municipality.padStart(6, "0").slice(0, 2)}`,
		components: { street: street.street, house_number: street.house_number, postcode, locality },
	}
}

/**
 * Spain's evaluation-only source, the primary-care center catalogue.
 */
export const esSanidadCentrosAPSource: EvaluationSource = {
	id: "es-sanidad-centros-ap",
	country: "ES",
	publisher: "Ministerio de Sanidad",
	attribution: "Ministerio de Sanidad, Catálogo de Centros de Atención Primaria del SNS (2026)",
	license: "Aviso legal del Ministerio de Sanidad (reutilización autorizada)",
	registerSource: "es-health-1",

	fetch: (directory, report) =>
		fetchEvaluationFile(directory, ES_SANIDAD_CENTROS_AP_URL, ES_SANIDAD_CENTROS_AP_FILENAME, report),

	async read(directory: PathBuilder) {
		const fetched = await readEvaluationFetch(directory)
		const refused: Record<string, number> = {}
		const chunks: Uint8Array[] = []

		for await (const chunk of readZipEntry(directory(ES_SANIDAD_CENTROS_AP_FILENAME), ES_SANIDAD_CENTROS_MEMBER)) {
			chunks.push(chunk)
		}

		if (!chunks.length) throw new Error(`${ES_SANIDAD_CENTROS_AP_FILENAME} holds no ${ES_SANIDAD_CENTROS_MEMBER}`)

		const text = new TextDecoder("windows-1252").decode(Buffer.concat(chunks))

		async function* records(): AsyncGenerator<EvaluationAddressRecord> {
			for (const columns of CSVSpliterator.from<string[]>(text, { columnDelimiter: ";", header: false })) {
				const read = readSanidadCentre(columns)

				if ("refused" in read) {
					refused[read.refused] = (refused[read.refused] ?? 0) + 1

					continue
				}

				yield read
			}
		}

		return { vintage: `2026 catalogue (fetched ${fetched.downloaded_at.slice(0, 10)})`, records: records(), refused }
	},
}
