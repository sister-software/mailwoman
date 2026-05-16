/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { assertClassification } from "../../../sdk/test/index.js"
import { CompoundStreetClassifier } from "./CompoundStreetClassifier.js"

const classifier = await new CompoundStreetClassifier().ready()

assertClassification(classifier, "street", [
	["teststraße", ["de"]],
	["teststrasse", ["de"]],
	["teststr.", ["de", "nl"]],
	["teststr", ["de"]],
	["grolmanstr", ["de"]],
	["testallee", ["de"]],
	["testweg", ["de", "nl"]],
	["testplatz", ["de"]],
	["testpl.", ["sv", "de", "nb"]],
	["testvägen", ["sv"]],
	["testal", [], false],
	["testw", [], false],
	["testw.", [], false],
])
