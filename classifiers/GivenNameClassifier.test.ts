/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { assertClassification } from "mailwoman/sdk/test"
import { GivenNameClassifier } from "./GivenNameClassifier.js"

const classifier = await new GivenNameClassifier().ready()

assertClassification(classifier, "given_name", [
	["Anderson Luís", ["all"]],
	["Peter", ["all"]],
])
