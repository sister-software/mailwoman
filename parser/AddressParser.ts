/**
 * @copyright Teffen Ellis
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import AlphaNumericClassifier from "../classifier/AlphaNumericClassifier.js"
import CentralEuropeanStreetNameClassifier from "../classifier/CentralEuropeanStreetNameClassifier.js"
import ChainClassifier from "../classifier/ChainClassifier.js"
import CompositeClassifier from "../classifier/CompositeClassifier.js"
import CompoundStreetClassifier from "../classifier/CompoundStreetClassifier.js"
import DirectionalClassifier from "../classifier/DirectionalClassifier.js"
import GivenNameClassifier from "../classifier/GivenNameClassifier.js"
import HouseNumberClassifier from "../classifier/HouseNumberClassifier.js"
import IntersectionClassifier from "../classifier/IntersectionClassifier.js"
import MiddleInitialClassifier from "../classifier/MiddleInitialClassifier.js"
import OrdinalClassifier from "../classifier/OrdinalClassifier.js"
import PersonalSuffixClassifier from "../classifier/PersonalSuffixClassifier.js"
import PersonalTitleClassifier from "../classifier/PersonalTitleClassifier.js"
import PersonClassifier from "../classifier/PersonClassifier.js"
import PlaceClassifier from "../classifier/PlaceClassifier.js"
import PostcodeClassifier from "../classifier/PostcodeClassifier.js"
import RoadTypeClassifier from "../classifier/RoadTypeClassifier.js"
import StopWordClassifier from "../classifier/StopWordClassifier.js"
import StreetPrefixClassifier from "../classifier/StreetPrefixClassifier.js"
import StreetProperNameClassifier from "../classifier/StreetProperNameClassifier.js"
import StreetSuffixClassifier from "../classifier/StreetSuffixClassifier.js"
import SurnameClassifier from "../classifier/SurnameClassifier.js"
import TokenPositionClassifier from "../classifier/TokenPositionClassifier.js"
import ToponymClassifier from "../classifier/ToponymClassifier.js"
import WhosOnFirstClassifier from "../classifier/WhosOnFirstClassifier.js"

import IntersectionScheme from "../classifier/scheme/intersection.js"
import PersonScheme from "../classifier/scheme/person.js"
import StreetScheme from "../classifier/scheme/street.js"
import StreetNameScheme from "../classifier/scheme/street_name.js"
import VenueScheme from "../classifier/scheme/venue.js"

import ExclusiveCartesianSolver from "../solver/ExclusiveCartesianSolver.js"
import HouseNumberPositionPenalty from "../solver/HouseNumberPositionPenalty.js"
import InvalidSolutionFilter from "../solver/InvalidSolutionFilter.js"
import LeadingAreaDeclassifier from "../solver/LeadingAreaDeclassifier.js"
import MultiStreetSolver from "../solver/MultiStreetSolver.js"
import MustNotFollowFilter from "../solver/MustNotFollowFilter.js"
import MustNotPreceedFilter from "../solver/MustNotPreceedFilter.js"
import OrphanedUnitTypeDeclassifier from "../solver/OrphanedUnitTypeDeclassifier.js"
import PostcodePositionPenalty from "../solver/PostcodePositionPenalty.js"
import SubsetFilter from "../solver/SubsetFilter.js"
import TokenDistanceFilter from "../solver/TokenDistanceFilter.js"

import { LevelClassifier } from "../classifier/LevelClassifier.js"
import { LevelTypeClassifier } from "../classifier/LevelTypeClassifier.js"
import { LevelTypeLevelClassifier } from "../classifier/LevelTypeLevelClassifier.js"
import { UnitClassifier } from "../classifier/UnitClassifier.js"
import { UnitTypeClassifier } from "../classifier/UnitTypeClassifier.js"
import { UnitTypeUnitClassifier } from "../classifier/UnitTypeUnitClassifier.js"
import { OrphanedLevelTypeDeclassifier } from "../solver/OrphanedLevelTypeDeclassifier.js"
import Parser, { ParserOptions } from "./Parser.js"

export class AddressParser extends Parser {
	constructor(options: Partial<ParserOptions> = {}) {
		super(
			// classifiers
			[
				// generic word classifiers
				new AlphaNumericClassifier(),
				new LevelTypeLevelClassifier(),
				new UnitTypeUnitClassifier(),
				new TokenPositionClassifier(),

				// word classifiers
				new LevelTypeClassifier(),
				new UnitTypeClassifier(),
				new HouseNumberClassifier(),
				new LevelClassifier(),
				new UnitClassifier(),
				new PostcodeClassifier(),
				new StreetPrefixClassifier(),
				new StreetSuffixClassifier(),
				new StreetProperNameClassifier(),
				new RoadTypeClassifier(),
				new ToponymClassifier(),
				new CompoundStreetClassifier(),
				new DirectionalClassifier(),
				new OrdinalClassifier(),
				new StopWordClassifier(),

				// phrase classifiers
				new IntersectionClassifier(),
				new PersonClassifier(),
				new GivenNameClassifier(),
				new SurnameClassifier(),
				new MiddleInitialClassifier(),
				new PersonalSuffixClassifier(),
				new PersonalTitleClassifier(),
				new ChainClassifier(),
				new PlaceClassifier(),
				new WhosOnFirstClassifier(),

				// composite classifiers
				new CompositeClassifier(PersonScheme),
				new CompositeClassifier(StreetNameScheme),
				new CompositeClassifier(StreetScheme),
				new CompositeClassifier(VenueScheme),
				new CompositeClassifier(IntersectionScheme),

				// additional classifiers which act on unclassified tokens
				new CentralEuropeanStreetNameClassifier(),
			],
			// solvers
			[
				new ExclusiveCartesianSolver(),
				new LeadingAreaDeclassifier(),
				new MultiStreetSolver(),
				new SubsetFilter(),
				new InvalidSolutionFilter([
					["HouseNumberClassification", "LocalityClassification"],
					["HouseNumberClassification", "LocalityClassification", "RegionClassification"],
					["HouseNumberClassification", "LocalityClassification", "CountryClassification"],
					["HouseNumberClassification", "LocalityClassification", "RegionClassification", "CountryClassification"],
					["HouseNumberClassification", "RegionClassification"],
					["HouseNumberClassification", "RegionClassification", "CountryClassification"],
					["HouseNumberClassification", "CountryClassification"],
					["HouseNumberClassification", "PostcodeClassification"],
					["HouseNumberClassification", "PostcodeClassification", "LocalityClassification"],
					["HouseNumberClassification", "PostcodeClassification", "RegionClassification"],
					["HouseNumberClassification", "PostcodeClassification", "CountryClassification"],
					["VenueClassification", "HouseNumberClassification"],
					["VenueClassification", "PostcodeClassification"],
				]),
				new MustNotFollowFilter("VenueClassification", "HouseNumberClassification"),
				new MustNotFollowFilter("VenueClassification", "StreetClassification"),
				new MustNotFollowFilter("VenueClassification", "LocalityClassification"),
				new MustNotFollowFilter("VenueClassification", "RegionClassification"),
				new MustNotFollowFilter("VenueClassification", "CountryClassification"),
				new MustNotFollowFilter("VenueClassification", "PostcodeClassification"),
				new MustNotPreceedFilter("PostcodeClassification", "HouseNumberClassification"),
				new MustNotPreceedFilter("PostcodeClassification", "StreetClassification"),
				new MustNotPreceedFilter("LocalityClassification", "HouseNumberClassification"),
				new MustNotPreceedFilter("LocalityClassification", "StreetClassification"),
				new MustNotPreceedFilter("RegionClassification", "HouseNumberClassification"),
				new MustNotPreceedFilter("RegionClassification", "StreetClassification"),
				new MustNotPreceedFilter("CountryClassification", "RegionClassification"),
				new MustNotPreceedFilter("CountryClassification", "LocalityClassification"),
				new MustNotPreceedFilter("CountryClassification", "PostcodeClassification"),
				new MustNotPreceedFilter("CountryClassification", "StreetClassification"),
				new MustNotPreceedFilter("CountryClassification", "HouseNumberClassification"),
				new MustNotPreceedFilter("VenueClassification", "LevelClassification"),
				new MustNotPreceedFilter("VenueClassification", "UnitClassification"),
				new MustNotFollowFilter("LocalityClassification", "RegionClassification"),
				new MustNotFollowFilter("LocalityClassification", "CountryClassification"),
				new HouseNumberPositionPenalty(),
				new PostcodePositionPenalty(),
				new TokenDistanceFilter(),
				new OrphanedLevelTypeDeclassifier(),
				new OrphanedUnitTypeDeclassifier(),
				new SubsetFilter(),
			],
			options
		)
	}
}
