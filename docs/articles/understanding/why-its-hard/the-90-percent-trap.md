---
sidebar_position: 6
title: The 90% trap
tags:
  - domain
  - motivation
  - hubris
  - en-us
---

# The 90% trap

A geocoder that correctly parses 90% of addresses sounds good. It sounds especially good when the alternative — building or buying a better one — costs engineering time or API fees. The trap is that the 10% tail is not random. It is concentrated in the populations you most need to serve: rural areas, developing economies, multifamily housing, and anyone whose address doesn't look like a suburban US single-family home.

This article is an economic argument, not a technical one. It explains why 90% coverage is deceptively expensive — and why owning your parser so you can fix your own failure modes is cheaper long-term than renting someone else's.

## The 10% tail is concentrated

Geocoder accuracy varies sharply by location type:

:::note[About the numbers]

The accuracy figures below are **illustrative ranges** drawn from industry experience and published geocoder evaluations. They vary by provider, country, and evaluation methodology. The pattern — accuracy drops sharply for rural, multifamily, and informal-addressing populations — is well-documented; the exact percentages are approximate.

:::

| Location type                      | Typical geocoder accuracy | Share of US population |
| ---------------------------------- | ------------------------- | ---------------------- |
| Urban single-family                | > 95%                     | ~25%                   |
| Suburban single-family             | > 92%                     | ~35%                   |
| Urban multifamily (apartments)     | ~80%                      | ~15%                   |
| Rural routes                       | ~70%                      | ~15%                   |
| PO boxes / general delivery        | ~55%                      | ~3%                    |
| Tribal lands / informal addressing | ~40%                      | ~2%                    |
| New construction (last 2 years)    | ~60%                      | ~5%                    |

The 90% headline accuracy comes from the top two rows — urban and suburban single-family homes, which together are about 60% of the population. The other 40% of the population experiences accuracy that ranges from "mostly works" (urban multifamily at 80%) to "effectively broken" (rural routes at 70%, tribal lands at 40%).

The distribution matters because the populations with the worst geocoder accuracy are the populations where accurate addressing matters most:

- **Rural areas** have the highest per-delivery cost. A misrouted package in Manhattan can be walked to the correct address. A misrouted package in rural Montana requires an hour-long round trip.
- **Multifamily housing** concentrates in lower-income urban areas. A geocoder that resolves to the building rooftop but not to the apartment means delivery to the wrong unit — a failure mode that disproportionately affects renters.
- **Tribal lands and informal addressing** are systematically excluded from the address databases that geocoders train on. The geocoder has no training data for these address formats and fails silently.
- **New construction** is concentrated in growth regions — exactly the places where businesses are adding customers and delivery routes are being established. The geocoder is wrong on the addresses that most need to work.

This is the inverse of the Pareto principle: the **last 10% of coverage costs more than the first 90%**, and the populations in that 10% are the least able to absorb the cost.

## Renting vs. owning

### Google's Geocoding API

| Factor        | Cost                                    |
| ------------- | --------------------------------------- |
| Price         | $5 per 1,000 requests                   |
| Terms         | Results cannot be cached beyond 30 days |
| Coverage      | Global, but variable per country        |
| Latency       | ~50-200ms per request                   |
| Privacy       | Your queries are Google's data          |
| Customization | None — you get Google's ontology        |

At $5/1K requests, geocoding 1 million addresses per month costs $5,000. That is not a large line item for a logistics company — $60,000/year. But the dependency is total: you cannot audit the results, you cannot fix failures, you cannot cache your own correctness corrections, and your query logs train Google's model, not yours. If Google changes its pricing (it has, multiple times) or its terms (it has), you have no alternative.

### geocode.earth / Pelias

| Factor        | Cost                                        |
| ------------- | ------------------------------------------- |
| Price         | Pay-as-you-go, ~$0.50/1K requests           |
| Terms         | Open-source core, hosted service            |
| Coverage      | Global, WOF + OpenStreetMap + OpenAddresses |
| Customization | You can run your own instance               |
| Parser        | The same rule-based engine Mailwoman forked |

geocode.earth is a better deal: the core is open-source, the licensing is more permissive, and you can run your own instance if the hosted service doesn't meet your needs. But the parser is the same Pelias rule engine that Mailwoman v1 was built on — it has the same tokenization-tautology ceiling. Running your own instance means you own the infrastructure but not the parser's failure modes.

### What owning gets you

If you run your own parser + resolver:

- You can fix your own failure modes. When a specific address format repeatedly fails — a customer's regional addressing convention, a data source with idiosyncratic formatting — you can add training data, adjust weights, or tune the reconciler.
- You can audit correctness. When the parser returns a result, you can trace which stage produced it and which evidence supported it.
- You can improve over time. Every correction you make to your own data stays yours. You are not paying recurring rent on someone else's model.
- You can choose your resolver. If WOF's coverage is weak for your region, you can plug in a different gazetteer without changing the parser.

The cost is engineering time — building the parser, maintaining the corpus pipeline, training models, integrating with downstream systems. Mailwoman exists to make that cost lower.

## Why not just use what works for the 90% and fall back for the rest?

This is the most common architecture: call Google/geocode.earth for the 90% that parses cleanly, fall back to manual review for the 10% that doesn't. The problem: **the fallback cost dominates the total.**

Manual address correction costs between $0.50 and $5.00 per address depending on the complexity (a call center agent, a field visit, a returned package). If the geocoder fails on 10% of 1 million addresses, that is 100,000 manual corrections at $0.50-$5.00 each — $50,000 to $500,000 per month. The API cost for the 90% is $4,500 per month (at Google's rate). The fallback cost is 10-100× the API cost.

Reducing the failure rate from 10% to 5% halves the manual-correction cost. Reducing it from 10% to 2% reduces it by 80%. The value is not in parsing more addresses correctly — it is in reducing the number of addresses that need human intervention. Every percentage point of parser accuracy past 90% is worth thousands of dollars per month in avoided manual work.

## What Mailwoman's approach means for this problem

Mailwoman does not target 100% accuracy. No parser does. It targets:

- **Honest confidence.** When the parser is uncertain, it says so, instead of returning a confident wrong answer. The downstream system can decide: escalate to manual review, surface the ambiguity to the user, or accept the best guess with a caveat.
- **Retrainability.** When a specific address class fails, you can add it to the corpus and retrain. The corpus pipeline is designed for this — the adapter pattern makes adding a new data source a few hundred lines of TypeScript.
- **Component-level improvement.** The policy registry lets you improve one component at a time. If the neural model is weak on `region` but strong on `street`, you can use the neural model for `street` and keep the rule classifier for `region`. You don't have to wait for every component to beat the baseline before shipping.

The economic argument for owning your parser is not "it will be better than Google's." It is "you can make it better where you need it, and the cost of the failures you can't fix at Google is higher than the cost of running your own."

## See also

- [The database fallacy](./the-database-fallacy.md) — why the 90% that works is built on partial data
- [How mail delivery actually works](../the-problem/how-mail-delivery-works.md) — the system that already handles ambiguity through human fallback
- [Why a neural parser?](../our-approach/why-a-neural-parser.md) — the technical argument for the neural approach
- [The case for simple geocoders](../alternatives/the-case-for-simple-geocoders.md) — the counterargument: when simple is the right choice
