// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   `it-miur-scuole`: the Ministero dell'Istruzione e del Merito's register of state schools
 *   (`Anagrafe scuole statali`, dataset `DS0400SCUANAGRAFESTAT` on dati.istruzione.it), read by the
 *   evaluation source and by the `it-miur-scuole` corpus adapter through {@linkcode readMIURSchools}.
 *
 *   Each row is one school site with its region, province, street line (`INDIRIZZOSCUOLA`,
 *   `VIA COLLE DEI FRATI 5/5A`), postcode (`CAPSCUOLA`) and comune (`DESCRIZIONECOMUNE`).
 *   The ministry writes every value in capitals, and the rows keep them.
 *
 *   The schools' addresses are the ministry's record of its own sites.
 *   A record holds the address and never the school's name.
 *
 *   ## License
 *
 *   The catalogue page states `License: IODL 2.0` for the dataset,
 *   linking `http://www.dati.gov.it/iodl/2.0/`.
 *   The license text (`https://www.dati.gov.it/content/italian-open-data-license-v20`) grants the
 *   right to « estrarre e reimpiegare le Informazioni » and to « creare un Lavoro derivato »,
 *   which it defines as « ogni traduzione, adattamento, trasformazione, diversa disposizione
 *   ed ogni altra modifica delle Informazioni » (`data/licenses/it-miur-iodl-2.0.md`).
 */

import type { PathBuilder, PathBuilderLike } from "path-ts"
import { CSVSpliterator } from "spliterator"

import {
	type EvaluationRecordReading,
	type EvaluationSource,
	evaluationSourceRead,
	evaluationStreetLine,
	fetchEvaluationFile,
	readEvaluationFetch,
} from "#evaluation/source"

/**
 * The register's file for school year 2026/27, as of 2026-09-01.
 */
export const IT_MIUR_SCUOLE_URL =
	"https://dati.istruzione.it/opendata/opendata/catalogo/elements1/SCUANAGRAFESTAT20262720260901.csv"

/**
 * The file the fetch writes and the reader reads, under the publisher's own name.
 */
export const IT_MIUR_SCUOLE_FILENAME = "SCUANAGRAFESTAT20262720260901.csv"

interface MIURSchoolRow {
	annoscolastico?: string
	regione?: string
	codicescuola?: string
	indirizzoscuola?: string
	capscuola?: string
	descrizionecomune?: string
}

/**
 * The register's placeholder for an absent value.
 */
const NOT_AVAILABLE = /^non disponibile$/iu

function value(text: string | undefined): string {
	const trimmed = (text ?? "").replaceAll(/\s+/gu, " ").trim()

	return NOT_AVAILABLE.test(trimmed) ? "" : trimmed
}

/**
 * One register row as an address record, or the reason it yields none.
 */
export function readMIURSchool(row: MIURSchoolRow): EvaluationRecordReading {
	const id = value(row.codicescuola)
	const postcode = value(row.capscuola)
	const locality = value(row.descrizionecomune)
	const region = value(row.regione)

	if (!id) return { refused: "row:identifier-absent" }

	if (!/^\d{5}$/u.test(postcode)) return { refused: "row:postcode-absent" }

	if (!locality) return { refused: "row:locality-absent" }

	const street = evaluationStreetLine(value(row.indirizzoscuola), "IT")

	if ("refused" in street) return street

	return {
		id,
		stratum: region || "unstated",
		components: { street: street.street, house_number: street.house_number, postcode, locality },
	}
}

/**
 * Italy's evaluation source, the state-school register.
 */
export const itMIURScuoleSource: EvaluationSource = {
	id: "it-miur-scuole",
	country: "IT",
	publisher: "Ministero dell'Istruzione e del Merito",
	attribution: "Ministero dell'Istruzione e del Merito, Anagrafe scuole statali, dati.istruzione.it, IODL 2.0",
	license: "Italian Open Data License 2.0",
	registerSource: "it-education-1",

	fetch: (directory, report) => fetchEvaluationFile(directory, IT_MIUR_SCUOLE_URL, IT_MIUR_SCUOLE_FILENAME, report),

	async read(directory: PathBuilder) {
		const fetched = await readEvaluationFetch(directory)

		return evaluationSourceRead(
			`2026/27 (fetched ${fetched.downloaded_at.slice(0, 10)})`,
			readMIURSchools(directory(IT_MIUR_SCUOLE_FILENAME))
		)
	},
}

/**
 * Every row of the register CSV at `path`, read by {@linkcode readMIURSchool}.
 */
export async function* readMIURSchools(path: PathBuilderLike): AsyncGenerator<EvaluationRecordReading> {
	for await (const row of CSVSpliterator.fromAsync<MIURSchoolRow>(path, { normalizeKeys: true })) {
		yield readMIURSchool(row)
	}
}
