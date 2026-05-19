/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { assertClassification } from "mailwoman/sdk/test"
import { PersonalSuffixClassifier } from "./PersonalSuffixClassifier.js"

const classifier = await new PersonalSuffixClassifier().ready()

assertClassification(classifier, "personal_suffix", [
	["junior", ["es", "en", "pt", "nl"]],
	["jr", ["es", "en", "pt", "nl"]],
	["senior", ["en", "nl"]],
	["sr", ["en", "nl"]],
])
