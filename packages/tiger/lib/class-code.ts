/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

/**
 * The MAF/TIGER Feature Class Code (MTFCC) of a geographic entity, as printed in
 * TIGER/Line files, gazetteer files and other Census Bureau products.
 *
 * The definition on each member paraphrases the Census Bureau's MTFCC table
 * at `https://www.census.gov/library/reference/code-lists/mt-feature-class-codes.html`.
 * Read that table for the authoritative wording.
 *
 * @title MAF/TIGER Feature Class Code
 */
export const TIGERClassCode = {
	/**
	 * A high point of land standing above the terrain around it.
	 */
	MountainPeakOrSummit: "C3022",

	/**
	 * Dry or mostly dry land with water or low wetland on every side.
	 *
	 * Covers archipelagos, atolls, cays, hammocks, hummocks, islas, isles, keys, mokus and rocks.
	 */
	Island: "C3023",

	/**
	 * A raised bank along a stream or other flowing water that keeps it from overflowing.
	 */
	Levee: "C3024",

	/**
	 * A permanent structure built out into a body of water to keep a shore from eroding,
	 * to enclose a sheltered marina or harbor, or to hold a navigation channel in place.
	 *
	 * Water does not pass beneath it.
	 * Water does pass beneath a pier or dock.
	 *
	 * Groins, seawalls and bulwarks belong to this class.
	 */
	JettyBreakwater: "C3025",

	/**
	 * A site where commercial minerals are or were extracted.
	 * Oil and gas fields are excluded.
	 */
	QuarryOpenPitMine: "C3026",

	/**
	 * A barrier across a stream that holds back water or regulates its flow.
	 */
	Dam: "C3027",

	/**
	 * A widened paved turnaround at the end of a street.
	 *
	 * Addressed structures along the street can continue around the turnaround.
	 */
	CulDeSac: "C3061",

	/**
	 * A circular junction of roads with continuous traffic flow, recorded as a point.
	 */
	TrafficCircle: "C3062",

	/**
	 * A barrier across a road that can be opened and closed.
	 */
	Check: "C3066",

	/**
	 * A structure or barrier at which drivers pay a fee to use a road.
	 */
	TollBooth: "C3067",

	/**
	 * A built structure taller than its diameter, used for observation, storage or electronic transmission.
	 */
	Tower: "C3071",

	/**
	 * A built structure taller than its diameter that emits light, and sometimes sound, as a navigation aid.
	 */
	LighthouseBeacon: "C3074",

	/**
	 * One or more built structures for storing or distributing liquid or gas.
	 */
	TankFarm: "C3075",

	/**
	 * A wind-power generating facility.
	 */
	WindmillFarm: "C3076",

	/**
	 * A solar-power generating facility.
	 */
	SolarFarm: "C3077",

	/**
	 * A built structure that commemorates an event, person or feature, or educates visitors about one.
	 */
	MonumentMemorial: "C3078",

	/**
	 * A marker placed on or beside a boundary line to fix and identify its position on the ground.
	 */
	BoundaryMonumentPoint: "C3079",

	/**
	 * A ground point with a known horizontal or vertical position that further surveys can start from.
	 */
	SurveyControlPoint: "C3080",

	/**
	 * A point giving the position and name of a locality, such as a crossroad,
	 * community, populated place or locale.
	 *
	 * The locality has no formally established boundary in the general case.
	 */
	LocalityPoint: "C3081",

	/**
	 * The point at the center of an Alaska Native village, used to delineate
	 * Alaska Native village statistical areas.
	 */
	AlaskaNativeVillageOfficialPoint: "C3085",

	/**
	 * A sovereign state recognized by the U.S. Department of State.
	 *
	 * The decennial census covers the United States, Puerto Rico and the Island Areas: American Samoa,
	 * Guam, the Commonwealth of the Northern Mariana Islands and the U.S. Virgin Islands.
	 * The class could hold other sovereign states such as Canada and Mexico, and at present holds neither.
	 */
	Nation: "G1000",

	/**
	 * A group of states plus the District of Columbia used to present census data.
	 *
	 * There are four Census Regions: Northeast, South, Midwest and West.
	 */
	CensusRegion: "G1100",

	/**
	 * A group of states plus the District of Columbia that subdivides one of the four Census Regions.
	 */
	CensusDivision: "G1200",

	/**
	 * A legally defined reservation or off-reservation trust land recognized by a state
	 * or the federal government.
	 *
	 * Statistical American Indian and Alaska Native areas are excluded.
	 */
	AmericanIndianArea: "G2100",

	/**
	 * Land the state of Hawaii holds in trust for Native Hawaiians under the Hawaiian
	 * Homes Commission Act of 1920, as amended.
	 */
	HawaiianHomeLand: "G2120",

	/**
	 * A statistical area covering the densely settled part of an Alaska Native village (ANV).
	 *
	 * An ANV is an association, band, clan, community, group, tribe or village recognized
	 * under the Alaska Native Claims Settlement Act of 1971 (Public Law 92-203).
	 */
	AlaskaNativeVillageStatisticalArea: "G2130",

	/**
	 * A statistical area the Census Bureau delineates with a federally recognized American
	 * Indian tribe that has no reservation today and had a former reservation in Oklahoma.
	 */
	OklahomaTribalStatisticalArea: "G2140",

	/**
	 * A statistical area delineated for the Census Bureau by a state-appointed liaison for
	 * a state-recognized American Indian tribe that has no reservation or trust land today.
	 */
	StateDesignatedTribalStatisticalArea: "G2150",

	/**
	 * A statistical area delineated for the Census Bureau by a federally recognized American
	 * Indian tribe that has no reservation or off-reservation trust land today.
	 */
	TribalDesignatedStatisticalArea: "G2160",

	/**
	 * An area that two or more American Indian tribes administer jointly or both claim.
	 */
	AmericanIndianJointUseArea: "G2170",

	/**
	 * A corporation with legal boundaries, set up under the Alaska Native Claims Settlement Act
	 * (Public Law 92-203), that conducts business and nonprofit affairs for Alaska Natives.
	 *
	 * The twelve geographically defined ANRCs lie inside Alaska and together cover most of the state.
	 * The Annette Island Reserve, an American Indian reservation, belongs to no ANRC.
	 */
	AlaskaNativeRegionalCorporation: "G2200",

	/**
	 * An administrative subdivision of a federally recognized American Indian reservation,
	 * off-reservation trust land or Oklahoma tribal statistical area (OTSA).
	 *
	 * Each is an internal unit of self-government or administration serving social,
	 * cultural or economic purposes for the American Indians living in that area.
	 */
	TribalSubdivision: "G2300",

	/**
	 * A small, stable statistical subdivision of a federally recognized American Indian
	 * reservation or off-reservation trust land, delineated by tribal participants
	 * or the Census Bureau to present demographic data.
	 */
	TribalCensusTract: "G2400",

	/**
	 * A cluster of census blocks inside one tribal census tract, delineated by tribal
	 * participants or the Census Bureau to present demographic data.
	 */
	TribalBlockGroup: "G2410",

	/**
	 * A group of adjacent metropolitan or micropolitan statistical areas whose economic
	 * and social ties are measured by commuting.
	 */
	CombinedStatisticalArea: "G3100",

	/**
	 * A population core plus the adjacent communities tied to it economically
	 * and socially, with the ties measured by commuting.
	 *
	 * Each area is built from whole counties and county equivalents.
	 */
	MetropolitanMicropolitanStatisticalArea: "G3110",

	/**
	 * A county or group of counties that subdivides a Metropolitan Statistical Area
	 * whose urbanized area has 2.5 million or more people.
	 */
	MetropolitanDivision: "G3120",

	/**
	 * A group of adjacent New England city and town areas whose economic
	 * and social ties are measured by commuting.
	 */
	CombinedNewEnglandCityTownArea: "G3200",

	/**
	 * A population core plus the adjacent communities tied to it economically
	 * and socially, with the ties measured by commuting.
	 *
	 * Each area is built from New England Minor Civil Divisions (MCDs).
	 */
	NewEnglandCityTownMetropolitanMicropolitanStatisticalArea: "G3210",

	/**
	 * A group of New England cities and towns that subdivides a New England City
	 * and Town Area whose urbanized area has 2.5 million or more people.
	 */
	NewEnglandCityTownDivision: "G3220",

	/**
	 * For the 2020 Census, a dense core of census blocks that meet a minimum housing-unit
	 * density, plus adjacent non-residential urban land and lower-density land that
	 * links outlying dense settlement to the core.
	 *
	 * The territory qualifies as an urban area when it holds at least 2,000 housing units
	 * or at least 5,000 people.
	 */
	UrbanArea: "G3500",

	/**
	 * A primary governmental division of the United States.
	 *
	 * For census purposes the District of Columbia, Puerto Rico, American Samoa,
	 * Guam, the Commonwealth of the Northern Mariana Islands and the U.S. Virgin
	 * Islands are each treated as equivalent to a state.
	 */
	StateEquivalentFeature: "G4000",

	/**
	 * A primary division of a state or state equivalent.
	 *
	 * In 48 states the division is a county.
	 * Alaska uses boroughs, Louisiana uses parishes and Puerto Rico uses municipios.
	 *
	 * Independent cities belong to this class.
	 * An independent city is an incorporated place outside every county.
	 */
	CountyEquivalentFeature: "G4020",

	/**
	 * A primary division of a county or county equivalent, used to report Census Bureau data.
	 *
	 * Its subtypes are Minor Civil Division, Census County Division/Census Subarea and Unorganized Territory.
	 * Independent places belong to this class.
	 *
	 * An independent place is an incorporated place outside every county subdivision.
	 */
	CountySubdivision: "G4040",

	/**
	 * A subdivision of the three main islands of the U.S. Virgin Islands (USVI).
	 *
	 * Estates have legal boundaries and are much smaller than the Census Subdistricts
	 * (the USVI county subdivisions), and an estate does not always fall inside a single subdistrict.
	 */
	Estate: "G4050",

	/**
	 * A legally defined subdivision (subbarrio) of a Puerto Rico minor civil
	 * division (barrio-pueblo or barrio).
	 */
	SubMinorCivilDivision: "G4060",

	/**
	 * A legal entity incorporated under state law that provides general-purpose
	 * government services to a population center.
	 *
	 * Most are designated a city, borough, municipality, town or village.
	 * A small number have another legal description.
	 */
	IncorporatedPlace: "G4110",

	/**
	 * An incorporated place that merged its government with a county or minor civil division
	 * while one or more incorporated places inside it keep functioning.
	 *
	 * It contains other separately incorporated places.
	 */
	ConsolidatedCity: "G4120",

	/**
	 * A statistical area drawn around a population center, the statistical
	 * counterpart of an incorporated place.
	 */
	CensusDesignatedPlace: "G4210",

	/**
	 * The smallest geography at which the Economic Census presents certain data.
	 *
	 * It covers incorporated places, consolidated cities, census designated places (CDPs),
	 * minor civil divisions (MCDs) in selected states, and the remainders of MCDs or counties.
	 * One of these qualifies when the most recent data show at least 2,500 residents or at least 2,500 jobs.
	 */
	EconomicCensusPlace: "G4300",

	/**
	 * A stable statistical subdivision of a county or county equivalent, delineated by
	 * local participants in the Census Bureau's Participant Statistical Areas Program.
	 */
	CensusTract: "G5020",

	/**
	 * The census blocks in one census tract whose four-digit block numbers share a first digit.
	 *
	 * Block group 3 (BG 3) of a tract, for example, holds blocks 3000 through 3999.
	 */
	BlockGroup: "G5030",

	/**
	 * The smallest statistical area the census defines.
	 *
	 * A block, such as a city block, is bounded mostly by physical features
	 * and in some cases by invisible city or property lines.
	 * Its boundary never crosses the boundary of any other area the Census Bureau tabulates.
	 *
	 * Its subtypes are Count Question Resolution (CQR), current and tabulation census.
	 */
	TabulationBlock: "G5040",

	/**
	 * One of the 435 districts that elect members of the U.S. House of Representatives.
	 *
	 * Equivalent features exist for state equivalents that have a nonvoting delegate or no representative.
	 * The subtypes are the 111th and 113th through 118th Congressional Districts and each later Congress.
	 */
	CongressionalDistrict: "G5200",

	/**
	 * A district, set by a state or equivalent government, that elects members to the upper
	 * chamber of a bicameral legislature (the senate) or to a unicameral legislature (Nebraska).
	 *
	 * The subtypes are legislative session years, such as 2010, 2012, 2014, 2016, 2017, 2018 and later.
	 * The year gives the district's vintage.
	 */
	StateLegislativeDistrictUpperChamber: "G5210",

	/**
	 * A district, set by a state or equivalent government, that elects members to the
	 * lower chamber of a bicameral legislature (the House of Representatives).
	 *
	 * The subtypes are legislative session years, such as 2010, 2012, 2014, 2016, 2017, 2018 and later.
	 * The year gives the district's vintage.
	 */
	StateLegislativeDistrictLowerChamber: "G5220",

	/**
	 * Any area a state, local or tribal government sets up to run elections,
	 * such as a precinct, ward or election district.
	 */
	VotingDistrict: "G5240",

	/**
	 * An area whose officials provide public elementary-grade education to its residents.
	 */
	ElementarySchoolDistrict: "G5400",

	/**
	 * An area whose officials provide public secondary-grade education to its residents.
	 */
	SecondarySchoolDistrict: "G5410",

	/**
	 * An area whose officials provide public education at every grade level to its residents.
	 */
	UnifiedSchoolDistrict: "G5420",

	/**
	 * A statistical area for tabulating and publishing American Community Survey (ACS)
	 * and Puerto Rico Community Survey Public Use Microdata Sample (PUMS) data,
	 * ACS period estimates and decennial census data.
	 *
	 * PUMAs nest inside states or state equivalents and together cover the United States,
	 * Puerto Rico, Guam and the U.S. Virgin Islands.
	 */
	PublicUseMicrodataArea: "G6120",

	/**
	 * An area a state defines under its own authority to manage urban growth.
	 *
	 * The Census Bureau publishes it by agreement with that state.
	 */
	UrbanGrowthArea: "G6330",

	/**
	 * A statistical approximation of the area a U.S. Postal Service (USPS) five-digit ZIP Code serves.
	 */
	ZIPCodeTabulationArea: "G6350",

	/**
	 * A group of municipios (county equivalents) that Puerto Rico officials define
	 * to present economic census data.
	 */
	PlanningRegion: "G6400",

	/**
	 * A hydrographic link between two non-adjacent water features whose exact course is unknown.
	 */
	Connector: "H1100",

	/**
	 * A still body of water with land on every side.
	 */
	LakePond: "H2030",

	/**
	 * Water held back by a built structure.
	 */
	Reservoir: "H2040",

	/**
	 * A built body of water for treating polluted water.
	 */
	TreatmentPond: "H2041",

	/**
	 * Water with land on part of its perimeter.
	 *
	 * Covers arms, bights, coves and inlets.
	 */
	BayEstuaryGulfSound: "H2051",

	/**
	 * The body of salt water that covers most of the Earth's surface.
	 */
	OceanSea: "H2053",

	/**
	 * Ice flowing outward and downhill from where it accumulates, or permanent snow
	 * or ice on a mountain's top or side.
	 *
	 * Covers ice fields and ice patches.
	 */
	Glacier: "H2081",

	/**
	 * A natural waterway with flowing water.
	 *
	 * Covers anabranches, awawas, branches, brooks, creeks, distributaries,
	 * forks, kills, pups, rios and runs.
	 */
	StreamRiver: "H3010",

	/**
	 * A natural waterway that flows through a web of interlaced channels.
	 */
	BraidedStream: "H3013",

	/**
	 * A built waterway that moves water, irrigates or drains land, joins bodies of water,
	 * or serves as a route for boats.
	 *
	 * Covers laterals.
	 */
	CanalDitchAqueduct: "H3020",

	/**
	 * A complex of buildings holding several rented living quarters.
	 */
	ApartmentBuildingComplex: "K1121",

	/**
	 * A site that rents parking spaces for house trailers, with utilities and services in most cases.
	 */
	TrailerCourtMobileHomePark: "K1223",

	/**
	 * A point or area to which the crews of military or merchant marine vessels at sea
	 * are assigned, located at or beside the home port pier in most cases.
	 */
	CrewOfVesselLocation: "K1225",

	/**
	 * A facility that houses people employed as semi-permanent or seasonal workers.
	 */
	HousingFacilityDormitoryForWorkers: "K1226",

	/**
	 * A facility offering short-stay lodging or living quarters, paid for in most cases.
	 */
	HotelMotelResortSpaHostelYMCAOrYWCA: "K1227",

	/**
	 * An area for setting up temporary mobile living quarters or for holding a camp meeting,
	 * in some cases with utilities and other amenities.
	 */
	Campground: "K1228",

	/**
	 * A facility set up by a welfare or educational organization that offers free
	 * or low-cost living quarters to people in need in its district.
	 */
	ShelterMission: "K1229",

	/**
	 * A facility where sick or injured people receive medical or surgical care.
	 *
	 * Covers infirmaries.
	 */
	HospitalHospiceUrgentCareFacility: "K1231",

	/**
	 * A facility that houses and cares for elderly people.
	 */
	NursingHomeRetirementHomeHomeForTheAged: "K1233",

	/**
	 * A correctional or non-correctional facility where groups of juveniles live.
	 *
	 * Covers training schools, detention centers, residential treatment centers and orphanages.
	 */
	JuvenileInstitution: "K1235",

	/**
	 * A facility for the lawful detention of adults, run by a local
	 * (tribal, county, municipal or similar) government.
	 */
	LocalJailDetentionCenter: "K1236",

	/**
	 * A facility for the lawful detention of adults, run by the federal government or a state government.
	 */
	FederalPenitentiaryStatePrisonPrisonFarm: "K1237",

	/**
	 * A facility for the lawful detention of adults that fits no other class
	 * or whose administering government is unknown.
	 */
	OtherCorrectionalInstitution: "K1238",

	/**
	 * An institution where people with a religious vocation live.
	 */
	ConventMonasteryRectoryOtherReligiousGroupQuarters: "K1239",

	/**
	 * A workplace of a federal, state, local or tribal government.
	 */
	GovernmentalWorkplaces: "K2100",

	/**
	 * An area the Department of Defense owns or occupies for a branch of the armed forces
	 * (Army, Navy, Air Force, Marines or Coast Guard), or a state-owned area used by the National Guard.
	 */
	MilitaryInstallation: "K2110",

	/**
	 * A place where community members meet for social, cultural or recreational purposes.
	 */
	CommunityCenter: "K2146",

	/**
	 * A place where a federal, state, local or tribal government conducts administration and public business.
	 */
	GovernmentCenter: "K2165",

	/**
	 * An exhibition hall or conference center with open space for public
	 * and private business and social events.
	 */
	ConventionCenter: "K2167",

	/**
	 * A place reserved for recreation or for preserving a cultural or natural resource.
	 */
	Park: "K2180",

	/**
	 * Land the National Park Service administers, including National Parks,
	 * most National Monuments and certain other land.
	 */
	NationalParkServiceLand: "K2181",

	/**
	 * Land the U.S. Forest Service or another federal agency administers,
	 * other than National Park Service land.
	 */
	NationalForestOtherFederalLand: "K2182",

	/**
	 * A place reserved for recreation or for preserving a cultural or natural resource,
	 * administered by an American Indian tribe.
	 */
	TribalParkForestRecreationArea: "K2183",

	/**
	 * A place reserved for recreation or for preserving a cultural or natural resource,
	 * administered by a state government.
	 */
	StateParkForestRecreationArea: "K2184",

	/**
	 * A place reserved for recreation or for preserving a cultural or natural resource,
	 * administered by a regional government.
	 */
	RegionalParkForestRecreationArea: "K2185",

	/**
	 * A place reserved for recreation or for preserving a cultural or natural resource,
	 * administered by a county government.
	 */
	CountyParkForestRecreationArea: "K2186",

	/**
	 * A place reserved for recreation or for preserving a cultural or natural resource,
	 * administered by a minor civil division (town or township) government.
	 */
	CountySubdivisionParkForestRecreationArea: "K2187",

	/**
	 * A place reserved for recreation or for preserving a cultural or natural resource,
	 * administered by a municipal government.
	 */
	IncorporatedPlaceParkForestRecreationArea: "K2188",

	/**
	 * A privately owned place reserved for recreation or for preserving a cultural or natural resource.
	 */
	PrivateParkForestRecreationArea: "K2189",

	/**
	 * A place reserved for recreation or for preserving a cultural or natural resource, administered by
	 * another kind of government or agency, such as an independent park authority or commission.
	 */
	OtherParkForestRecreationArea: "K2190",

	/**
	 * A U.S. Postal Service facility that processes and distributes mail and other postal material.
	 */
	PostOffice: "K2191",

	/**
	 * A facility housing the equipment and staff that fight fires and provide other emergency help.
	 */
	FireDepartment: "K2193",

	/**
	 * A facility that serves as headquarters for law enforcement officers.
	 */
	PoliceStation: "K2194",

	/**
	 * A facility that keeps literary, musical, artistic or reference material for public use.
	 */
	Library: "K2195",

	/**
	 * A facility housing the main administrative offices of a local municipal government.
	 */
	CityTownHall: "K2196",

	/**
	 * A workplace for wholesale, retail or other trade.
	 */
	CommercialWorkplace: "K2300",

	/**
	 * A group of retail businesses in a planned development that share one parking area.
	 */
	ShoppingCenterMajorRetailCenter: "K2361",

	/**
	 * One or more manufacturing businesses in an area zoned for fabrication, construction or similar trades.
	 */
	IndustrialBuildingIndustrialPark: "K2362",

	/**
	 * One or more structures where employees perform business, clerical or professional services.
	 */
	OfficeBuildingOfficePark: "K2363",

	/**
	 * An agricultural business that grows crops or raises animals.
	 */
	FarmVineyardWineryOrchard: "K2364",

	/**
	 * A workplace that fits no other class or whose type is unknown.
	 */
	OtherEmploymentCenter: "K2366",

	/**
	 * A facility where people board one or more modes of transportation or where goods are shipped.
	 *
	 * Marine terminals, bus stations, train stations, airports and truck warehouses are examples.
	 */
	TransportationTerminal: "K2400",

	/**
	 * A place where privately owned light watercraft or houseboats are moored.
	 */
	Marina: "K2424",

	/**
	 * A platform on piles that extends from the shore over the water.
	 *
	 * It gives ships and boats access to the shore or serves recreation.
	 */
	PierDock: "K2432",

	/**
	 * A built facility maintained for aircraft.
	 *
	 * Covers airstrips, landing fields and landing strips.
	 */
	AirportAirfield: "K2451",

	/**
	 * A place where passengers board and leave rail transit, together with its ticketing,
	 * freight and other commercial offices.
	 */
	TrainStationTrolleyMassTransitRailStation: "K2452",

	/**
	 * A place where passengers board and leave motor-vehicle mass transit,
	 * together with its ticketing, freight and other commercial offices.
	 */
	BusTerminal: "K2453",

	/**
	 * A place where passengers board and leave water transit or cargo is handled,
	 * together with its ticketing, freight and other commercial offices.
	 */
	MarineTerminal: "K2454",

	/**
	 * A place where a floatplane, an airplane that lands on and takes off from water, unloads and loads.
	 */
	SeaplaneAnchorage: "K2455",

	/**
	 * An airport's area, adjusted to whole tabulation blocks, used to delineate urban areas.
	 */
	AirportStatisticalRepresentation: "K2457",

	/**
	 * A level, paved in most cases, surface at an airport where airplanes take off and land.
	 */
	RunwayTaxiway: "K2459",

	/**
	 * A level, paved in most cases, surface where helicopters take off and land.
	 */
	HelicopterLandingPad: "K2460",

	/**
	 * An institution for post-secondary study and teaching.
	 *
	 * Covers seminaries.
	 */
	UniversityCollege: "K2540",

	/**
	 * An institution for preschool, elementary or secondary study and teaching.
	 */
	SchoolAcademy: "K2543",

	/**
	 * An attraction of historical, cultural, educational or other interest that
	 * presents information or displays artifacts.
	 */
	MuseumVisitorCenterCulturalCenterTouristAttraction: "K2545",

	/**
	 * A public or private facility for playing golf.
	 */
	GolfCourse: "K2561",

	/**
	 * A facility for entertainment, performances or sporting events.
	 *
	 * Arenas, auditoriums, theaters, stadiums, coliseums, race courses, theme parks,
	 * fairgrounds and shooting ranges are examples.
	 */
	AmusementCenter: "K2564",

	/**
	 * A place where the dead are buried.
	 *
	 * Covers burying grounds and memorial gardens.
	 */
	Cemetery: "K2582",

	/**
	 * A facility that keeps land or marine animals in enclosures and shows them to
	 * the public for education, preservation and research.
	 */
	Zoo: "K2586",

	/**
	 * A consecrated place or structure where people gather to worship, such as a church,
	 * synagogue, temple or mosque.
	 */
	PlaceOfWorship: "K3544",

	/**
	 * A long conduit or chain of pipes, underground in most cases, with pumps and valves to regulate
	 * flow, that moves fluid such as crude oil or natural gas, in most cases over long distances.
	 */
	Pipeline: "L4010",

	/**
	 * One or more wires, on elevated towers in most cases, that conduct high-voltage electric power.
	 */
	Powerline: "L4020",

	/**
	 * A system that moves passengers or freight in carriers hung from cables held up by towers.
	 */
	AerialTramwaySkiLift: "L4031",

	/**
	 * A built barrier around or along a field, yard or similar area, made of posts with wire
	 * or wood in most cases, that keeps people or animals out or in, or marks a boundary.
	 */
	FenceLine: "L4110",

	/**
	 * The line along the highest ground of a ridge.
	 */
	RidgeLine: "L4121",

	/**
	 * A very steep or vertical slope.
	 *
	 * Covers bluffs, crags, heads, headlands, noses, palisades, precipices, promontories, rims and rimrock.
	 */
	CliffEscarpment: "L4125",

	/**
	 * A line from one located point to another, where the two points are in sight of
	 * each other in most cases and no structure stands close to the line.
	 *
	 * Straight, invisible 180-degree extensions from the ends of a terminating
	 * linear feature belong to this class.
	 */
	PointToPointLine: "L4130",

	/**
	 * A cadastral line between two separate real-property parcels, or a Public
	 * Land Survey System or equivalent survey line.
	 */
	PropertyParcelLine: "L4140",

	/**
	 * The line between land or inland water on one side and coastal, territorial
	 * or Great Lakes water on the other.
	 *
	 * Where land meets coastal, territorial or Great Lakes water, the shoreline is the coastline.
	 * Where inland water such as a river enters one of those waters, the closure
	 * line between the two is the coastline.
	 */
	Coastline: "L4150",

	/**
	 * An invisible feature tracing the route a boat takes to move people
	 * or cargo across a body of water and back.
	 */
	FerryCrossing: "L4165",

	/**
	 * A legal or statistical boundary line that follows no shoreline or other visible ground feature.
	 */
	NonvisibleLinearLegalStatisticalBoundary: "P0001",

	/**
	 * The stable boundary between land and water for a water feature present all year.
	 */
	PerennialShoreline: "P0002",

	/**
	 * The boundary between land and water, while water is present, for a water
	 * feature that is not present all year.
	 */
	IntermittentShoreline: "P0003",

	/**
	 * An edge that is neither a legal or statistical boundary nor a shoreline
	 * or other visible ground feature.
	 *
	 * Such edges bound area landmarks or separate one water feature from another,
	 * as where a bay meets the ocean.
	 */
	OtherNonVisibleEdge: "P0004",

	/**
	 * A fixed rail line, visible from the surface in most cases.
	 *
	 * It serves every kind of rail vehicle, including railroads, off-street transit and mountain rail.
	 */
	RailFeature: "R1011",

	/**
	 * A limited-access highway that joins other roads only at interchanges, never at at-grade intersections.
	 *
	 * Interstate highways and every other limited-access highway, toll roads among them, belong here.
	 * S1100 also covers limited-access highways that have one lane in each direction or no divider.
	 */
	PrimaryRoad: "S1100",

	/**
	 * A main artery without limited access, part of the U.S. Highway, state highway
	 * or county highway system in most cases.
	 *
	 * These roads have one or more lanes in each direction and may or may not be divided.
	 * They meet other roads and driveways at at-grade intersections, and they have
	 * both a local name and a route number in most cases.
	 */
	SecondaryRoad: "S1200",

	/**
	 * A non-arterial street, road or byway, paved and with one lane in each direction in most cases.
	 *
	 * Private and public maintenance both qualify.
	 * Scenic park roads belong here, as do some unpaved roads depending on the region.
	 */
	LocalNeighborhoodRoadRuralRoadCityStreet: "S1400",

	/**
	 * An unpaved dirt trail that requires a four-wheel-drive vehicle.
	 *
	 * These trails occur almost only in very rural areas.
	 * Minor unpaved roads that ordinary cars and trucks can use belong to S1400.
	 */
	VehicularTrail4WD: "S1500",

	/**
	 * A road that gives controlled access from adjacent roads onto a limited-access highway,
	 * in a cloverleaf interchange or other layout.
	 */
	Ramp: "S1630",

	/**
	 * A road, parallel to a limited-access highway in most cases, that reaches structures
	 * or service facilities along the highway.
	 *
	 * These roads can have names and can intersect other roads.
	 */
	ServiceDrive: "S1640",

	/**
	 * A walking path that is too narrow for vehicles or closed to them by law.
	 */
	WalkwayPedestrianTrail: "S1710",

	/**
	 * A pedestrian passage of steps between two levels.
	 */
	Stairway: "S1720",

	/**
	 * A service road behind buildings and properties, used for deliveries,
	 * without addressed structures and without a name in most cases.
	 */
	Alley: "S1730",

	/**
	 * A privately maintained road on private property, used for service, extraction or other purposes.
	 *
	 * Most of these roads have no name.
	 */
	PrivateRoadForServiceVehicles: "S1740",

	/**
	 * Reserved for the U.S. Census Bureau's internal use.
	 */
	InternalUSCensusBureauUse: "S1750",

	/**
	 * The main vehicle route through a paved parking area.
	 *
	 * Can include roads without a name through apartment, condominium or office complexes
	 * where pull-in parking spaces line the road.
	 */
	ParkingLotRoad: "S1780",

	/**
	 * A seasonal trail made and marked in snow.
	 *
	 * Travelers use snowmobiles and dog sleds on it to reach housing units and link communities.
	 */
	WinterTrail: "S1810",

	/**
	 * A path for pedal or small motorized bicycles that is too narrow for vehicles or closed to them by law.
	 */
	BikePathOrTrail: "S1820",

	/**
	 * A path for horses that is too narrow for vehicles or closed to them by law.
	 */
	BridlePath: "S1830",
} as const

export type TIGERClassCode = (typeof TIGERClassCode)[keyof typeof TIGERClassCode]
