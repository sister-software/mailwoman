/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Tests for the Overture release pre-flight. The required case is the UNREACHABLE bucket: this check exists to
 *   turn a slow failure into a fast one, so letting its own network trouble block a build would be a worse trade than
 *   the problem it solves. It must proceed, and must not claim the release was verified.
 */

import type { OvertureListingClient } from "mailwoman/gazetteer-pipeline/overture-release"
import { checkOvertureRelease, listOvertureReleases } from "mailwoman/gazetteer-pipeline/overture-release"
import { describe, expect, it } from "vitest"

/**
 * Minimal stand-in for the bucket listing — only `fetch` is reached.
 */
const clientReturning = (body: string) => ({ fetch: async () => ({ data: body }) }) satisfies OvertureListingClient

const clientThrowing = (message: string) =>
	({
		fetch: async () => {
			throw new Error(message)
		},
	}) satisfies OvertureListingClient

const LISTING = `<?xml version="1.0" encoding="UTF-8"?>
<ListBucketResult>
  <CommonPrefixes><Prefix>release/2026-07-22.0/</Prefix></CommonPrefixes>
  <CommonPrefixes><Prefix>release/2026-08-19.0/</Prefix></CommonPrefixes>
</ListBucketResult>`

describe("listOvertureReleases", () => {
	it("reads the release names out of the bucket listing, trailing slash stripped", async () => {
		expect(await listOvertureReleases(clientReturning(LISTING))).toEqual(["2026-07-22.0", "2026-08-19.0"])
	})

	it("returns an empty list for a listing with no prefixes rather than throwing", async () => {
		expect(await listOvertureReleases(clientReturning("<ListBucketResult></ListBucketResult>"))).toEqual([])
	})

	it("ignores the request's own echoed prefix, which is not a release", async () => {
		const echoed = `<ListBucketResult><Prefix>release/</Prefix>
			<CommonPrefixes><Prefix>release/2026-08-19.0/</Prefix></CommonPrefixes></ListBucketResult>`

		expect(await listOvertureReleases(clientReturning(echoed))).toEqual(["2026-08-19.0"])
	})

	it("follows the continuation token, so a bucket past S3's 1,000-key page reports every release", async () => {
		const pages = [
			`<ListBucketResult><IsTruncated>true</IsTruncated><NextContinuationToken>page-2</NextContinuationToken>
				<CommonPrefixes><Prefix>release/2026-07-22.0/</Prefix></CommonPrefixes></ListBucketResult>`,
			`<ListBucketResult><IsTruncated>false</IsTruncated>
				<CommonPrefixes><Prefix>release/2026-08-19.0/</Prefix></CommonPrefixes></ListBucketResult>`,
		]

		const seen: Array<string | undefined> = []

		const paging = {
			fetch: async (request: { params?: Record<string, string | number> }) => {
				seen.push(request.params?.["continuation-token"] as string | undefined)

				return { data: pages[seen.length - 1]! }
			},
		} satisfies OvertureListingClient

		expect(await listOvertureReleases(paging)).toEqual(["2026-07-22.0", "2026-08-19.0"])
		expect(seen).toEqual([undefined, "page-2"])
	})

	it("refuses a truncated listing that carries no continuation token rather than reporting a short list", async () => {
		const truncated = `<ListBucketResult><IsTruncated>true</IsTruncated>
			<CommonPrefixes><Prefix>release/2026-07-22.0/</Prefix></CommonPrefixes></ListBucketResult>`

		await expect(listOvertureReleases(clientReturning(truncated))).rejects.toThrow(/NextContinuationToken/)
	})
})

describe("the empty listing", () => {
	it("is read as NO ANSWER, never as a pruned release — a dropped query parameter looks exactly like this", async () => {
		const check = await checkOvertureRelease("2026-07-22.0", clientReturning("<ListBucketResult></ListBucketResult>"))

		expect(check.present).toBe(true)
		expect(check.reachable).toBe(false)
		expect(check.message).not.toContain("PRUNED")
		expect(check.message).toContain("NOT confirmation")
	})
})

describe("checkOvertureRelease", () => {
	it("confirms a present release and names what else is available", async () => {
		const check = await checkOvertureRelease("2026-07-22.0", clientReturning(LISTING))

		expect(check.present).toBe(true)
		expect(check.reachable).toBe(true)
		expect(check.message).toContain("2026-08-19.0")
	})

	it("reports a pruned pin as pruned, and says the bump is a vintage decision", async () => {
		const check = await checkOvertureRelease("2026-06-17.0", clientReturning(LISTING))

		expect(check.present).toBe(false)
		expect(check.message).toContain("PRUNED")
		expect(check.message).toContain("new-vintage decision")
	})

	it("PROCEEDS when the bucket is unreachable, and does not claim the release was verified", async () => {
		const check = await checkOvertureRelease("2026-07-22.0", clientThrowing("getaddrinfo ENOTFOUND"))

		expect(check.present).toBe(true)
		expect(check.reachable).toBe(false)
		expect(check.message).toContain("NOT confirmation")
	})
})
