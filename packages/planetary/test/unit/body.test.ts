/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { assertHostMatchesBody, bodyForHostname } from "@mailwoman/planetary/body"
import { expect, test } from "vitest"

test.each([
	["moon.mailwoman.ai", "moon"],
	["mars.mailwoman.ai", "mars"],
	["localhost", "moon"],
	["localhost", "mars"],
	["moon.mailwoman.ai.preview.example", "moon"],
] as const)("%s serves a %s build", (hostname, body) => {
	expect(() => assertHostMatchesBody(hostname, body)).not.toThrow()
})

test("a production host serving the other body's build fails, naming both", () => {
	expect(() => assertHostMatchesBody("mars.mailwoman.ai", "moon")).toThrow(/mars\.mailwoman\.ai.*moon/u)
})

test("only the two production hostnames name a body", () => {
	expect(bodyForHostname("moon.mailwoman.ai")).toBe("moon")
	expect(bodyForHostname("mars.mailwoman.ai")).toBe("mars")
	expect(bodyForHostname("localhost")).toBeNull()
	expect(bodyForHostname("earth.mailwoman.ai")).toBeNull()
})
