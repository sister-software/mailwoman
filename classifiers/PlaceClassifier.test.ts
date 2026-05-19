/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { assertClassification } from "mailwoman/sdk/test"
import { PlaceClassifier } from "./PlaceClassifier.js"

const classifier = await new PlaceClassifier().ready()

assertClassification(classifier, "place", [
	["stables", ["en"]],
	["swimming pool", ["en"]],
	["cafe", ["en", "fr", "de"]],
	["bar", ["en", "fr", "de"]],
])
