/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { assertClassification } from "mailwoman/test-kit"

import { GivenNameClassifier } from "./GivenNameClassifier.ts"

const classifier = await new GivenNameClassifier().ready()

assertClassification(classifier, "given_name", [
	["Anderson Luís", ["all"]],
	["Peter", ["all"]],
])
