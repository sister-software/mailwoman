/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { assertClassification } from "mailwoman/sdk/test"
import { StreetProperNameClassifier } from "./StreetProperNameClassifier.js"

const classifier = new StreetProperNameClassifier()

assertClassification(classifier, "street_proper_name", [
	["broadway", ["en"]],
	["esplanade", ["en"]],
])
