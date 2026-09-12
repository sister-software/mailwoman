"""The surface pairs each expansion augmentation draws from.

Every table maps a surface to the other surface of the SAME component — an abbreviation to its
expansion, an ordinal to its word — so an augmented copy keeps the row's labels and only changes
how the field is written.
"""

from __future__ import annotations

# US directional abbreviations → expanded forms.
DIRECTIONALS: dict[str, str] = {
    "N": "North",
    "S": "South",
    "E": "East",
    "W": "West",
    "NE": "Northeast",
    "NW": "Northwest",
    "SE": "Southeast",
    "SW": "Southwest",
}

# Ordinal street names, both directions ("5th" ↔ "Fifth") — the 8.2.0 pre-ship metamorphic catch:
# "350 Fifth Ave, New York, NY" (the Empire State Building) lost its locality while the digit form
# parsed clean. The num-ordinal BAND relation is a stated product invariant (gauntlet metamorphic);
# teach the equivalence instead of hoping for it. First..Tenth covers the overwhelming mass of US
# ordinal streets; applied ONLY to street-family-labeled tokens (a "5th" unit/floor is not a street).
ORDINAL_STREETS: dict[str, str] = {
    "1st": "First",
    "2nd": "Second",
    "3rd": "Third",
    "4th": "Fourth",
    "5th": "Fifth",
    "6th": "Sixth",
    "7th": "Seventh",
    "8th": "Eighth",
    "9th": "Ninth",
    "10th": "Tenth",
    "First": "1st",
    "Second": "2nd",
    "Third": "3rd",
    "Fourth": "4th",
    "Fifth": "5th",
    "Sixth": "6th",
    "Seventh": "7th",
    "Eighth": "8th",
    "Ninth": "9th",
    "Tenth": "10th",
}

_STREET_FAMILY_LABELS = frozenset(
    ("B-street", "I-street", "B-street_prefix", "I-street_prefix", "B-street_suffix", "I-street_suffix")
)

# US state abbreviations → full names. Only unambiguous 2-letter codes.
US_STATES: dict[str, str] = {
    "AL": "Alabama",
    "AK": "Alaska",
    "AZ": "Arizona",
    "AR": "Arkansas",
    "CA": "California",
    "CO": "Colorado",
    "CT": "Connecticut",
    "DE": "Delaware",
    "FL": "Florida",
    "GA": "Georgia",
    "HI": "Hawaii",
    "ID": "Idaho",
    "IL": "Illinois",
    "IN": "Indiana",
    "IA": "Iowa",
    "KS": "Kansas",
    "KY": "Kentucky",
    "LA": "Louisiana",
    "ME": "Maine",
    "MD": "Maryland",
    "MA": "Massachusetts",
    "MI": "Michigan",
    "MN": "Minnesota",
    "MS": "Mississippi",
    "MO": "Missouri",
    "MT": "Montana",
    "NE": "Nebraska",
    "NV": "Nevada",
    "NH": "New Hampshire",
    "NJ": "New Jersey",
    "NM": "New Mexico",
    "NY": "New York",
    "NC": "North Carolina",
    "ND": "North Dakota",
    "OH": "Ohio",
    "OK": "Oklahoma",
    "OR": "Oregon",
    "PA": "Pennsylvania",
    "RI": "Rhode Island",
    "SC": "South Carolina",
    "SD": "South Dakota",
    "TN": "Tennessee",
    "TX": "Texas",
    "UT": "Utah",
    "VT": "Vermont",
    "VA": "Virginia",
    "WA": "Washington",
    "WV": "West Virginia",
    "WI": "Wisconsin",
    "WY": "Wyoming",
    "DC": "District of Columbia",
}
