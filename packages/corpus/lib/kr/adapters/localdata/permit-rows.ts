/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 * The Korean permit registry (지방행정인허가데이터) as an `observation` source. It reads the delivered
 * CSVs and turns an aligned string into a corpus row.
 *
 * The publisher delivers CP949, one file per business category, with both address systems typed by
 * a clerk plus a planar coordinate in epsg:5174 and both postcodes. The adapter separates reading from
 * aligning so the alignment rate per file can be measured before any row enters a corpus.
 */

import { sortedGlob } from "@mailwoman/core/fs/readers"
import { decodeByteStream, openReadStream } from "@mailwoman/core/fs/streams"
import { stringifyJSON } from "@mailwoman/core/json"
import { basename, extname, type PathBuilderLike, resolvePathBuilder } from "path-ts"
import { CSVSpliterator } from "spliterator"
import { Globerator } from "spliterator/node/fs"

import { type CJKRecord, labelTokensByFirstSpan } from "#cjk/builder"
import type { Aligned } from "#kr/adapters/localdata/align"

/**
 * The source label stored on every row from this adapter.
 * Configs use this label as the `source_weights` key.
 */
export const SOURCE = "localdata-kr"

/**
 * Every permit in this registry is Korean.
 * The publisher issues no others.
 */
export const COUNTRY = "KR"

/**
 * The 영업상태명 of a business still trading.
 *
 * A closed one's address records somewhere that was.
 */
export const OPEN_STATUS = "영업/정상"

/**
 * The publisher's encoding.
 *
 * `cp949` rather than `euc-kr` for the reason `decodeByteStream` states.
 */
const ENCODING = "cp949"

/**
 * One permit, with both address systems as the clerk typed them.
 */
export interface PermitRow {
	/**
	 * The file's basename: the business category the publisher splits by.
	 */
	category: string
	name: string
	status: string
	roadAddress: string
	lotAddress: string
	roadPostcode: string
	lotPostcode: string
	x: number | null
	y: number | null
}

/**
 * The first of these column spellings present in the row, trimmed, or the empty string.
 *
 * The publisher's older and newer exports name the same field differently — `도로명주소`
 * against `도로명전체주소`, `좌표정보(X)` against `좌표정보(x)` — and a directory holds both vintages,
 * so each field names every spelling it has been delivered under.
 */
function firstColumn(row: Record<string, string | undefined>, ...names: readonly string[]): string {
	for (const name of names) {
		const value = row[name]

		if (value) return String(value).trim()
	}

	return ""
}

/**
 * A coordinate field as a number, or `null` when the field is empty.
 *
 * A non-empty field that is not a number, such as `198,000`, raises: Python's `float` did,
 * and reading it as absent would drop the row from its district's centroid without a count.
 *
 * @throws Naming the value and the field.
 */
function toNumber(value: string, field: string): number | null {
	if (!value.trim()) return null

	const parsed = Number(value)

	if (!Number.isFinite(parsed)) throw new Error(`a permit row's ${field} is ${stringifyJSON(value)}, not a number`)

	return parsed
}

export interface ReadPermitOptions {
	/**
	 * Keep only these 영업상태명 values.
	 *
	 * Empty admits every status.
	 */
	statuses?: readonly string[]
	/**
	 * A directory read takes only the category files this glob matches, for a smoke run.
	 *
	 * @defaultValue every `.csv` file
	 */
	pattern?: string
}

/**
 * Stream every permit of one CSV.
 */
export async function* readPermitFile(
	path: PathBuilderLike,
	options: ReadPermitOptions = {}
): AsyncGenerator<PermitRow> {
	const wanted = new Set(options.statuses ?? [OPEN_STATUS])
	const file = path.toString()
	const category = basename(file, extname(file))
	const bytes = openReadStream(path)

	for await (const row of CSVSpliterator.fromAsync<Record<string, string>>(decodeByteStream(bytes, ENCODING))) {
		const status = firstColumn(row, "영업상태명")

		if (wanted.size && !wanted.has(status)) continue

		const roadAddress = firstColumn(row, "도로명주소", "도로명전체주소")
		const lotAddress = firstColumn(row, "지번주소", "소재지전체주소")

		if (!roadAddress && !lotAddress) continue

		yield {
			category,
			name: firstColumn(row, "사업장명"),
			status,
			roadAddress,
			lotAddress,
			roadPostcode: firstColumn(row, "도로명우편번호"),
			lotPostcode: firstColumn(row, "소재지우편번호"),
			x: toNumber(firstColumn(row, "좌표정보(X)", "좌표정보(x)"), `좌표정보(X) in ${file}`),
			y: toNumber(firstColumn(row, "좌표정보(Y)", "좌표정보(y)"), `좌표정보(Y) in ${file}`),
		}
	}
}

/**
 * Stream every permit of every CSV in a directory, in filename order.
 */
export async function* readPermitDirectory(
	directory: PathBuilderLike,
	options: ReadPermitOptions = {}
): AsyncGenerator<PermitRow> {
	const files = options.pattern
		? await sortedGlob(directory, options.pattern)
		: await Globerator.files("csv", { cwd: directory, absolute: false, recursive: false }).toSorted()

	for (const name of files) {
		yield* readPermitFile(resolvePathBuilder(directory, name), options)
	}
}

/**
 * One aligned string as a row in the CJK corpus schema.
 *
 * The token labels are derived from the spans rather than stored beside them:
 * a token is `B-<tag>` when its first character falls inside a span, `O` otherwise.
 * A span covering several tokens labels only the token where it starts.
 * The char-path trainer reads this label from each span.
 */
export function alignedToCJKRow(aligned: Aligned): CJKRecord {
	const raw = aligned.raw

	return {
		raw,
		...labelTokensByFirstSpan(raw, aligned.spanStarts, aligned.spanEnds, aligned.spanTags),
		span_starts: [...aligned.spanStarts],
		span_ends: [...aligned.spanEnds],
		span_tags: [...aligned.spanTags],
		country: COUNTRY,
		source: SOURCE,
		register: aligned.register,
	}
}
