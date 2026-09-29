/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { expect, test } from "vitest"

import { BODY_CONFIGS } from "#bodies/index"
import { PLANETARY_BODIES } from "#body"

test.each([...PLANETARY_BODIES])("%s: the config names its own body, host, tilesets and identity", (body) => {
	const config = BODY_CONFIGS[body]

	expect(config.body).toBe(body)
	expect(config.hostname).toBe(`${body}.mailwoman.ai`)
	expect(config.tiles.nomenclature).toMatch(new RegExp(`/${body}\\.json$`, "u"))
	// `-terrain`, not `-hillshade`: the archive stores terrarium-encoded elevation
	// rather than a shaded picture.
	// A cache cannot distinguish the two, so the new content took a new name.
	expect(config.tiles.hillshade).toMatch(new RegExp(`/${body}-terrain\\.json$`, "u"))
	expect(config.identity.origin).toBe(`https://${config.hostname}/`)
	expect(config.artifacts.version).toMatch(/^\d{8}-[0-9a-f]{8}$/u)
	expect(config.artifacts.searchIndexURL).toContain(`/planetary/${body}/${config.artifacts.version}/`)
	expect(config.artifacts.manifestURL).toContain(`/planetary/${body}/${config.artifacts.version}/`)
})

test("the two identities are distinct, so the installations are", () => {
	expect(BODY_CONFIGS.moon.identity.origin).not.toBe(BODY_CONFIGS.mars.identity.origin)
	expect(BODY_CONFIGS.moon.identity.themeColor).not.toBe(BODY_CONFIGS.mars.identity.themeColor)
})
