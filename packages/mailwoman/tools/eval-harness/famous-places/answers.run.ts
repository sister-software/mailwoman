// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   Grades the famous-places test set by place answer for one model.
 *
 *   Usage:
 *   node packages/mailwoman/tools/eval-harness/famous-places/answers.run.ts [--weights-cache <root>] [--json <path>]
 */

import { parseArguments } from "@mailwoman/core/scripting/arguments"

import { scoreFamousPlaceAnswers } from "#tools/eval-harness/famous-places/answers"

const { values } = parseArguments({
	options: {
		"weights-cache": { type: "string" },
		file: { type: "string" },
		json: { type: "string" },
	},
})

const result = await scoreFamousPlaceAnswers({
	...(values["weights-cache"] ? { weightsCacheRoot: values["weights-cache"] } : {}),
	...(values.file ? { file: values.file } : {}),
	...(values.json ? { json: values.json } : {}),
})

if (result.status === "unread") {
	process.exitCode = 1
}
