/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { assertClassification } from "mailwoman/test-kit"

import { SurnameClassifier } from "./SurnameClassifier.ts"

const classifier = await new SurnameClassifier().ready()

assertClassification(classifier, "surname", [
	["Van der Beugel", ["all"]],
	["Johnson", ["all"]],
])
