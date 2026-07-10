// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { assertClassification } from "mailwoman/sdk/test"

import { CompoundStreetClassifier } from "./CompoundStreetClassifier.ts"

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
