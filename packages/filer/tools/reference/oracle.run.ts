// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   Run from the repository root: node
 *   packages/filer/tools/reference-oracle.run.ts packages/filer/test-fixtures/edgar/*.htm
 */

import { cliArguments } from "@mailwoman/core/scripting/arguments"
import { prettyJSON } from "@mailwoman/core/values/json"

import { analyzeReferenceDocument } from "./oracle.ts"

const paths = cliArguments()

if (!paths.length) {
	throw new Error("reference-oracle.run.ts requires at least one Exhibit 21 document path")
}

const results = await Promise.all(paths.toSorted().map(analyzeReferenceDocument))

console.log(prettyJSON(results, false, 1))
