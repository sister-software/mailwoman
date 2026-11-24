// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   The abbreviation Correos de México prints after the locality for each of the 32 federal entities.
 *
 *   The UPU sheet for Mexico (03/2017) states the postcode as `5 digits to left of locality name,
 *   followed by the province abbreviation`, prints `02860 MEXICO, CDMX` and `77520 CANCUN, Q. ROO`,
 *   and lists the abbreviations under `Province abbreviations`. This table copies that list.
 *   The sheet writes Quintana Roo as `Q ROO` in the list and `Q. ROO` in the example, and the
 *   list's form is kept.
 *
 * @see {@link https://www.upu.int/UPU/media/upu/PostalEntitiesFiles/addressingUnit/mexEn.pdf UPU Mexico postal address sheet (Correos de México)}
 */

import { foldName } from "#names/normalize"

/**
 * State name as the sheet lists it → the abbreviation it prints.
 */
const MX_STATE_POSTAL_ABBREVIATIONS: Readonly<Record<string, string>> = {
	Aguascalientes: "AGS",
	"Baja California": "BC",
	"Baja California Sur": "BCS",
	Campeche: "CAM",
	Coahuila: "COAH",
	Colima: "COL",
	Chiapas: "CHIS",
	Chihuahua: "CHIH",
	"Ciudad de México": "CDMX",
	Durango: "DGO",
	Guanajuato: "GTO",
	Guerrero: "GRO",
	Hidalgo: "HGO",
	Jalisco: "JAL",
	México: "MEX",
	Michoacán: "MICH",
	Morelos: "MOR",
	Nayarit: "NAY",
	"Nuevo León": "NL",
	Oaxaca: "OAX",
	Puebla: "PUE",
	Querétaro: "QRO",
	"Quintana Roo": "Q ROO",
	"San Luis Potosí": "SLP",
	Sinaloa: "SIN",
	Sonora: "SON",
	Tabasco: "TAB",
	Tamaulipas: "TAMPS",
	Tlaxcala: "TLAX",
	Veracruz: "VER",
	Yucatán: "YUC",
	Zacatecas: "ZAC",
}

/**
 * The full constitutional names of three states the sheet lists by their short names,
 * and the State of Mexico's long name, each mapped to the sheet's name.
 */
const MX_STATE_LONG_NAMES: Readonly<Record<string, string>> = {
	"Coahuila de Zaragoza": "Coahuila",
	"Estado de México": "México",
	"Michoacán de Ocampo": "Michoacán",
	"Veracruz de Ignacio de la Llave": "Veracruz",
}

/**
 * Folded name → abbreviation, over the sheet's names and the long names.
 */
const ABBREVIATION_BY_FOLDED_NAME: ReadonlyMap<string, string> = new Map([
	...Object.entries(MX_STATE_POSTAL_ABBREVIATIONS).map(
		([name, abbreviation]) => [foldName(name), abbreviation] as const
	),
	...Object.entries(MX_STATE_LONG_NAMES).map(
		([long, short]) => [foldName(long), MX_STATE_POSTAL_ABBREVIATIONS[short]!] as const
	),
])

/**
 * The abbreviation Correos de México prints for a Mexican state, matched ignoring case
 * and accents, or `null` for a name that isn't one of the 32 federal entities.
 */
export function mxStatePostalAbbreviation(name: string): string | null {
	return ABBREVIATION_BY_FOLDED_NAME.get(foldName(name)) ?? null
}
