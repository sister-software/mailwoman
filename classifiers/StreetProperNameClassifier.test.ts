/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { assertClassification } from "mailwoman/test-kit"

import { StreetProperNameClassifier } from "./StreetProperNameClassifier.ts"

const classifier = new StreetProperNameClassifier()

assertClassification(classifier, "street_proper_name", [
	["broadway", ["en"]],
	["esplanade", ["en"]],
])
