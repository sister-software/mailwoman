/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Fetch the Korean road-name address register (도로명주소 주소DB) from the ministry's address-industry
 *   portal, business.juso.go.kr. This is the LABEL source for Korean addresses: about 6,000,000
 *   road-name addresses and 8,000,000 lot-number (지번) records, split by the publisher into four
 *   pipe-delimited CP949 text files per region (도로명코드 / 주소 / 지번 / 부가정보), with the postcode in
 *   the supplementary file. No coordinates. The public-data portal labels it "이용허락범위 제한 없음"
 *   (no restriction on the scope of use), and it is a direct download with no application step — the
 *   distinction that matters against the ministry's entrance-coordinate products, which are provided
 *   only after a purpose-of-use review (`docs/superpowers/plans/counsel-dossier.md` §4).
 *
 *   The portal is a single-page app; the file behind it is reached in two calls. `selectAttrbDBDwldList`
 *   lists the monthly full files for one product (`rtlDtaDtlSn` 8 is the 주소DB, 2 the English
 *   road-name DB), and `/api/jst/download` streams one by the parameters the listing carried. The
 *   English DB rides along because it is the Latin-script half of the same register.
 *
 *   Invoke via `mailwoman corpus fetch juso-kr --out-root <path>`.
 */

import { makeDirectories } from "@mailwoman/core/fs/writers"
import { sha256File } from "@mailwoman/core/hash"
import { join } from "path-ts"

import type { BaseFetchOptions, FetchSummary, SourceCollectionManifest, SourceManifest } from "#tools/fetch/download"
import { resumableDownload, writeManifest } from "#tools/fetch/download"

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

export interface FetchJusoKROptions extends BaseFetchOptions {
	/**
	 * The month to fetch as `YYYYMM`. Defaults to the latest month the portal lists as present.
	 */
	month?: string
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
		body: JSON.stringify({ rtlDtaDtlSn: sn, year, month, expand: "Y" }),
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

export async function fetchJusoKR(options: FetchJusoKROptions, report?: (line: string) => void): Promise<FetchSummary> {
	const destDir = join(options.outRoot, SLUG)
	await makeDirectories(destDir)

	const now = new Date()
	const files: SourceManifest[] = []
	const failedCodes: string[] = []

	for (const product of PRODUCTS) {
		const listed = await listMonthlyFiles(product.sn, now.getFullYear(), now.getMonth() + 1)
		const file = options.month ? listed.find((entry) => entry.crtrYm === options.month) : listed.at(-1)

		if (!file) {
			report?.(`  ✗ ${product.name}: no full file listed${options.month ? ` for ${options.month}` : ""}`)
			failedCodes.push(product.name)

			continue
		}

		const url = downloadURL(file, String(now.getFullYear()))
		const dest = join(destDir, file.tmprFileNm)
		report?.(`=== ${SLUG} / ${product.name} ${file.crtrYm} → ${file.tmprFileNm}`)
		let bytes: number

		try {
			// The portal drops a connection every few megabytes and answers Range with 206, so the transfer resumes
			// from what landed rather than starting the 181 MB over.
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

	await writeManifest(join(destDir, "MANIFEST.json"), manifest)

	return { fetched: files.length, skipped: 0, failed: failedCodes.length, failedCodes }
}
