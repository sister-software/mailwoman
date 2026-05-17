// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

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
