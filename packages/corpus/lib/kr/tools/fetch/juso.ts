/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Fetch the Korean road-name address register (도로명주소 주소DB) from the ministry's address-industry
 *   portal, business.juso.go.kr. The ministry assigns the road names and building numbers it publishes, so
 *   this source asserts `address` on `premise` rows: about 6,000,000
 *   road-name addresses and 8,000,000 lot-number (지번) records, split by the publisher into four
 *   pipe-delimited CP949 text files per region (도로명코드 / 주소 / 지번 / 부가정보), with the postcode in
 *   the supplementary file. No coordinates. The public-data portal labels it "이용허락범위 제한 없음"
 *   (no restriction on the scope of use). It is a direct download with no application step — the
 *   distinction that matters against the ministry's entrance-coordinate products. Those products are provided
 *   only after a purpose-of-use review (`docs/superpowers/plans/counsel-dossier.md` §4).
 *
 *   The portal is a single-page app. the file behind it is reached in two calls. `selectAttrbDBDwldList`
 *   lists the monthly full files for one product (`rtlDtaDtlSn` 8 is the 주소DB, 2 the English
 *   road-name DB), and `/api/jst/download` streams one by the parameters in the listing. The
 *   English DB accompanies it as the Latin-script half of the same register.
 *
 *   Invoke via `mailwoman corpus fetch juso-kr [--vintage YYYY-MM]`. Each month is a snapshot under
 *   `$MAILWOMAN_DATA_ROOT/snapshots/juso-kr/<YYYY-MM>/`.
 */

import { sha256File } from "@mailwoman/core/hash"
import { stringifyJSON } from "@mailwoman/core/json"
import type { PathBuilder } from "path-ts"

import type { FetchSummary, SourceCollectionManifest, SourceManifest } from "#tools/fetch/download"
import { resumableDownload, writeManifest } from "#tools/fetch/download"
import { fetchSnapshot, type SnapshotFetchOptions } from "#tools/fetch/storage"

const SLUG = "juso-kr"
const PORTAL = "https://business.juso.go.kr"
const LIST_URL = `${PORTAL}/api/jst/selectAttrbDBDwldList`
const DOWNLOAD_URL = `${PORTAL}/api/jst/download`
const REFERER = `${PORTAL}/jst/jstAddressDownload?menu=30`

/**
 * The portal's product ids for the two registers this module fetches.
 */
const PRODUCTS = [
	{ sn: "8", name: "주소DB" },
	{ sn: "2", name: "도로명주소 영문" },
] as const

const LICENSE =
	"이용허락범위 제한 없음 (data.go.kr label for 행정안전부_도로명주소 주소DB); 공공누리 attribution to 행정안전부"

const ATTRIBUTION = "행정안전부 (Ministry of the Interior and Safety), 도로명주소 (juso.go.kr)"

interface ListedFile {
	crtrYm: string
	fileTypeNm: string
	fileNm: string
	isExist: "Y" | "N"
	ctpvClsfCd: string
	tmprFileNm: string
	fileSn: string | null
	atflNo: string | null
}

interface ListResponse {
	results?: { allMonthFileList?: ListedFile[] }
}

/**
 * The month `--vintage` selects, `YYYY-MM`; the portal writes it as `yyyymm`.
 */
export type FetchJusoKROptions = SnapshotFetchOptions

/**
 * The vintage of a listed month: `202608` is `2026-08`.
 */
export function jusoVintage(crtrYm: string): string {
	if (!/^\d{6}$/u.test(crtrYm)) throw new Error(`${SLUG}: the portal listed month ${crtrYm}, not yyyymm`)

	return `${crtrYm.slice(0, 4)}-${crtrYm.slice(4)}`
}

const BROWSER_HEADERS = {
	"user-agent": "Mozilla/5.0 (X11; Linux x86_64) mailwoman-corpus-fetch",
	referer: REFERER,
}

/**
 * The monthly full files the portal lists for one product over the twelve months ending at `year`/`month`.
 */
