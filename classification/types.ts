/**
 * @copyright Teffen Ellis
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { AdjacentClassification } from "./AdjacentClassification.js"
import { AlphaClassification } from "./AlphaClassification.js"
import { AlphaNumericClassification } from "./AlphaNumericClassification.js"
import { AreaClassification } from "./AreaClassification.js"
import { ChainClassification } from "./ChainClassification.js"
import { Classification, ExtractClassificationLabel } from "./Classification.js"
import { CountryClassification } from "./CountryClassification.js"
import { DependencyClassification } from "./DependencyClassification.js"
import { DirectionalClassification } from "./DirectionalClassification.js"
import { EndTokenClassification } from "./EndTokenClassification.js"
import { EndTokenSingleCharacterClassification } from "./EndTokenSingleCharacterClassification.js"
import { GivenNameClassification } from "./GivenNameClassification.js"
import { HouseNumberClassification } from "./HouseNumberClassification.js"
import { IntersectionClassification } from "./IntersectionClassification.js"
import { LevelClassification } from "./LevelClassification.js"
import { LevelTypeClassification } from "./LevelTypeClassification.js"
import { LocalityClassification } from "./LocalityClassification.js"
import { MiddleInitialClassification } from "./MiddleInitialClassification.js"
import { MultiStreetClassification } from "./MultiStreetClassification.js"
import { NumericClassification } from "./NumericClassification.js"
import { OrdinalClassification } from "./OrdinalClassification.js"
import { PersonalSuffixClassification } from "./PersonalSuffixClassification.js"
import { PersonalTitleClassification } from "./PersonalTitleClassification.js"
import { PersonClassification } from "./PersonClassification.js"
import { PlaceClassification } from "./PlaceClassification.js"
import { PostcodeClassification } from "./PostcodeClassification.js"
import { PunctuationClassification } from "./PunctuationClassification.js"
import { RegionClassification } from "./RegionClassification.js"
import { RoadTypeClassification } from "./RoadTypeClassification.js"
import { StartTokenClassification } from "./StartTokenClassification.js"
import { StopWordClassification } from "./StopWordClassification.js"
import { StreetClassification } from "./StreetClassification.js"
import { StreetNameClassification } from "./StreetNameClassification.js"
import { StreetPrefixClassification } from "./StreetPrefixClassification.js"
import { StreetProperNameClassification } from "./StreetProperNameClassification.js"
import { StreetSuffixClassification } from "./StreetSuffixClassification.js"
import { SurnameClassification } from "./SurnameClassification.js"
import { ToponymClassification } from "./ToponymClassification.js"
import { UnitClassification } from "./UnitClassification.js"
import { UnitTypeClassification } from "./UnitTypeClassification.js"
import { VenueClassification } from "./VenueClassification.js"

export type PluckClassificationLabel<T extends Classification> = T["label"]

export const labels = [
	AdjacentClassification,
	AlphaClassification,
	AlphaNumericClassification,
	AreaClassification,
	ChainClassification,
	CountryClassification,
	DependencyClassification,
	DirectionalClassification,
	EndTokenClassification,
	EndTokenSingleCharacterClassification,
	GivenNameClassification,
	HouseNumberClassification,
	IntersectionClassification,
	LevelClassification,
	LevelTypeClassification,
	LocalityClassification,
	MiddleInitialClassification,
	MultiStreetClassification,
	NumericClassification,
	OrdinalClassification,
	PersonalSuffixClassification,
	PersonalTitleClassification,
	PersonClassification,
	PlaceClassification,
	PostcodeClassification,
	PunctuationClassification,
	RegionClassification,
	RoadTypeClassification,
	StartTokenClassification,
	StopWordClassification,
	StreetClassification,
	StreetNameClassification,
	StreetPrefixClassification,
	StreetProperNameClassification,
	StreetSuffixClassification,
	SurnameClassification,
	ToponymClassification,
	UnitClassification,
	UnitTypeClassification,
	VenueClassification,
] as const

/**
 * Publicized classification labels.
 */
export type PublicClassificationLabel = ExtractClassificationLabel<(typeof labels)[number]>

export type ClassificationMap = Map<PublicClassificationLabel, string | undefined>
export type ClassificationRecord = Record<PublicClassificationLabel, string | undefined>
