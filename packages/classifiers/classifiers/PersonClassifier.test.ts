/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { assertClassification } from "../../../sdk/test/index.js"
import { PersonClassifier } from "./PersonClassifier.js"

const classifier = await new PersonClassifier().ready()

assertClassification(classifier, "person", [
	["Martin Luther King", ["all"]],
	["m l k", ["all"]],
	["MLK", ["all"]],
	["John Fitzgerald Kennedy", ["all"]],
	["j f k", ["all"]],
	["JFK", ["all"]],
	["cdg", ["fr"]],
	["Charles De Gaulle", ["fr"]],
])
