// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { describe, expect, test } from "vitest"

import { findReleaseVersionLiterals } from "./release-version-literals.mts"

describe("findReleaseVersionLiterals", () => {
	test("reports package, image and build-argument versions inside a fence", () => {
		const source = [
			"```bash",
			"npm install mailwoman@11.0.0 @mailwoman/neural@11.0.0 onnxruntime-web@1.31.1",
			"podman pull ghcr.io/sister-software/mailwoman:11.1.0",
			"podman build --build-arg MAILWOMAN_VERSION=11.1.0 .",
			"```",
		].join("\n")

		expect(findReleaseVersionLiterals(source)).toEqual([
			{ line: 2, literal: "mailwoman@11.0.0" },
			{ line: 2, literal: "@mailwoman/neural@11.0.0" },
			{ line: 3, literal: "sister-software/mailwoman:11.1.0" },
			{ line: 4, literal: "MAILWOMAN_VERSION=11.1.0" },
		])
	})

	test("leaves prose, inline code and tokens alone", () => {
		const source = [
			"Checked with published `mailwoman@11.0.0` on 9 November 2026.",
			"",
			"````md",
			"```",
			"```",
			"npm install mailwoman@{{release.version}}",
			"````",
			"mailwoman@11.0.0 after the fence closes",
		].join("\n")

		expect(findReleaseVersionLiterals(source)).toEqual([])
	})
})
