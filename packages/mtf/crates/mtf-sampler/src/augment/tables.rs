// @copyright Sister Software
// @license AGPL-3.0
// @author Teffen Ellis, et al.

//! The surface pairs each expansion augmentation draws from.
//!
//! Every table maps a surface to the other surface of the same component, an abbreviation to its expansion or an
//! ordinal to its word, so an augmented copy keeps the row's labels and only changes how the field is written.

/// US directional abbreviations and their expansions.
pub const DIRECTIONALS: [(&str, &str); 8] = [
	("N", "North"),
	("S", "South"),
	("E", "East"),
	("W", "West"),
	("NE", "Northeast"),
	("NW", "Northwest"),
	("SE", "Southeast"),
	("SW", "Southwest"),
];

/// Ordinal street names in both directions (`5th` and `Fifth`), applied only to street-family tokens.
pub const ORDINAL_STREETS: [(&str, &str); 20] = [
	("1st", "First"),
	("2nd", "Second"),
	("3rd", "Third"),
	("4th", "Fourth"),
	("5th", "Fifth"),
	("6th", "Sixth"),
	("7th", "Seventh"),
	("8th", "Eighth"),
	("9th", "Ninth"),
	("10th", "Tenth"),
	("First", "1st"),
	("Second", "2nd"),
	("Third", "3rd"),
	("Fourth", "4th"),
	("Fifth", "5th"),
	("Sixth", "6th"),
	("Seventh", "7th"),
	("Eighth", "8th"),
	("Ninth", "9th"),
	("Tenth", "10th"),
];

/// The labels the ordinal swap may rewrite.
pub const STREET_FAMILY_LABELS: [&str; 6] = [
	"B-street",
	"I-street",
	"B-street_prefix",
	"I-street_prefix",
	"B-street_suffix",
	"I-street_suffix",
];

/// US state abbreviations and their full names, unambiguous two-letter codes only.
pub const US_STATES: [(&str, &str); 51] = [
	("AL", "Alabama"),
	("AK", "Alaska"),
	("AZ", "Arizona"),
	("AR", "Arkansas"),
	("CA", "California"),
	("CO", "Colorado"),
	("CT", "Connecticut"),
	("DE", "Delaware"),
	("FL", "Florida"),
	("GA", "Georgia"),
	("HI", "Hawaii"),
	("ID", "Idaho"),
	("IL", "Illinois"),
	("IN", "Indiana"),
	("IA", "Iowa"),
	("KS", "Kansas"),
	("KY", "Kentucky"),
	("LA", "Louisiana"),
	("ME", "Maine"),
	("MD", "Maryland"),
	("MA", "Massachusetts"),
	("MI", "Michigan"),
	("MN", "Minnesota"),
	("MS", "Mississippi"),
	("MO", "Missouri"),
	("MT", "Montana"),
	("NE", "Nebraska"),
	("NV", "Nevada"),
	("NH", "New Hampshire"),
	("NJ", "New Jersey"),
	("NM", "New Mexico"),
	("NY", "New York"),
	("NC", "North Carolina"),
	("ND", "North Dakota"),
	("OH", "Ohio"),
	("OK", "Oklahoma"),
	("OR", "Oregon"),
	("PA", "Pennsylvania"),
	("RI", "Rhode Island"),
	("SC", "South Carolina"),
	("SD", "South Dakota"),
	("TN", "Tennessee"),
	("TX", "Texas"),
	("UT", "Utah"),
	("VT", "Vermont"),
	("VA", "Virginia"),
	("WA", "Washington"),
	("WV", "West Virginia"),
	("WI", "Wisconsin"),
	("WY", "Wyoming"),
	("DC", "District of Columbia"),
];

/// The other surface `key` maps to in `table`.
pub fn lookup(table: &[(&'static str, &'static str)], key: &str) -> Option<&'static str> {
	table.iter().find(|(k, _)| *k == key).map(|&(_, v)| v)
}
