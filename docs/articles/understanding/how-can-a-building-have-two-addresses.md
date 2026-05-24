---
sidebar_position: 12
title: How can a building have two addresses?
---

# How can a building have two addresses?

A single physical building can have multiple valid addresses. This is not an edge case — it is the normal state of affairs for commercial buildings, multifamily housing, corner properties, and any structure that touches more than one administrative system. A parser that assumes "one building = one address" will fail silently on a large fraction of real-world queries.

## The address is a protocol, not a property

An address is not a geographic fact. It is a **social protocol** for directing a courier. Different couriers use different protocols. The same building participates in multiple protocols simultaneously.

### Mailing address vs. 911 address

| System                 | Address for 350 Fifth Avenue, Manhattan |
| ---------------------- | --------------------------------------- |
| USPS mailing           | 350 5th Ave, New York, NY 10118         |
| 911 emergency dispatch | 350 5th Ave, Manhattan, NY 10001        |

The ZIP codes differ (10118 vs 10001) because USPS assigns delivery-specific ZIP+4 codes for high-volume buildings and 911 uses the geographic ZIP. Both are correct. Both describe the same building. A geocoder that resolves to the USPS ZIP will produce a different centroid than one that resolves to the 911 ZIP. The difference is small for the Empire State Building (both are in Midtown Manhattan) but can be miles apart for rural addresses where the mailing ZIP covers a much larger area than the 911 response zone.

### Street address vs. utility billing

| System                        | Address                                 |
| ----------------------------- | --------------------------------------- |
| USPS                          | 350 5th Ave, New York, NY 10118         |
| Con Edison (electric utility) | 350 5th Ave, New York, NY 10001-0001    |
| Building management           | Empire State Building, 350 Fifth Avenue |

The utility company uses its own ZIP+4 extension (the `-0001` suffix). The building management uses the building's brand name as the primary identifier. A delivery driver looking for "350 5th Ave" will find the building. A tourist looking for "Empire State Building" will also find it. But a geocoder that only indexes the USPS form will not match the tourist's query, even though the building is in its database under a different label.

### Corner buildings

A building at the corner of two named streets has two valid street addresses:

```
123 Main St entrance → 123 Main St
                              (same building)
456 Elm St entrance  → 456 Elm St
```

The building occupies both street frontages. The main entrance determines the postal address, but the secondary entrance is a valid location reference. Emergency services need both — a 911 caller entering from the Elm Street side will report "456 Elm St," and the dispatcher must recognize that this is the same building as "123 Main St."

### Multifamily buildings

123 Main Street has 20 apartments. Each apartment has a distinct mailing address:

```
123 Main St, Apt 1A
123 Main St, Apt 1B
...
123 Main St, Apt 5D
```

The building has one street address and 20 unit addresses. A geocoder that resolves "123 Main St" to the building rooftop is correct for the building but wrong for any specific apartment — the rooftop may be 100 feet from the actual apartment entrance. A delivery to "Apt 5D" needs the building entrance plus internal navigation (floor 5, door D). A geocoder cannot provide the internal navigation, but it should recognize that "123 Main St" without a unit is an incomplete address and flag it as such.

### Administrative overlap

```
350 5th Ave
New York, NY 10118 (USPS mailing city: "New York")
Manhattan, NY 10001 (borough-level: "Manhattan")
New York County, NY (county-level)
```

All four administrative labels refer to the same location at different levels of the hierarchy. A parser that expects exactly one `locality` per address will produce different results depending on which label the input uses. "New York" and "Manhattan" are different strings that describe the same place — the resolver must treat them as equivalent without losing the distinction in the output.

### Buildings that straddle borders

Some buildings literally cross administrative boundaries:

- **State line buildings**: A building with one entrance in Kansas and another in Missouri. Different state tax rates, different ZIP codes, same physical structure.
- **Municipal boundary**: A building in an annexed area whose mailing address still reflects the pre-annexation municipality. USPS has not updated the delivery name, but the legal municipality has changed.
- **Postcode boundary**: A building whose units on different floors map to different postal codes because the postcode boundary follows the building's vertical axis (rare but real in dense urban cores).

In each case, the "correct" address depends on who is asking and why. The tax assessor wants the legal municipality. The postal carrier wants the USPS delivery city. The emergency dispatcher wants the 911 response zone. A geocoder that picks one and calls it "the address" is making an administrative choice the user did not ask for.

## What this means for a parser

The parser should not resolve ambiguity between address forms. It should **surface it**.

When the input is `Empire State Building, NYC`, the parser should emit:

```
venue: Empire State Building
locality: New York City
```

And let the resolver return candidates for "Empire State Building" in New York City — which will include the 350 5th Ave location with high confidence. The parser does not need to know that "Empire State Building" and "350 5th Ave" are the same place. The resolver knows that because WOF stores both as names for the same `wof:id`.

When the input is `350 5th Ave, New York, NY 10118` and the resolver returns the WOF record for the Empire State Building, the output should include the WOF ID and coordinates, but also preserve the raw parsed address. The user might need the mailing address form, not the building name.

When the input is `123 Main St` and the resolver finds a multifamily building with 20 units, the output should flag the ambiguity: "This address is a multi-unit building. Specify an apartment number to resolve to a specific unit." The parser cannot guess which unit the user meant, but it can tell the user that the query is underspecified.

## The schema consequence

Mailwoman's schema includes `unit` as a first-class component because multi-unit addressing is too common to treat as an edge case:

```ts
components: {
    house_number: "123",
    street: "Main St",
    unit: "Apt 4B",
    locality: "Springfield",
    region: "IL",
    postcode: "62701"
}
```

The `unit` tag is optional — many addresses do not have units. But its presence in the schema means the parser can recognize and extract unit information when it exists, and flag its absence when the building is known to be multi-unit (from the resolver's building metadata).

## See also

- [What is a postcode?](./what-is-a-postcode.md) — why mailing postcodes and geographic postcodes diverge
- [The database fallacy](./the-database-fallacy.md) — why no database captures all address forms for a building
- [How humans break addresses](./how-humans-break-addresses.md) — the postal city ≠ municipal city failure mode
- [Resolver and Who's On First](../concepts/resolver-and-wof.md) — how the gazetteer stores alternate names
