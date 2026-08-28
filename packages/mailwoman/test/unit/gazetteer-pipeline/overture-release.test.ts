/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Tests for the Overture release pre-flight. The required case is the UNREACHABLE bucket: this check exists to
 *   turn a slow failure into a fast one, so letting its own network trouble block a build would be a worse trade than
 *   the problem it solves. It must proceed, and must not claim the release was verified.
 */

import { checkOvertureRelease, listOvertureReleases } from "mailwoman/gazetteer-pipeline/overture-release"
import { describe, expect, it } from "vitest"

/**
 * Minimal stand-in for the bucket listing — only `fetch` is reached.
 */
const clientReturning = (body: string) =>
	({ fetch: async () => ({ data: body, status: 200 }) }) as unknown as Parameters<typeof listOvertureReleases>[0]

const clientThrowing = (message: string) =>
	({
		fetch: async () => {
			throw new Error(message)
		},
	}) as unknown as Parameters<typeof listOvertureReleases>[0]

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
