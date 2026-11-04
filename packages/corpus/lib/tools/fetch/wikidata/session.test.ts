/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { describe, expect, it } from "vitest"

import { botCredentialsFrom, redactCredentials, SessionCookies } from "#tools/fetch/wikidata/session"

describe("botCredentialsFrom", () => {
	it("reads both values as a login and neither as anonymous", () => {
		expect(botCredentialsFrom("Mailwoman@vital", "s3cret")).toEqual({ username: "Mailwoman@vital", password: "s3cret" })
		expect(botCredentialsFrom(undefined, undefined)).toBeNull()
	})

	it("refuses one value without the other, and a username without its app part", () => {
		expect(() => botCredentialsFrom("Mailwoman@vital", undefined)).toThrow(/together/u)
		expect(() => botCredentialsFrom(undefined, "s3cret")).toThrow(/together/u)
		expect(() => botCredentialsFrom("Mailwoman", "s3cret")).toThrow(/Name@app/u)
	})
})

describe("redactCredentials", () => {
	it("replaces the password and username, raw and URL-encoded", () => {
		const credentials = { username: "Mailwoman@vital", password: "p@ss word" }

		const text = redactCredentials(
			"lgname=Mailwoman%40vital&lgpassword=p%40ss%20word failed for Mailwoman@vital with p@ss word",
			credentials
		)

		expect(text).not.toContain("p@ss")
		expect(text).not.toContain("p%40ss")
		expect(text).not.toContain("Mailwoman")
	})
})

describe("SessionCookies", () => {
	it("keeps each cookie's value, replaces it on a later Set-Cookie and drops an expired one", () => {
		const cookies = new SessionCookies()

		expect(cookies.header()).toBeNull()

		cookies.absorb(["wikidatawikiSession=abc; path=/; secure; HttpOnly", "GeoIP=GB:::; Path=/"])
		cookies.absorb("wikidatawikiSession=def; path=/")

		expect(cookies.header()).toBe("wikidatawikiSession=def; GeoIP=GB:::")

		cookies.absorb("GeoIP=deleted; expires=Thu, 01 Jan 1970 00:00:01 GMT", Date.UTC(2026, 10, 4))
		cookies.absorb("wikidatawikiSession=gone; Max-Age=0")

		expect(cookies.size).toBe(0)
	})
})
