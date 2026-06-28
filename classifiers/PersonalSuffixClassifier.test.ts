// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { assertClassification } from "mailwoman/sdk/test"

import { PersonalSuffixClassifier } from "./PersonalSuffixClassifier.js"

const classifier = await new PersonalSuffixClassifier().ready()

assertClassification(classifier, "personal_suffix", [
	["junior", ["es", "en", "pt", "nl"]],
	["jr", ["es", "en", "pt", "nl"]],
	["senior", ["en", "nl"]],
	["sr", ["en", "nl"]],
])
