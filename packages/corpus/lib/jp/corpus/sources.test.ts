/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The KEN_ALL 〒 join's tiers, ported from the deleted `test_jp_corpus.py`.
 */

import { temporaryDirectory, type TemporaryDirectory } from "@mailwoman/core/fs/temporary"
import { writeLocalBuffer } from "@mailwoman/core/fs/writers"
import { afterAll, beforeAll, expect, it } from "vitest"

import { type KenAllIndex, loadKenAllPostcodes } from "#jp/corpus/sources"

/**
 * Four KEN_ALL_ROME rows in cp932, as Japan Post writes the file: Sapporo's catch-all, a town,
 * a town with a parenthetical annotation, and an Ishigaki town KEN_ALL spells without 字.
 *
 * Sapporo's municipality is written with an ideographic space, shown here as [U+3000].
 *
 * ```text
 * "0600000","北海道","札幌市[U+3000]中央区","以下に掲載がない場合","HOKKAIDO","SAPPORO SHI CHUO KU","IKANI"
 * "0640941","北海道","札幌市[U+3000]中央区","旭ケ丘","HOKKAIDO","SAPPORO SHI CHUO KU","ASAHIGAOKA"
 * "0600041","北海道","札幌市[U+3000]中央区","大通東（１～１３丁目）","HOKKAIDO","SAPPORO SHI CHUO KU","ODORI"
 * "9070003","沖縄県","石垣市","崎枝","OKINAWA KEN","ISHIGAKI SHI","SAKIEDA"
 * ```
 */
const KEN_ALL_CP932 = [
	"IjA2MDAwMDAiLCKWa4pDk7kiLCKORJZ5jnOBQJKGiZuL5iIsIojIibqCyYxmjdqCqoLIgqKP6o2H",
	"IiwiSE9LS0FJRE8iLCJTQVBQT1JPIFNISSBDSFVPIEtVIiwiSUtBTkkiCiIwNjQwOTQxIiwilmuK",
	"Q5O5IiwijkSWeY5zgUCShombi+YiLCKIroNQi3UiLCJIT0tLQUlETyIsIlNBUFBPUk8gU0hJIENI",
	"VU8gS1UiLCJBU0FISUdBT0tBIgoiMDYwMDA0MSIsIpZrikOTuSIsIo5ElnmOc4FAkoaJm4vmIiwi",
	"keWSypOMgWmCUIFgglCCUpKaltqBaiIsIkhPS0tBSURPIiwiU0FQUE9STyBTSEkgQ0hVTyBLVSIs",
	"Ik9ET1JJIgoiOTA3MDAwMyIsIomrk+qMpyIsIpDOil+OcyIsIo3ojn0iLCJPS0lOQVdBIEtFTiIs",
	"IklTSElHQUtJIFNISSIsIlNBS0lFREEi",
].join("")

let scratch: TemporaryDirectory
let index: KenAllIndex

beforeAll(async () => {
	scratch = await temporaryDirectory("mailwoman-kenall-")
	await writeLocalBuffer(Buffer.from(KEN_ALL_CP932, "base64"), scratch.path("KEN_ALL_ROME.CSV"))
	index = await loadKenAllPostcodes(scratch.path("KEN_ALL_ROME.CSV"))
})

afterAll(async () => {
	await scratch[Symbol.asyncDispose]()
})

it("prefers a town-level match, and falls back to the municipality's NNN-0000 catch-all", () => {
	expect(index.lookup("北海道", "札幌市中央区", "旭ケ丘")).toEqual(["0640941", "town"])
	expect(index.lookup("北海道", "札幌市中央区", "存在しない町")).toEqual(["0600000", "municipality"])
})

it("retries a district without its 字 prefix", () => {
	// Overture writes 字崎枝 and KEN_ALL writes 崎枝.
	expect(index.lookup("沖縄県", "石垣市", "字崎枝")).toEqual(["9070003", "town_aza_stripped"])
	expect(index.lookup("沖縄県", "石垣市", "崎枝")).toEqual(["9070003", "town"])
})

it("strips a parenthetical annotation from the town name", () => {
	expect(index.lookup("北海道", "札幌市中央区", "大通東")).toEqual(["0600041", "town"])
})

it("never reads the catch-all literal as a town", () => {
	expect(index.lookup("北海道", "札幌市中央区", "以下に掲載がない場合")).toEqual(["0600000", "municipality"])
})
