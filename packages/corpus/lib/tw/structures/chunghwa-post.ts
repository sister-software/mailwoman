// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   Taiwan's entry in the structures layer: Chunghwa Post's list of its post offices
 *   (中華郵政全國營業據點, data.gov.tw dataset 5950), as `mailwoman corpus fetch tw-chunghwa-post-offices` writes it.
 *
 *   Each row holds the office's name (`臺北北門郵局`), its 5-digit and 6-digit postcodes,
 *   its 縣市 and 鄉鎮市區 in their own columns, the rest of its address (`忠孝西路一段120號1樓`)
 *   and a point. {@linkcode chunghwaPostAddress} splits the rest at its house number
 *   with `TW_HOUSE_NUMBER`, the pattern the GCIS register aligner reads: the street
 *   before it, the number with its 號, and a floor after it read by `TW_FLOOR`.
 *   A parenthesized note after the number (`(國立政治大學藝文中心內)`) names the building
 *   the office sits in and is left out.
 *
 *   Every office is filed under the post-office category, and the list is Chunghwa Post's
 *   own record of its counters, so its provenance is the postal operator's.
 *
 *   No corpus adapter reads this file.
 *   Taiwanese training rows are built by the CJK corpus builder (`#tw/corpus/assemble`),
 *   whose records are spanned by hand, and the codex's Taiwanese layout places no `subregion`
 *   and prints the venue after the address, so a rendered row would lose the district
 *   and the venue's tokens would align to `O`.
 *
 *   License: 政府資料開放授權條款－第1版 (Open Government Data License, Taiwan, v1.0), whose 第2條
 *   grants «重製、散布、公開傳輸、公開播送、公開口述、公開上映、公開演出、編輯、改作» for any purpose, and whose 第3條 voids
 *   the grant from the start when the attribution it prescribes is missing.
 */

import { stringifyJSON } from "@mailwoman/core/json"
import type { PathBuilder } from "path-ts"

import { readCSVRecords } from "#recipes/scaffold"
import {
	postOfficeCategoryID,
	StructureProvenance,
	type StructureRecord,
	type StructureSource,
	type StructureSourceRead,
} from "#structures/source"
import { readManifest } from "#tools/fetch/download"
import { TW_FLOOR, TW_HOUSE_NUMBER } from "#tw/registers"
import type { TWChunghwaPostManifest } from "#tw/tools/fetch/chunghwa-post"

/**
 * The source directory the fetcher writes.
 */
export const TW_CHUNGHWA_POST_SOURCE_ID = "tw-chunghwa-post-offices"

/**
 * The file the fetcher writes.
 */
export const TW_CHUNGHWA_POST_FILENAME = "post-offices.csv"

/**
 * The columns this module reads, in the publisher's spelling.
 */
export const TW_CHUNGHWA_POST_COLUMNS = [
	"電腦局號",
	"局名",
	"郵遞區號",
	"縣市",
	"鄉鎮市區",
	"地址",
	"經度",
	"緯度",
] as const

/**
 * One CSV row, keyed by the publisher's column names.
 */
export type TWChunghwaPostRow = Readonly<Record<string, string | undefined>>

/**
 * A parenthesized note after the house number: the building or campus the office sits in.
 */
const TRAILING_NOTE = /[（(][^）)]*[）)]$/u

/**
 * Several numbers an office spans, listed before one 號: `150、152、154號`, `235-1、235-2號`.
 *
 * The office stands at all of them, so the list is its house number.
 */
const NUMBER_LIST =
	/^(?<number>[0-9０-９]+(?:(?:之|[-－])[0-9０-９]+)?(?:、[0-9０-９]+(?:(?:之|[-－])[0-9０-９]+)?)+號)(?<rest>.*)$/u

/**
 * The street line of an office split into components, or `null` when no house number with
 * 號 follows a street, or something other than a floor or a note follows the number.
 */
export function chunghwaPostStreetLine(line: string): { street: string; house_number: string; unit?: string } | null {
	const characters = [...line.replaceAll(/\s+/gu, "")]

	for (let at = 1; at < characters.length; at++) {
		const tail = characters.slice(at).join("")
		const match = NUMBER_LIST.exec(tail) ?? TW_HOUSE_NUMBER.exec(tail)

		if (!match) continue

		const street = characters.slice(0, at).join("")

		// A street ending in a digit or a list mark ends inside a number or a list of numbers.
		if (/[0-9０-９、，,\-－]$/u.test(street)) continue

		const rest = match.groups!["rest"]!.replace(TRAILING_NOTE, "")

		if (rest && !TW_FLOOR.test(rest)) return null

		return { street, house_number: match.groups!["number"]!, ...(rest ? { unit: rest } : {}) }
	}

	return null
}

/**
 * An office's address as the components the parser labels, or `null` when its street line doesn't split.
 */
export function chunghwaPostAddress(row: TWChunghwaPostRow): StructureRecord["address"] {
	const line = chunghwaPostStreetLine(row["地址"]?.trim() ?? "")
	const postcode = row["郵遞區號"]?.trim()
	const region = row["縣市"]?.trim()
	const subregion = row["鄉鎮市區"]?.trim()

	if (!line || !region || !subregion) return null

	return { ...(postcode ? { postcode } : {}), region, subregion, ...line }
}

/**
 * One CSV row as a structure record, or `null` when it has no office number.
 */
export function chunghwaPostStructureRecord(row: TWChunghwaPostRow, category: string): StructureRecord | null {
	const id = row["電腦局號"]?.trim()

	if (!id) return null

	const latitude = Number(row["緯度"])
	const longitude = Number(row["經度"])

	return {
		id,
		name: row["局名"]?.trim() || null,
		category,
		point:
			Number.isFinite(latitude) && Number.isFinite(longitude) && latitude && longitude ? { latitude, longitude } : null,
		address: chunghwaPostAddress(row),
	}
}

async function* records(path: PathBuilder): AsyncIterable<StructureRecord> {
	const category = postOfficeCategoryID()

	for await (const row of readCSVRecords(path)) {
		const record = chunghwaPostStructureRecord(row as TWChunghwaPostRow, category)

		if (!record) throw new Error(`${path}: a row has no 電腦局號: ${stringifyJSON(row).slice(0, 200)}`)

		yield record
	}
}

const FETCH_COMMAND = "mailwoman corpus fetch tw-chunghwa-post-offices"

/**
 * Chunghwa Post's post offices.
 */
export const chunghwaPostStructures: StructureSource = {
	id: "chunghwa-post-offices",
	country: "TW",
	publisher: "中華郵政股份有限公司 (Chunghwa Post)",
	attribution: "中華郵政股份有限公司, 中華郵政全國營業據點 (data.gov.tw 5950), 政府資料開放授權條款－第1版",
	license: "OGDL-Taiwan-1.0",
	registerSource: "tw-postal-1",
	provenance: StructureProvenance.PostalOperator,
	fetchCommand: FETCH_COMMAND,

	async read(sourcesRoot): Promise<StructureSourceRead> {
		const directory = sourcesRoot(TW_CHUNGHWA_POST_SOURCE_ID)
		const manifest = await readManifest<TWChunghwaPostManifest>(directory("MANIFEST.json"))

		if (!manifest?.downloaded_at) {
			throw new Error(`${directory} holds no MANIFEST.json with a fetch date. Run \`${FETCH_COMMAND}\` first.`)
		}

		return {
			vintage: (manifest.publisher_version ?? manifest.downloaded_at).slice(0, 10),
			records: records(directory(TW_CHUNGHWA_POST_FILENAME)),
		}
	},
}
