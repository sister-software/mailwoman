/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import {
	AlphaNumericClassifier,
	CentralEuropeanStreetNameClassifier,
	ChainClassifier,
	CompositeIntersectionClassifier,
	CompositePersonClassifier,
	CompositeStreetClassifier,
	CompositeStreetNameClassifier,
	CompositeVenueClassifier,
	CompoundLevelClassifier,
	CompoundStreetClassifier,
	CompoundUnitDesignatorClassifier,
	DirectionalClassifier,
	GivenNameClassifier,
	HouseNumberClassifier,
	IntersectionClassifier,
	LevelClassifier,
	LevelDesignatorClassifier,
	MiddleInitialClassifier,
	OrdinalClassifier,
	PersonalSuffixClassifier,
	PersonalTitleClassifier,
	PersonClassifier,
	PlaceClassifier,
	PostcodeClassifier,
	RoadTypeClassifier,
	StopWordClassifier,
	StreetPrefixClassifier,
	StreetProperNameClassifier,
	StreetSuffixClassifier,
	SubdivisionClassifier,
	SurnameClassifier,
	TokenPositionClassifier,
	ToponymClassifier,
	UnitClassifier,
	UnitDesignatorClassifier,
	WhosOnFirstClassifier,
} from "@mailwoman/classifiers"
import { InvalidSolutionFilter, RelationshipFilter, SubsetFilter, TokenDistanceFilter } from "@mailwoman/core/filters"
import { AddressParser, type AddressParserOptions } from "@mailwoman/core/parser"
import {
	ExclusiveCartesianSolver,
	HouseNumberPositionPenalty,
	LeadingAreaDeclassifier,
	MultiStreetSolver,
	OrphanedLevelTypeDeclassifier,
	OrphanedUnitTypeDeclassifier,
	PostcodePositionPenalty,
	VenueCaptureSolver,
} from "@mailwoman/core/solvers"

/**
 * Create an address parser with the given options.
 *
 * This is the primary entry point for the Mailwoman library.
 */
export function createAddressParser({ classifiers, solvers, ...options }: AddressParserOptions = {}): AddressParser {
	const addressParser = new AddressParser({
		classifiers: [
			...(classifiers ?? []),
			// generic word classifiers
			AlphaNumericClassifier,
			CompoundLevelClassifier,
			CompoundUnitDesignatorClassifier,
			TokenPositionClassifier,

			// word classifiers

			LevelDesignatorClassifier,
			UnitDesignatorClassifier,
			HouseNumberClassifier,
			LevelClassifier,
			UnitClassifier,
			new PostcodeClassifier(),
			StreetPrefixClassifier,
			StreetSuffixClassifier,
			StreetProperNameClassifier,
			RoadTypeClassifier,
			ToponymClassifier,
			CompoundStreetClassifier,
			DirectionalClassifier,
			OrdinalClassifier,
			StopWordClassifier,

			// phrase classifiers
			IntersectionClassifier,
			PersonClassifier,
			GivenNameClassifier,
			SurnameClassifier,
			MiddleInitialClassifier,
			PersonalSuffixClassifier,
			PersonalTitleClassifier,
			ChainClassifier,
			PlaceClassifier,
			WhosOnFirstClassifier,

			// composite classifiers
			CompositePersonClassifier,
			CompositeStreetNameClassifier,
			CompositeStreetClassifier,
			CompositeVenueClassifier,
			CompositeIntersectionClassifier,
			SubdivisionClassifier,

			// additional classifiers which act on unclassified tokens
			CentralEuropeanStreetNameClassifier,
		],
		solvers: [
			...(solvers ?? []),
			ExclusiveCartesianSolver,
			LeadingAreaDeclassifier,
			MultiStreetSolver,
			VenueCaptureSolver,
			SubsetFilter,

			new InvalidSolutionFilter(
				["house_number", "locality"],
				["house_number", "locality", "region"],
				["house_number", "locality", "country"],
				["house_number", "locality", "region", "country"],
				["house_number", "region"],
				["house_number", "region", "country"],
				["house_number", "country"],
				["house_number", "postcode"],
				["house_number", "postcode", "locality"],
				["house_number", "postcode", "region"],
				["house_number", "postcode", "country"],
				["venue", "house_number"],
				["venue", "postcode"]
			),

			new RelationshipFilter([
				["venue", "follows", "house_number"],
				["venue", "follows", "street"],
				["venue", "follows", "locality"],
				["venue", "follows", "region"],
				["venue", "follows", "country"],
				["venue", "follows", "postcode"],

				["postcode", "precedes", "house_number"],
				["postcode", "precedes", "street"],

				["locality", "precedes", "house_number"],
				["locality", "precedes", "street"],

				["region", "precedes", "house_number"],
				["region", "precedes", "street"],

				["country", "precedes", "region"],
				["country", "precedes", "locality"],
				["country", "precedes", "postcode"],
				["country", "precedes", "street"],
				["country", "precedes", "house_number"],

				["venue", "precedes", "level"],
				["venue", "precedes", "unit"],

				["locality", "follows", "region"],
				["locality", "follows", "country"],
			]),

			new HouseNumberPositionPenalty(),
			new PostcodePositionPenalty(),
			new TokenDistanceFilter(),
			new OrphanedLevelTypeDeclassifier(),
			new OrphanedUnitTypeDeclassifier(),
			new SubsetFilter(),
		],
		...options,
	})

	return addressParser
}
