/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The Korean permit registry (지방행정인허가데이터) as a NOISY corpus source: reading the delivered CSVs, and turning
 *   an aligned string into a corpus row (#2204 §5).
 *
 *   The publisher delivers CP949, one file per business category, with both address systems typed by a clerk plus a
 *   planar coordinate in EPSG:5174 and both postcodes. Reading is separated from ALIGNING so the alignment rate per
 *   file can be measured before any row enters a corpus.
 */

import { readDirectoryEntries } from "@mailwoman/core/fs/readers"
import { decodeByteStream, openReadStream } from "@mailwoman/core/fs/streams"
import { basename, extname, join, type PathBuilderLike } from "path-ts"
import { CSVSpliterator } from "spliterator"

import type { Aligned } from "#kr/adapters/localdata/align"

/**
 * The source label every row of this adapter carries, and the name a config's `source_weights` addresses it by.
 */
export const SOURCE = "localdata-kr"

/**
 * Every permit in this registry is Korean; the publisher issues no others.
 */
export const COUNTRY = "KR"

/**
 * The 영업상태명 of a business still trading. A closed one's address records somewhere that was.
 */
export const OPEN_STATUS = "영업/정상"

/**
 * The publisher's encoding. `cp949` rather than `euc-kr` for the reason `decodeByteStream` states.
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
 * The first of these column spellings the row carries, trimmed, or the empty string.
 *
 * The publisher's older and newer exports name the same field differently — `도로명주소` against `도로명전체주소`, `좌표정보(X)`
 * against `좌표정보(x)` — and a directory holds both vintages, so each field names every spelling it has been delivered
 * under.
 */
function firstColumn(row: Record<string, string | undefined>, ...names: readonly string[]): string {
	for (const name of names) {
		const value = row[name]

		if (value !== undefined && value !== null) return String(value).trim()
	}

	return ""
}

function toNumber(value: string): number | null {
	if (!value.trim()) return null

	const parsed = Number(value)

	return Number.isFinite(parsed) ? parsed : null
}

export interface ReadPermitOptions {
	/**
	 * Keep only these 영업상태명 values. Empty admits every status.
	 */
	statuses?: readonly string[]
}

/**
 * Stream every permit of one CSV.
 */
export async function* readPermitFile(
	path: PathBuilderLike,
	options: ReadPermitOptions = {}
): AsyncGenerator<PermitRow> {
	const wanted = new Set(options.statuses ?? [OPEN_STATUS])
	const category = basename(String(path), extname(String(path)))
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
			x: toNumber(firstColumn(row, "좌표정보(X)", "좌표정보(x)")),
			y: toNumber(firstColumn(row, "좌표정보(Y)", "좌표정보(y)")),
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
	const files = (await readDirectoryEntries(directory))
		.filter((entry) => entry.isFile() && entry.name.endsWith(".csv"))
		.map((entry) => entry.name)
		.toSorted()

	for (const name of files) {
		yield* readPermitFile(join(directory, name), options)
	}
}

/**
 * One aligned string as a row in the CJK slice schema.
 *
 * The token labels are derived from the spans rather than carried beside them: a token is `B-<tag>` when its FIRST
 * character falls inside a span, `O` otherwise. A span covering several tokens therefore labels only the token it
 * starts in, which is what the char-path trainer reads the spans for.
 */
export function alignedToSliceRow(aligned: Aligned): Record<string, unknown> {
	const raw = aligned.raw
	const tokens: string[] = []
	const labels: string[] = []
	let cursor = 0

	for (const token of raw.split(/\s+/u).filter((piece) => piece.length)) {
		const index = raw.indexOf(token, cursor)

		cursor = index + token.length

		let label = "O"

		for (let span = 0; span < aligned.spanStarts.length; span += 1) {
			if (aligned.spanStarts[span]! <= index && index < aligned.spanEnds[span]!) {
				label = `B-${aligned.spanTags[span]}`

				break
			}
		}

		tokens.push(token)
		labels.push(label)
	}

	return {
		raw,
		tokens,
		labels,
		span_starts: [...aligned.spanStarts],
		span_ends: [...aligned.spanEnds],
		span_tags: [...aligned.spanTags],
		country: COUNTRY,
		source: SOURCE,
		register: aligned.register,
	}
}
