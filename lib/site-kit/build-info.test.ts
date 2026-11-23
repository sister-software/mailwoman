// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { tryParsingJSON } from "@mailwoman/core/values/json"
import { expect, test } from "vitest"

import { renderBuildInfo } from "#site-kit/build-info"

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
