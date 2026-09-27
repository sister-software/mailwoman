/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Run from the repository root:
 *   node packages/filer/lib/tools/reference-oracle.run.ts packages/filer/test-fixtures/edgar/*.htm
 */

import { prettyJSON } from "@mailwoman/core/json"
import { cliArguments } from "@mailwoman/core/scripting/arguments"

import { analyzeReferenceDocument } from "./oracle.ts"

const paths = cliArguments()

if (!paths.length) {
	throw new Error("reference-oracle.run.ts requires at least one Exhibit 21 document path")
}

const results = await Promise.all(paths.toSorted().map(analyzeReferenceDocument))

console.log(prettyJSON(results, false, 1))
