/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { assertClassification } from "mailwoman/sdk/test"
import { UnitDesignatorClassifier } from "./UnitDesignatorClassifier.js"

const classifier = await new UnitDesignatorClassifier().ready()

assertClassification(classifier, "unit_designator", [
	["unit", ["en"]],
	["apt", ["en"]],
	["lot", ["en"]],
])
