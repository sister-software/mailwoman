/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 * The Korean road-name address register (주소DB) used as alignment ground truth; the ministry assigns
 * the road names and building numbers it publishes, so the register asserts `address` on `premise`
 * rows where the permit registry's address field is an `observation`. The archive is four
 * pipe-delimited CP949 text files per 시도 plus one nationwide road-code file, as the guide inside the
 * zip states (붙임1, the 전체분 layout), and both its member names and its contents need the publisher's
 * encoding.
 */

import { decodeByteStream } from "@mailwoman/core/fs/streams"
import { listZipEntries, readZipEntry } from "@mailwoman/core/fs/zip"
import type { PathBuilderLike } from "path-ts"
import { TextSpliterator } from "spliterator"

/**
 * The publisher's encoding; `cp949` rather than `euc-kr`, because the register's UHC extension appears
 * in about one row in 48,000 and Node's whatwg `euc-kr` decodes it to a different string with no error.
 */
const ENCODING = "cp949"

/**
 * The road-code file's columns, 0-based.
 */
const RC = { code: 0, road: 1, serial: 3, region: 4, sigungu: 6, eupmyeondong: 8, kind: 10 } as const

/**
 * 주소 columns.
 */
const AD = { id: 0, roadCode: 1, serial: 2, underground: 3, main: 4, sub: 5, postcode: 6 } as const

/**
 * 지번 columns.
 */
const LOT = { id: 0, dong: 5, ri: 6, mountain: 7, main: 8, sub: 9, primary: 10 } as const

/**
 * 부가정보 columns.
 */
const SUP = { id: 0, postcode: 3, buildingRegister: 6, buildingLocal: 7, apartment: 8 } as const

/**
 * Joins 도로명코드 to 읍면동일련번호 with a NUL no code contains, since neither part has a fixed width
 * and a printable separator could let two different pairs produce one key.
 */
const CODE_SEPARATOR = "\0"

/**
 * The road-code table's key for one 도로명코드 and 읍면동일련번호.
 */
function roadCodeKey(code: string, serial: string): string {
	return `${code}${CODE_SEPARATOR}${serial}`
}

/**
 * The 2026 edition merged 전남광주통합특별시 while older sources still write 전라남도 and 광주광역시,
 * so a typed string in either form aligns against the register through this map.
 */
export const REGION_ALIASES: Readonly<Record<string, string>> = {
	전라남도: "전남광주통합특별시",
	광주광역시: "전남광주통합특별시",
	강원도: "강원특별자치도",
	전라북도: "전북특별자치도",
}

/**
 * One address of the register, with the pieces the road form and the lot form each write.
 */
export interface JusoLabelRow {
	region: string
	sigungu: string
	/**
	 * The 읍/면 the road address itself carries between the 시군구 and the road (읍면동구분 `0`),
	 * else empty; a 동 is never written in the road form, it goes in the parenthetical.
	 */
	eupmyeon: string
	dong: string
	ri: string
	road: string
	number: string
	postcode: string
	building: string
	lot: string
	underground: boolean
}

/**
 * What the official form writes in parentheses after the number: the 법정동 in a 동 area, the 리 in an 읍/면.
 */
export function parenthetical(row: JusoLabelRow): string {
	return row.eupmyeon ? row.ri : row.dong
}

/**
 * Every full-edition member of one kind as `[region suffix, archive name]`, sorted by region;
 * the monthly edition's 변동 (change-only) files under the same prefixes are excluded by name.
 */
export function regionMembers(names: readonly string[], prefix: string): Array<[string, string]> {
	return names
		.filter((name) => name.startsWith(`${prefix}_`) && name.endsWith(".txt") && !name.includes("변동"))
		.map((name): [string, string] => [name.slice(prefix.length + 1, -4), name])
		.toSorted(([a], [b]) => a.localeCompare(b))
}

/**
 * Split one CP949 pipe-delimited member into its fields, line by line, without holding the member.
 */
async function* fields(archivePath: PathBuilderLike, member: string): AsyncGenerator<string[]> {
	const bytes = readZipEntry(archivePath, member, { filenameEncoding: ENCODING })

	for await (const line of TextSpliterator.fromAsync(decodeByteStream(bytes, ENCODING))) {
		yield line.replace(/\r$/u, "").split("|")
	}
}

