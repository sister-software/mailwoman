// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { writeLocalTextFile } from "@mailwoman/core/fs/writers"
import { describe, expect, it } from "vitest"

import { CensusGazetteerKind, readCensusGazetteer } from "#sdk/gazetteer"

// One row from each 2024 national file, with the trailing spaces the files pad their last column with.
const PLACES = [
	"USPS\tGEOID\tANSICODE\tNAME\tLSAD\tFUNCSTAT\tALAND\tAWATER\tALAND_SQMI\tAWATER_SQMI\tINTPTLAT\tINTPTLONG          ",
	"IN\t1836003\t02395424\tIndianapolis city (balance)\t00\tF\t935023959\t17914056\t361.015\t6.917\t39.776664\t-86.145935  ",
].join("\n")

const COUSUBS = [
	"USPS\tGEOID\tANSICODE\tNAME\tFUNCSTAT\tALAND\tAWATER\tALAND_SQMI\tAWATER_SQMI\tINTPTLAT\tINTPTLONG     ",
	"OH\t3915162988\t01086988\tPlain township\tA\t69709609\t303811\t26.915\t0.117\t40.870795\t-81.366584    ",
].join("\n")

describe("readCensusGazetteer", () => {
	it("reads the GNIS id from the zero-padded ANSICODE and trims the trailing spaces", async () => {
		await using dir = await temporaryDirectory("census-gazetteer-")
		const path = dir.path("places.txt")

		await writeLocalTextFile(PLACES, path)

		expect(await Array.fromAsync(readCensusGazetteer(path, CensusGazetteerKind.Place))).toEqual([
			{
				kind: "place",
				state: "IN",
				geoid: "1836003",
				gnisID: 2_395_424,
				name: "Indianapolis city (balance)",
				lsad: "00",
				functionalStatus: "F",
				latitude: 39.776664,
				longitude: -86.145935,
			},
		])
	})

	it("reads the county subdivision file, which has no LSAD column", async () => {
		await using dir = await temporaryDirectory("census-gazetteer-")
		const path = dir.path("cousubs.txt")

		await writeLocalTextFile(COUSUBS, path)

		const [entry] = await Array.fromAsync(readCensusGazetteer(path, CensusGazetteerKind.CountySubdivision))

		expect(entry).toMatchObject({ geoid: "3915162988", gnisID: 1_086_988, lsad: null, functionalStatus: "A" })
	})
})
