"""What the model is asked, and the tables the asks are built from.

Both system prompts state the SURFACE-FORM INVARIANT — every component value must appear as an
exact substring of the raw address — because the consumer enforces it locally and discards whatever
violates it. Asking for it is cheaper than rejecting it.
"""

from __future__ import annotations

from typing import Any

# Five target scripts. Each entry: (script_label_for_prompt, locale_tag, country_tag, slug).
TRANSLIT_SCRIPTS = [
    ("Russian Cyrillic", "ru-RU", "RU", "cyrl"),
    ("Japanese (Katakana + Kanji)", "ja-JP", "JP", "jpan"),
    ("Simplified Chinese (Mandarin)", "zh-CN", "CN", "hans"),
    ("Korean Hangul", "ko-KR", "KR", "hang"),
    ("Armenian", "hy-AM", "AM", "armn"),
]


TRANSLIT_SYSTEM = (
    "TASK: Transliterate US or French postal addresses from English/French Latin script into the "
    "target script. Keep digits, commas, periods, and hyphens verbatim. Transliterate place names "
    "and street-type words (Ave/Avenue/Rue/Boulevard/Bld/Blvd/Rd/St/Place, etc.) using natural "
    "conventions for the target script. The transliteration should look like how a native speaker "
    "of the target language would render the same address (do NOT translate semantically — these "
    "are foreign place names being phonetically rendered into the target script).\n\n"
    "Output JSONL ONLY — one line per input, in order, no markdown fences, no commentary, no "
    "leading or trailing prose. Each line is exactly one JSON object.\n\n"
    "Schema (every field required): "
    '{"i":<batch_index>,"raw":"<full transliterated address>",'
    '"components":{"<tag>":"<transliterated surface form>",...}}'
    "\n\n"
    "Component tags MUST mirror the input components — if the input lists "
    "{house_number, street, locality, region, postcode} you output the same five tags. "
    "Surface-form INVARIANT: every value in components MUST appear as an exact substring of raw. "
    "The model that ingests these rows checks substring equality and discards anything that "
    "doesn't satisfy it."
)


KRYPTONITE_SYSTEM = (
    "TASK: Generate adversarial postal-address parsing test cases. Each case is a real-looking "
    "address string that's deliberately confusing for a naive parser — venues that contain region "
    "or city tokens, places whose names duplicate or shadow famous locations, mid-position "
    "postcodes, repeated-token brand names, etc. The address must still resolve to a real US "
    "place (city/state/postcode must be geographically consistent). For each case provide the "
    "correct component-tag annotation that a human parser would assign.\n\n"
    "Output JSONL ONLY — one line per item, in order, no markdown fences, no commentary, no "
    "leading or trailing prose. Each line is exactly one JSON object.\n\n"
    "Schema: "
    '{"i":<index>,"raw":"<address>","components":{"<tag>":"<surface form>",...},'
    '"kind":"<short adversarial category>"}'
    "\n\n"
    "Allowed component tags: house_number, street, venue, locality, dependent_locality, region, "
    "postcode, country, po_box, unit. Use only the ones that appear in the address.\n\n"
    "Surface-form INVARIANT: every value in components MUST appear as a substring of raw "
    "(exact case-sensitive substring). The downstream consumer rejects rows that violate this.\n\n"
    "Kind labels — short slug identifying the trap: e.g. "
    '"venue-shadow-region" (venue contains region-like tokens), '
    '"locality-shadow-region" (locality is also a region name elsewhere), '
    '"locality-shadow-country" (locality is also a country/famous city), '
    '"repeated-token" (Buffalo Buffalo / Walla Walla / Bora Bora style), '
    '"mid-position-postcode" (postcode appears between locality and country), '
    '"region-shadow-venue" (region token appears in venue brand), '
    '"compass-prefix" (North/South/East/West-prefixed locality colliding with another place), '
    '"saint-shadow" (Saint X / St. X colliding with St. Petersburg etc.), '
    '"abbrev-collision" (state abbrev collides with a venue/street token), '
    '"french-saint" (FR equivalent: Saint-X colliding with another commune).'
)


KRYPTONITE_USER_TEMPLATE = """\
Generate {n} adversarial US postal-address cases in category: {category}.

Category description: {description}

Examples (use these as inspiration; do NOT copy verbatim — vary cities, brands, and street numbers):
{examples}

Constraints:
- Each address must be a plausible mailing address (real US city + matching state + a valid postcode).
- Vary cities, states, brand names, and street numbers across the {n} items.
- Output exactly {n} JSONL lines in order, index 0..{n_minus_1}, schema as in the system prompt.
"""