/**
 * The road-code table keyed by {@link roadCodeKey}, held whole because every region's
 * addresses join against it and read as one composite string key rather than a nested map.
 */
async function loadRoadCodes(archivePath: PathBuilderLike, member: string): Promise<Map<string, string[]>> {
	const codes = new Map<string, string[]>()

	for await (const row of fields(archivePath, member)) {
		if (row.length <= RC.kind) continue

		codes.set(roadCodeKey(row[RC.code]!, row[RC.serial]!), [
			row[RC.region]!,
			row[RC.sigungu]!,
			row[RC.eupmyeondong]!,
			row[RC.road]!,
			row[RC.kind]!,
		])
	}

	return codes
}

/**
 * A house or lot number as the register writes it: leading zeros dropped, a `-<부번>` only when there is one.
 */
function joinNumber(main: string, sub: string): string {
	const head = main.replace(/^0+/u, "") || "0"
	const tail = sub.replace(/^0+/u, "")

	return tail && tail !== "0" ? `${head}-${tail}` : head
}

export interface ReadJusoOptions {
	/**
	 * Stop after this many rows per 시도, for a fixture or a smoke run; omit for the whole register.
	 */
	maxRowsPerRegion?: number
}

/**
 * Stream every label row region by region, holding one 시도's lot and supplement files
 * while its address file streams, so the join never holds the country at once.
 */
export async function* readJusoLabelRows(
	archivePath: PathBuilderLike,
	options: ReadJusoOptions = {}
): AsyncGenerator<JusoLabelRow> {
	const names = (await listZipEntries(archivePath, { filenameEncoding: ENCODING })).map((entry) => entry.name)

	const roadCodeMember = names.find((name) => name.includes("도로명코드") && !name.includes("변동"))

	if (!roadCodeMember) {
		throw new Error(`no 도로명코드 member in ${archivePath} — the archive is not a 전체분 edition`)
	}

	const codes = await loadRoadCodes(archivePath, roadCodeMember)
	const lotMembers = new Map(regionMembers(names, "지번"))
	const supplementMembers = new Map(regionMembers(names, "부가정보"))

	for (const [suffix, member] of regionMembers(names, "주소")) {
		const lotMember = lotMembers.get(suffix)
		const supplementMember = supplementMembers.get(suffix)

		if (!lotMember || !supplementMember) {
			throw new Error(`region ${suffix} has an address file but no 지번 or 부가정보 file`)
		}

		const lots = new Map<string, [string, string, string]>()

		for await (const row of fields(archivePath, lotMember)) {
			if (row.length <= LOT.primary || row[LOT.primary] !== "1") continue

			const lot = `${row[LOT.mountain] === "1" ? "산" : ""}${joinNumber(row[LOT.main]!, row[LOT.sub]!)}`

			lots.set(row[LOT.id]!, [row[LOT.dong]!, row[LOT.ri]!, lot])
		}

		const supplements = new Map<string, [string, string]>()

		for await (const row of fields(archivePath, supplementMember)) {
			if (row.length <= SUP.apartment) continue

			supplements.set(row[SUP.id]!, [row[SUP.postcode]!, row[SUP.buildingLocal] || row[SUP.buildingRegister]!])
		}

		let emitted = 0

		for await (const row of fields(archivePath, member)) {
			if (row.length <= AD.postcode) continue

			const code = codes.get(roadCodeKey(row[AD.roadCode]!, row[AD.serial]!))

			if (!code) continue

			const [region, sigungu, eupmyeondong, road, kind] = code as [string, string, string, string, string]
			const [dong = "", ri = "", lot = ""] = lots.get(row[AD.id]!) ?? []
			const [postcode = row[AD.postcode]!, building = ""] = supplements.get(row[AD.id]!) ?? []

			yield {
				region,
				sigungu,
				eupmyeon: kind === "0" ? eupmyeondong : "",
				dong,
				ri,
				road,
				number: joinNumber(row[AD.main]!, row[AD.sub]!),
				postcode: postcode || row[AD.postcode]!,
				building,
				lot,
				underground: row[AD.underground] === "1",
			}

			emitted += 1

			if (options.maxRowsPerRegion !== undefined && emitted >= options.maxRowsPerRegion) break
		}
	}
}