async function listMonthlyFiles(sn: string, year: number, month: number): Promise<ListedFile[]> {
	const res = await fetch(LIST_URL, {
		method: "POST",
		headers: { ...BROWSER_HEADERS, accept: "application/json", "content-type": "application/json;charset=UTF-8" },
		body: stringifyJSON({ rtlDtaDtlSn: sn, year, month, expand: "Y" }),
	})

	if (!res.ok) throw new Error(`juso-kr: listing product ${sn} answered HTTP ${res.status}`)
	const json = (await res.json()) as ListResponse

	return (json.results?.allMonthFileList ?? []).filter((file) => file.isExist === "Y")
}

function downloadURL(file: ListedFile, regYmd: string): string {
	const query = new URLSearchParams({
		reqType: file.fileTypeNm,
		ctprvnCd: file.ctpvClsfCd,
		stdde: file.crtrYm,
		fileName: file.fileNm,
		realFileName: file.tmprFileNm,
		intFileNo: file.fileSn ?? "0",
		intNum: file.atflNo ?? "0",
		regYmd,
	})

	return `${DOWNLOAD_URL}?${query.toString()}`
}

/**
 * Downloads one month of both products into its snapshot, `juso-kr/<YYYY-MM>/`.
 *
 * The vintage is the month `--vintage` names, or else the latest month the address DB's listing holds.
 * Both are known from the listing before any download, and the English DB is fetched for the same month.
 */
export async function fetchJusoKR(options: FetchJusoKROptions, report?: (line: string) => void): Promise<FetchSummary> {
	const now = new Date()

	const listings = await Promise.all(
		PRODUCTS.map(async (product) => ({
			product,
			listed: await listMonthlyFiles(product.sn, now.getFullYear(), now.getMonth() + 1),
		}))
	)

	const latest = listings[0]!.listed.at(-1)
	const vintage = options.snapshots.vintage ?? (latest ? jusoVintage(latest.crtrYm) : null)

	if (!vintage) {
		report?.(`  ✗ ${PRODUCTS[0].name}: the portal lists no full file`)

		return { fetched: 0, skipped: 0, failed: 1, failedCodes: [PRODUCTS[0].name] }
	}

	return fetchSnapshot(
		options.snapshots,
		SLUG,
		vintage,
		(destDir) => downloadJusoMonth(listings, vintage, destDir, now, report),
		report
	)
}

async function downloadJusoMonth(
	listings: ReadonlyArray<{ product: (typeof PRODUCTS)[number]; listed: ListedFile[] }>,
	vintage: string,
	destDir: PathBuilder,
	now: Date,
	report?: (line: string) => void
): Promise<FetchSummary> {
	const files: SourceManifest[] = []
	const failedCodes: string[] = []

	for (const { product, listed } of listings) {
		const file = listed.find((entry) => jusoVintage(entry.crtrYm) === vintage)

		if (!file) {
			report?.(`  ✗ ${product.name}: no full file listed for ${vintage}`)
			failedCodes.push(product.name)

			continue
		}

		const url = downloadURL(file, String(now.getFullYear()))
		const dest = destDir(file.tmprFileNm)
		report?.(`=== ${SLUG} / ${product.name} ${file.crtrYm} → ${file.tmprFileNm}`)
		let bytes: number

		try {
			// The portal drops a connection every few megabytes and answers Range with 206,
			// so the transfer resumes from what landed rather than starting the 181 MB over.
			bytes = await resumableDownload({ url, dest, headers: BROWSER_HEADERS, report })
		} catch (error) {
			report?.(`  ✗ ${(error as Error).message}`)
			failedCodes.push(product.name)

			continue
		}

		const sha = await sha256File(dest)

		files.push({
			source_url: url,
			downloaded_at: new Date().toISOString(),
			filename: file.tmprFileNm,
			sha256: sha,
			bytes,
		})

		report?.(`  ✓ ${(bytes / 1024 / 1024).toFixed(1)} MB  sha256=${sha}`)
	}

	const manifest: SourceCollectionManifest = {
		source: SLUG,
		source_url: REFERER,
		license: LICENSE,
		attribution: ATTRIBUTION,
		downloaded_at: new Date().toISOString(),
		files,
	}

	await writeManifest(destDir("MANIFEST.json"), manifest)

	return { fetched: files.length, skipped: 0, failed: failedCodes.length, failedCodes }
}