#: One entry per adversarial category: its name, a description the prompt carries verbatim, worked
#: examples, and the relative share of the generation budget it takes.
KRYPTONITE_CATEGORIES: list[dict[str, Any]] = [
    {
        "category": "venue-shadow-region",
        "description": "Address with a venue/brand name whose tokens overlap with region abbreviations or names — the venue contains 'NY', 'TX', 'LA', 'CA', etc., but the actual region in the address is elsewhere.",
        "examples": [
            'NY-NY Steakhouse, 1500 Westheimer Rd, Houston, TX 77006 | venue="NY-NY Steakhouse" street="Westheimer Rd" locality="Houston" region="TX" postcode="77006"',
            'Texas Roadhouse, 4321 Belair Rd, Augusta, GA 30909 | venue="Texas Roadhouse" street="Belair Rd" locality="Augusta" region="GA" postcode="30909"',
            'LA Fitness, 2200 Wisconsin Ave NW, Washington, DC 20007 | venue="LA Fitness" street="Wisconsin Ave NW" locality="Washington" region="DC" postcode="20007"',
        ],
        "weight": 1.0,
    },
    {
        "category": "locality-shadow-country",
        "description": "US locality named after a famous non-US city or country — Paris TX, Athens GA, Moscow ID, Lebanon TN, etc. The full address is unambiguously US, but the locality token shadows a foreign place.",
        "examples": [
            "1010 Lamar Ave, Paris, TX 75460 | house_number=1010 street=Lamar Ave locality=Paris region=TX postcode=75460",
            "275 College Ave, Athens, GA 30601 | house_number=275 street=College Ave locality=Athens region=GA postcode=30601",
            "201 N Main St, Moscow, ID 83843 | house_number=201 street=N Main St locality=Moscow region=ID postcode=83843",
            "405 N Cumberland St, Lebanon, TN 37087 | house_number=405 street=N Cumberland St locality=Lebanon region=TN postcode=37087",
        ],
        "weight": 1.0,
    },
    {
        "category": "saint-shadow",
        "description": "US locality with Saint/St. prefix that shadows a famous European saint-name city (Saint Petersburg FL vs Russia, Saint Louis MO vs France, etc.).",
        "examples": [
            "250 Central Ave, Saint Petersburg, FL 33701 | house_number=250 street=Central Ave locality=Saint Petersburg region=FL postcode=33701",
            "1 Memorial Dr, St. Louis, MO 63102 | house_number=1 street=Memorial Dr locality=St. Louis region=MO postcode=63102",
            "85 Augusta St, St. Augustine, FL 32084 | house_number=85 street=Augusta St locality=St. Augustine region=FL postcode=32084",
        ],
        "weight": 0.8,
    },
    {
        "category": "repeated-token",
        "description": "Addresses where the same word appears as both venue/street component and locality (Buffalo Buffalo, Walla Walla WA, Bora Bora, etc.). Tests whether the parser can disambiguate by position rather than token identity.",
        "examples": [
            "First National Bank of Buffalo, 100 Court St, Buffalo, NY 14202 | venue=First National Bank of Buffalo street=Court St locality=Buffalo region=NY postcode=14202",
            "Walla Walla Community College, 500 Tausick Way, Walla Walla, WA 99362 | venue=Walla Walla Community College street=Tausick Way locality=Walla Walla region=WA postcode=99362",
            "Bismarck State College, 1500 Edwards Ave, Bismarck, ND 58506 | venue=Bismarck State College street=Edwards Ave locality=Bismarck region=ND postcode=58506",
        ],
        "weight": 0.9,
    },
    {
        "category": "mid-position-postcode",
        "description": "Postcode appears between locality and region (or between street and locality), instead of at the end. Mirrors how some European-formatted addresses look when imported into US-style strings.",
        "examples": [
            "5 Avenue Foch 75008 Paris, France | street=Avenue Foch postcode=75008 locality=Paris country=France",
            "12 Rue de Rivoli 75001 Paris | street=Rue de Rivoli postcode=75001 locality=Paris",
            "Hauptstr 5, 10115 Berlin, Germany | street=Hauptstr postcode=10115 locality=Berlin country=Germany",
        ],
        "weight": 1.0,
    },
    {
        "category": "compass-prefix",
        "description": "Locality with a compass prefix (North/South/East/West) where dropping the prefix yields a famous other place. North Hollywood vs Hollywood, West Palm Beach vs Palm Beach, etc.",
        "examples": [
            "12000 Riverside Dr, North Hollywood, CA 91607 | house_number=12000 street=Riverside Dr locality=North Hollywood region=CA postcode=91607",
            "1100 S Flagler Dr, West Palm Beach, FL 33401 | house_number=1100 street=S Flagler Dr locality=West Palm Beach region=FL postcode=33401",
            "10 Park Pl, South Plainfield, NJ 07080 | house_number=10 street=Park Pl locality=South Plainfield region=NJ postcode=07080",
        ],
        "weight": 0.7,
    },
    {
        "category": "abbrev-collision",
        "description": "State abbreviation collides with a regular English token elsewhere in the address (e.g., 'IN' as state and 'IN' as preposition in venue name, 'OR' as state vs conjunction). Test whether the parser uses positional cues rather than just token identity.",
        "examples": [
            "Indianapolis Motor Speedway, 4790 W 16th St, Indianapolis, IN 46222 | venue=Indianapolis Motor Speedway street=W 16th St locality=Indianapolis region=IN postcode=46222",
            "OR-It Hardware, 425 SW 4th Ave, Portland, OR 97204 | venue=OR-It Hardware street=SW 4th Ave locality=Portland region=OR postcode=97204",
            "DC Comics Store, 1700 Broadway, New York, NY 10019 | venue=DC Comics Store street=Broadway locality=New York region=NY postcode=10019",
        ],
        "weight": 0.8,
    },
    {
        "category": "french-saint",
        "description": "French commune with Saint-X prefix shadowing another commune. e.g. Saint-Denis (93) vs Saint-Denis-en-Val (45), Saint-Étienne (42) vs Saint-Étienne-de-Tinée (06).",
        "examples": [
            "5 Avenue Aristide Briand, Saint-Denis, 93200 | house_number=5 street=Avenue Aristide Briand locality=Saint-Denis postcode=93200",
            "12 Rue du 11 Novembre, Saint-Étienne, 42000 | house_number=12 street=Rue du 11 Novembre locality=Saint-Étienne postcode=42000",
            "1 Place Carnot, Saint-Quentin, 02100 | house_number=1 street=Place Carnot locality=Saint-Quentin postcode=02100",
        ],
        "weight": 0.7,
    },
    {
        "category": "region-shadow-venue",
        "description": "Venue name embeds a US state name as a brand token (Hotel California, Carolina Brewery, Georgia Aquarium). The actual region in the address is something else.",
        "examples": [
            "Hotel California, 555 Sutter St, San Francisco, CA 94102 | venue=Hotel California street=Sutter St locality=San Francisco region=CA postcode=94102",
            "Georgia Aquarium, 225 Baker St NW, Atlanta, GA 30313 | venue=Georgia Aquarium street=Baker St NW locality=Atlanta region=GA postcode=30313",
            "Carolina Brewery, 460 W Franklin St, Chapel Hill, NC 27516 | venue=Carolina Brewery street=W Franklin St locality=Chapel Hill region=NC postcode=27516",
        ],
        "weight": 0.7,
    },
    {
        "category": "po-box",
        "description": "PO Box that appears intermixed with street-style tokens — e.g. 'PO Box 123, c/o ACME Corp, 500 Main St, Houston, TX 77001'. Tests whether the parser disambiguates physical street from PO box correctly.",
        "examples": [
            "PO Box 451, Springfield, IL 62701 | po_box=PO Box 451 locality=Springfield region=IL postcode=62701",
            "ACME Corp, PO Box 9000, 500 Main St, Houston, TX 77001 | venue=ACME Corp po_box=PO Box 9000 street=Main St locality=Houston region=TX postcode=77001",
        ],
        "weight": 0.5,
    },
]


def build_translit_user_prompt(script_label: str, seeds: list[dict[str, Any]]) -> str:
    lines = [f"Script: {script_label}", "Batch:"]
    for i, s in enumerate(seeds):
        comp_str = ", ".join(f'{k}="{v}"' for k, v in s["components"].items())
        lines.append(f'{i}: raw="{s["raw"]}"; components={{{comp_str}}}')
    return "\n".join(lines)


def build_kryptonite_user_prompt(category: dict[str, Any], n: int) -> str:
    examples = "\n".join(f"- {ex}" for ex in category["examples"])
    return KRYPTONITE_USER_TEMPLATE.format(
        category=category["category"],
        description=category["description"],
        examples=examples,
        n=n,
        n_minus_1=n - 1,
    )
