/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { tryParsingJSON } from "@mailwoman/core/json"
import { renderBuildInfo } from "@mailwoman/site-kit/build-info"
import { expect, test } from "vitest"

test("renderBuildInfo emits the three fields as tab-indented JSON with a trailing newline", () => {
	// `app` is any string: the planetary builds write "mailwoman-moon" and "mailwoman-mars" through the same function.
	const text = renderBuildInfo({ app: "mailwoman-earth", revision: "abc1234", buildTime: "2026-09-07T10:00:00Z" })

	expect(tryParsingJSON(text)).toEqual({
		app: "mailwoman-earth",
		revision: "abc1234",
		buildTime: "2026-09-07T10:00:00Z",
	})
	expect(text.endsWith("\n")).toBe(true)
})
