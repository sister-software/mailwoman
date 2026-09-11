/**
 * @copyright Sister Software
 */

import { isAuPostcode, isAuStateAbbreviation } from "@mailwoman/codex/au"
import { isNZPostcode } from "@mailwoman/codex/nz"
import { dataRootPath } from "@mailwoman/core/data-root"
import { pathExists } from "@mailwoman/core/fs/readers"
import { readZipEntry } from "@mailwoman/core/fs/zip"
import type { PathBuilderLike } from "path-ts"
import { TextSpliterator, TSVSpliterator } from "spliterator"

import type { AUTuple, FRTuple, NZTuple, USTuple } from "#recipes/po/box/cedex/types"
import { readCSVRecords, readZippedCSVRecords } from "#recipes/scaffold"

/**
 * Non-Vermont OpenAddresses files used for training rows.
 */
export const US_TRAIN_SOURCES = [
	{ zip: dataRootPath("oa-cache", "us__ca__berkeley.zip"), csv: "us/ca/berkeley.csv", region: "CA" },
	{ zip: dataRootPath("oa-cache", "us__ca__marin.zip"), csv: "us/ca/marin.csv", region: "CA" },
	{ zip: dataRootPath("oa-cache", "us__dc__statewide.zip"), csv: "us/dc/statewide.csv", region: "DC" },
	{ zip: dataRootPath("oa-cache", "us__ia__statewide.zip"), csv: "us/ia/statewide.csv", region: "IA" },
	{ zip: dataRootPath("oa-cache", "us__il__cook.zip"), csv: "us/il/cook.csv", region: "IL" },
	{ zip: dataRootPath("oa-cache", "us__mt__statewide.zip"), csv: "us/mt/statewide.csv", region: "MT" },
	{ zip: dataRootPath("oa-cache", "us__sd__statewide.zip"), csv: "us/sd/statewide.csv", region: "SD" },
]

/**
 * Vermont OpenAddresses file reserved for golden rows.
 */
export const US_EVAL_SOURCE = {
	zip: dataRootPath("oa-cache", "us__vt__statewide.zip"),
	csv: "us/vt/statewide.csv",
	region: "VT",
}

/**
 * Countrywide French OpenAddresses source.
 */
export const FR_SOURCE = { zip: dataRootPath("oa-cache", "fr__countrywide.zip"), csv: "fr/countrywide.csv" }
/**
 * GeoNames Canada feature dump.
 */
export const GEONAMES_CA = dataRootPath("geonames", "CA.zip")
/**
 * GeoNames Australian postal-code dump.
 */
export const GEONAMES_POSTAL_AU = { zip: dataRootPath("geonames-postal", "AU.zip"), txt: "AU.txt" }
/**
 * GeoNames New Zealand postal-code dump.
 */
export const GEONAMES_POSTAL_NZ = { zip: dataRootPath("geonames-postal", "NZ.zip"), txt: "NZ.txt" }

const MAX_LOCALITY_LENGTH = 40
const FR_STRIDE = 211
const FR_STRIDE_OFFSET = 3
const CA_LOCALITY_MIN_POPULATION = 1000

export const localityHash = (name: string): number => {
	let hash = 5381

	for (const character of name.toLowerCase()) {
		hash = ((hash << 5) + hash + character.charCodeAt(0)) >>> 0
	}

	return hash
}

export const isHoldoutLocality = (name: string): boolean => localityHash(name) % 10 === 0

const cleanLocality = (locality: string) =>
	locality && locality.length <= MAX_LOCALITY_LENGTH && !/\d|,/.test(locality) && !/cedex/i.test(locality)

export async function readUsTuples(source: { zip: PathBuilderLike; csv: string; region: string }): Promise<USTuple[]> {
	const tuples: USTuple[] = []
	const seen = new Set<string>()

	for await (const row of readZippedCSVRecords(source.zip, source.csv)) {
		const locality = row.city ?? ""

		if (!cleanLocality(locality)) continue
		const street = row.street ?? ""
		const pairKey = `${locality}|${street}`.toLowerCase()

		if (seen.has(pairKey)) continue
		seen.add(pairKey)

		tuples.push({
			house_number: row.number ?? "",
			street,
			locality,
			region: source.region,
			postcode: row.postcode ?? "",
		})
	}

	return tuples
}

export async function readFrTuples(limit: number): Promise<FRTuple[]> {
	if (!(await pathExists(FR_SOURCE.zip))) {
		console.error(`  WARN: ${FR_SOURCE.zip} is not cached — skipping ${FR_SOURCE.csv}`)

		return []
	}

	const encoder = new TextEncoder()

	const strided = TextSpliterator.fromAsync(readZipEntry(FR_SOURCE.zip, FR_SOURCE.csv), { skipEmpty: false })
		.filter((_line, index) => index === 0 || (index + 1) % FR_STRIDE === FR_STRIDE_OFFSET)
		.take(limit + 1)
		.map((line) => encoder.encode(line + "\n"))

	const tuples: FRTuple[] = []
	const seen = new Set<string>()

	for await (const row of readCSVRecords(strided)) {
		const locality = row.city ?? "",
			postcode = row.postcode ?? "",
			street = row.street ?? "",
			house_number = row.number ?? ""

		if (!cleanLocality(locality) || !/^\d{5}$/.test(postcode) || !street || !house_number) continue
		const key = `${locality}|${street}`.toLowerCase()

		if (seen.has(key)) continue
		seen.add(key)
		tuples.push({ house_number, street, locality, postcode })
	}

	return tuples
}

export async function readCaLocalities(admin1: string): Promise<string[]> {
	if (!(await pathExists(GEONAMES_CA))) {
		console.error(`  WARN: ${GEONAMES_CA} is not cached — skipping CA localities (admin1=${admin1})`)

		return []
	}

	const localities = new Set<string>()

	for await (const columns of TSVSpliterator.fromAsync(readZipEntry(GEONAMES_CA, "CA.txt"), { header: false })) {
		if (
			columns[6] === "P" &&
			columns[8] === "CA" &&
			columns[10] === admin1 &&
			Number(columns[14]) > CA_LOCALITY_MIN_POPULATION &&
			cleanLocality(columns[1] ?? "")
		) {
			localities.add(columns[1]!)
		}
	}

	return [...localities]
}

export async function readPostalTuples(
	source: { zip: PathBuilderLike; txt: string },
	opts: { withState: boolean }
): Promise<Array<AUTuple | NZTuple>> {
	if (!(await pathExists(source.zip))) {
		console.error(`  WARN: ${source.zip} is not cached — skipping ${source.txt}`)

		return []
	}

	const tuples: Array<AUTuple | NZTuple> = []
	const seen = new Set<string>()
	const validPostcode = opts.withState ? isAuPostcode : isNZPostcode

	for await (const columns of TSVSpliterator.fromAsync(readZipEntry(source.zip, source.txt), { header: false })) {
		const postcode = (columns[1] ?? "").trim(),
			locality = (columns[2] ?? "").trim(),
			region = (columns[4] ?? "").trim()

		if (!cleanLocality(locality) || !validPostcode(postcode) || (opts.withState && !isAuStateAbbreviation(region)))
			continue

		const key = `${locality}|${postcode}`.toLowerCase()

		if (seen.has(key)) continue
		seen.add(key)
		tuples.push(opts.withState ? { locality, region, postcode } : { locality, postcode })
	}

	return tuples
}
