/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { assertClassification } from "../../../sdk/test/index.js"
import { SurnameClassifier } from "./SurnameClassifier.js"

const classifier = await new SurnameClassifier().ready()

assertClassification(classifier, "surname", [
	["Van der Beugel", ["all"]],
	["Johnson", ["all"]],
])
