/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { assertClassification } from "../../../sdk/test/index.js"
import { StopWordClassifier } from "./StopWordClassifier.js"

const classifier = await new StopWordClassifier().ready()

assertClassification(classifier, "stop_word", [
	["de", ["fr"]],
	["la", ["fr"]],
	["l'", ["fr"]],
	["du", ["fr"]],
	["à", ["fr"]],
	["sur", ["fr"]],
])
