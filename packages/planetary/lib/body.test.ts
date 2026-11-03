/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { expect, test } from "vitest"

import { assertHostMatchesBody, bodyForHostname } from "#body"

test.each([
	["moon.mailwoman.post", "moon"],
	["mars.mailwoman.post", "mars"],
	["localhost", "moon"],
	["localhost", "mars"],
	["moon.mailwoman.post.preview.example", "moon"],
] as const)("%s serves a %s build", (hostname, body) => {
	expect(() => assertHostMatchesBody(hostname, body)).not.toThrow()
})

test("a production host serving the other body's build fails, naming both", () => {
	expect(() => assertHostMatchesBody("mars.mailwoman.post", "moon")).toThrow(/mars\.mailwoman\.ai.*moon/u)
})

test("only the two production hostnames name a body", () => {
	expect(bodyForHostname("moon.mailwoman.post")).toBe("moon")
	expect(bodyForHostname("mars.mailwoman.post")).toBe("mars")
	expect(bodyForHostname("localhost")).toBeNull()
	expect(bodyForHostname("earth.mailwoman.post")).toBeNull()
})
