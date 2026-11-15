// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 * Writes the golden output of `computeQueryShape` for a fixed list of inputs
 * to `packages/query-shape/test/fixtures/compute-query-shape.golden.json`.
 *
 * The fixture is the behavior `@mailwoman/recognize` must reproduce (#3064).
 * Every case records the input, its category and the whole `QueryShape` the legacy implementation returns.
 *
 * A later differential test compares every field a consumer reads.
 *
 * The inputs cover empty, short, long, ASCII, CJK, Arabic, Cyrillic, Greek, mixed-script,
 * postcode, PO box, punctuation-only and malformed text.
 * Malformed means a lone surrogate, a NUL, an astral codepoint, a combining mark and a no-break space.
 *
 * Usage: `node packages/mailwoman/tools/dev-tools/query-shape/golden.run.ts [--check]`
 *
 * `--check` writes no file and exits non-zero when the committed file differs from what the code produces.
 */

import { readLocalTextFile } from "@mailwoman/core/fs/readers"
import { writeLocalJSONFile } from "@mailwoman/core/fs/writers"
import { prettyJSON } from "@mailwoman/core/json"
import { workspacePath } from "@mailwoman/core/paths"
import { parseArguments } from "@mailwoman/core/scripting/arguments"
import { computeQueryShape, type QueryShape } from "@mailwoman/query-shape"

/**
 * One fixture input and the category it stands for.
 */
interface GoldenInput {
	category: string
	input: string
}

/**
 * The US address of the long case.
 *
 * The issue's timing table repeats it four times with an empty separator.
 * That input is 300 UTF-16 units long.
 */
const WHITE_HOUSE = "1600 Pennsylvania Avenue NW, Washington, DC 20500, United States of America"

const INPUTS: readonly GoldenInput[] = [
	...cases("empty", ["", " ", "   ", "\n", "\t"]),
	...cases("short", ["a", "NY", "75", "5th", "x1"]),
	...cases("ascii", [
		"350 5th Ave, New York, NY 10118",
		"Springfield, IL 62701",
		"Cool, CA",
		"Flat 2, 14 Baker Street; London\nNW1 6XE",
		"10  Downing   Street",
		"a\tb\tc",
		"a\tb c",
		"O'Brien St-Louis",
	]),
	...cases("long", [
		WHITE_HOUSE,
		WHITE_HOUSE.repeat(4),
		Array.from({ length: 4 }, () => WHITE_HOUSE).join(", "),
		"1".repeat(64),
	]),
	...cases("cjk", [
		"〒100-0001 東京都千代田区千代田1-1",
		"東京都千代田区千代田1-1",
		"서울특별시 중구 세종대로 110",
		"北京市朝阳区建国路88号",
		"ニューヨーク州 10001",
		"ブロードウェイ",
		"ｱｲｳ ABC",
	]),
	...cases("arabic", ["شارع الملك فهد، الرياض 12211", "١٢٣٤٥", "القاهرة"]),
	...cases("cyrillic", ["ул. Тверская, 7, Москва, 125009", "Москва"]),
	...cases("greek", ["Ερμού 15, Αθήνα 105 63", "Αθήνα"]),
	...cases("mixed-script", [
		"金龍酒家, 12 Gerrard Street, London WC2H 7JS",
		"逊克二分场四队, heilongjiang, china",
		"ニューヨーク-NY",
		"Москва Moscow 北京",
		"Far East Chinese 口福羊汤, 13 Gerrard St, London W1D 5PS",
	]),
	...cases("postcode", [
		"68161",
		"SW1A 1AA",
		"SW1A1AA",
		"M1 1AE",
		"K1A 0B1",
		"K1A0B1",
		"10118-1234",
		"1012 LG",
		"1012LG",
		"75004",
		"123 45",
		"〒100-0001",
		"12345 Main Street",
	]),
	...cases("po-box", ["PO Box 123", "P.O. Box 4B", "BP 12", "Apartado 5000", "Casilla 99", "box"]),
	...cases("punctuation-only", ["???", ",,,", "---", "...", "、。", "'''", "-", ", , ,"]),
	...cases("malformed", [
		"\uD800",
		"\uDC00 abc",
		"abc\uD83D",
		"a\u0000b",
		"𠀀 test",
		"📍 Main St",
		"é 12345",
		"12345 Main",
		"​12345",
		"12345\r\nMain",
	]),
]

/**
 * Pairs each text with a category.
 */
function cases(category: string, texts: readonly string[]): GoldenInput[] {
	return texts.map((input) => ({ category, input }))
}

interface GoldenCase extends GoldenInput {
	shape: QueryShape
}

const golden = {
	$generatedBy: "packages/mailwoman/tools/dev-tools/query-shape/golden.run.ts",
	$note:
		"The output of computeQueryShape(input) from @mailwoman/query-shape, one case per input. Offsets are UTF-16 code units. Do not edit by hand: rerun the generator.",
	cases: INPUTS.map(({ category, input }): GoldenCase => ({ category, input, shape: computeQueryShape(input) })),
}

const { values } = parseArguments({ options: { check: { type: "boolean", default: false } } })
const path = workspacePath("query-shape", "test", "fixtures", "compute-query-shape.golden.json")

if (values.check) {
	// A missing or unreadable file is a failure of its own and mustn't read as "no difference".
	const committed = await readLocalTextFile(path)

	if (committed !== prettyJSON(golden)) {
		console.error(`${path} differs from computeQueryShape output; rerun golden.run.ts`)

		process.exitCode = 1
	} else {
		console.log(`${golden.cases.length} cases match ${path}`)
	}
} else {
	await writeLocalJSONFile(golden, path)

	console.log(`wrote ${golden.cases.length} cases to ${path}`)
}
