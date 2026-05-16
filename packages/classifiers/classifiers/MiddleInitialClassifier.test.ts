/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { assertClassification } from "../../../sdk/test/index.js"
import { MiddleInitialClassifier } from "./MiddleInitialClassifier.js"

const classifier = new MiddleInitialClassifier()

assertClassification(classifier, "middle_initial", [
	["M", ["en"]],
	["M.", ["en"]],
])

assertClassification(classifier, "middle_initial", [
	["Mae", [], false],
	["122", [], false],
	["M,", [], false],
	["&", [], false],
	["Mr", [], false],
	["Esq", [], false],
])
