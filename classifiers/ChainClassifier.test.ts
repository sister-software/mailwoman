/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { assertClassification } from "mailwoman/test-kit"

import { ChainClassifier } from "./ChainClassifier.ts"

const classifier = await new ChainClassifier().ready()

assertClassification(classifier, "chain", [
	["McDonalds", ["all"]],
	["McDonald's", ["all"]],
	["lone star steakhouse", ["all"]],
	["panda express", ["all"]],
])
