/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { tryParsingJSON } from "@mailwoman/core/json"
import { commitURL, renderBuildInfo } from "@mailwoman/site-kit/build-info"
import { expect, test } from "vitest"

const COMMIT = "b66844633779c8cd8c22447f19259ec03a2121de"

test("renderBuildInfo emits the four fields as tab-indented JSON with a trailing newline", () => {
	// `app` is any string: the planetary builds write "mailwoman-moon" and "mailwoman-mars" through the same function.
	const text = renderBuildInfo({
		app: "mailwoman-earth",
		revision: "abc1234",
		commit: COMMIT,
		buildTime: "2026-09-07T10:00:00Z",
	})

	expect(tryParsingJSON(text)).toEqual({
		app: "mailwoman-earth",
		revision: "abc1234",
		commit: COMMIT,
		buildTime: "2026-09-07T10:00:00Z",
	})

	expect(text.endsWith("\n")).toBe(true)
})

test("revision and commit are the same revision at two lengths", () => {
	// The pair exists because a production smoke reads `revision` and compares it against a short form, while a
	// commit URL wants the whole thing. A build writing two different revisions would be a defect this names.
	const text = renderBuildInfo({
		app: "mailwoman-earth",
		revision: COMMIT.slice(0, 7),
		commit: COMMIT,
		buildTime: "2026-09-07T10:00:00Z",
	})

	const info = tryParsingJSON<{ revision: string; commit: string }>(text)!

	expect(info.commit.startsWith(info.revision)).toBe(true)
})

test("commitURL names the repository's commit page", () => {
	expect(commitURL(COMMIT)).toBe(`https://github.com/sister-software/mailwoman/commit/${COMMIT}`)
})
