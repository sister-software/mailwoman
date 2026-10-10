# `@mailwoman/route-scenarios`

Shared-route construction cost and monthly cash-flow scenarios for the buildings of a dossier. The workspace holds the
rate cards, the scenario inputs, the calculations and the economic report text. It sits downstream of
`@mailwoman/dossier`, which supplies each building's identity and unit totals and computes no cost. The workspace is
private, and this repository holds synthetic inputs only.

Every figure is a scenario computed from supplied assumptions. The report section says so in its first lines and never
presents a figure as a quote. Its low and high cases are scenarios built from named assumptions, and no probability is
attached to either. Calibrated bounds need a frozen population of comparable jobs and a holdout, which
[#2288](https://github.com/sister-software/mailwoman/issues/2288) tracks.

## What a scenario states

A scenario states its as-of date, currency, month zero, horizon, price basis, tax treatment, effective annual discount
rate and NPV target. It selects buildings by their dossier identifiers and plans each one: the route segments its
connection is assumed to need, its own works, its first service month and its occupancy. A versioned rate card prices
every quantity. The operating assumptions set the price, the promotion, uptake, churn, service, maintenance, working
capital and replacements. Each rate, quantity and assumption carries its basis, which is a source record the dossier
admitted or an operator's stated assumption.

`validateScenario` and `prepareScenario` refuse an incomplete scenario with a `ScenarioInputError`. Its `input` names the
kind of input, and its `path` locates it, so a missing rate, unit, date or selected building identity is named where it
occurs. A selected building whose dossier unit total is unresolved throws `UnresolvedUnitTotalError`, which carries the
dossier's reason and conflicting counts. The calculator never turns that total into zero units or a subscriber count. A
unit membership counted for two selected buildings throws `SharedUnitMembershipError`.

## Arithmetic

Amounts are integer counts of the currency's minor unit, and percentages are integer basis points, so every
undiscounted figure is exact. A percentage of an amount is rounded half away from zero to the minor unit, once, where it
is produced. Month m's discount factor is (1 + monthly rate)^m rounded to eight decimal places, each month's present
value is rounded half away from zero to the minor unit, and NPV is the sum of the present values. `lib/money.ts` states
the rule in full.

Subscribers are whole customers. Occupied units, active subscribers and provider availability stay separate counts.
Churn in a month is the floor of the cumulative expected churn minus the churn already applied, and new activations
never exceed the occupied units left after a building's existing subscribers.

## Modules

| Module                | Contents                                                                                                                                                       |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `lib/money.ts`        | Minor-unit amounts, rounding half away from zero, basis-point scaling, the monthly discount rate, discount factors and present values                          |
| `lib/scenario.ts`     | The input types, `ScenarioInputError` and `validateScenario`                                                                                                   |
| `lib/eligibility.ts`  | `prepareScenario`: the dossier checks and each selected building's eligible units                                                                              |
| `lib/construction.ts` | Each distinct route segment charged once, project costs, each building's works, and the incremental cost of adding a building to a set                         |
| `lib/cash-flow.ts`    | The monthly unfinanced table, first revenue, the cash required before first revenue, peak funding and NPV, and the no-build table                              |
| `lib/decision.ts`     | The capex range, the affordable extra construction spend in a stated month, and the break-even take rate or `unreachable`                                      |
| `lib/comparison.ts`   | No build, delayed access, slower uptake, lower price, cost overrun, and construction-stage against retrofit timing, under one set of buildings and conventions |
| `lib/financing.ts`    | The optional financing view, reconciled month by month to the project table                                                                                    |
| `lib/transactions.ts` | Acquisition, lease, wholesale and salvage cases with integration timing, obligations and proceeds, reconciled month by month to the base case                  |
| `lib/report.ts`       | `scenarioReport` computes every figure, and `renderScenarioReport` writes the Markdown section                                                                 |

## Limits

- The calculator computes no tax liability. A scenario declares `pre_tax` or supplies the operator's stated payments.
- The financing view takes interest and repayments as supplied schedules.
- An occupancy schedule never falls, a promotion applies in the activation month only, and a churned subscriber is
  replaced in the month it leaves.
- The pilot route is an assumption, and the calculator never infers a route from an asset's proximity.

## The synthetic example

The section below is the verbatim output of
`renderScenarioReport(scenarioReport(syntheticDossier(), SHARED_ROUTE, REPORT_OPTIONS))` over
`test/fixtures/shared-route.ts`, and `lib/report.test.ts` checks that the two match. It reproduces the handoff's
construction figures: USD 13,000.00 for Building A alone, USD 14,000.00 for Building B alone, USD 16,000.00 for both,
and USD 3,000.00 to add Building B to Building A.

```markdown
## Shared-route scenario: Synthetic shared route to Example Route Parcel

Every input in this section is synthetic. The figures are a scenario computed from the supplied assumptions below. They are not a quote. The low and high cases are scenarios from named assumptions, and no probability is attached to them.

### Conventions

- As of 2026-09-30. Rate card synthetic-rates version 1, stated on 2026-09-01.
- Currency USD. Every undiscounted amount is exact to the minor unit. Prices and the discount rate are nominal.
- Tax: pre-tax. The tax column holds zero by this convention.
- Month 0 is 2026-10. The table runs from month 0 through month 48 (2030-10).
- Discounting: effective annual rate 10.00%, so the monthly rate is (1 + annual rate)^(1/12) - 1 = 0.797414%. Month m's factor is (1 + monthly rate)^m rounded to eight decimal places. Each present value is the cash flow divided by its factor, rounded half away from zero to the minor unit, and NPV is the sum of the present values.
- Terminal value: zero. The base case adds no sale proceeds after month 48 (2030-10).
- NPV target: USD 0.00.

### Buildings

A building's units enter the scenario from its own dossier unit total. Occupied units are a stated assumption that never exceeds that total.

| Building                                  | Eligible units                                               | Service from      | Occupied units                                  |
| ----------------------------------------- | ------------------------------------------------------------ | ----------------- | ----------------------------------------------- |
| Example Building A (`building:example-a`) | 24 completed units on 2026-08-01 (synthetic-inspection-2026) | month 3 (2027-01) | 24 from month 0                                 |
| Example Building B (`building:example-b`) | 16 completed units on 2026-08-01 (synthetic-inspection-2026) | month 3 (2027-01) | 0 from month 0, 8 from month 4, 16 from month 8 |

### Operating assumptions

Occupied units, active subscribers and provider availability are separate counts.

- Price: USD 55.00 per subscriber per month from month 0 (stated by synthetic example for #2288).
- Uptake: from each building's first service month, its target of active subscribers rises in equal steps over 4 months to 50.00% of its occupied units, rounded down to whole subscribers (stated by synthetic example for #2288).
- Churn: 2.00% a month, applied in whole subscribers as the floor of the cumulative expected churn. A churned subscriber is replaced in the same month (stated by synthetic example for #2288).
- Promotion: each new subscriber is credited 100.00% of the activation month's price (stated by synthetic example for #2288).
- Activation and acquisition: USD 250.00 and USD 50.00 per new subscriber (rates activation and acquisition, stated by synthetic example for #2288).
- Service: USD 10.00 per active subscriber per month (rate service, stated by synthetic example for #2288).
- Maintenance: USD 40.00 per month from month 3 (rate maintenance, stated by synthetic example for #2288).
- Working capital: USD 200.00 held from month 3 (stated by synthetic example for #2288).
- Replacement: electronics-refresh, Building electronics refresh, 1 refresh × 600.00 = USD 600.00 in month 36 (stated by synthetic example for #2288).

### Construction

Each distinct route segment is charged once, however many selected buildings use it.

| Line                                                                                          | Category      | Quantity | Rate               | Amount    | Month | Charged to                                                              | Basis                                 |
| --------------------------------------------------------------------------------------------- | ------------- | -------- | ------------------ | --------- | ----- | ----------------------------------------------------------------------- | ------------------------------------- |
| shared-route-trench: Underground route from the existing splice point to Example Route Parcel | outside_plant | 400 m    | 25.00 per m        | 10,000.00 | 1     | segment shared-route, used by Example Building A and Example Building B | stated by synthetic example for #2288 |
| mobilization: Crew mobilization                                                               | mobilization  | 1 visit  | 1,000.00 per visit | 1,000.00  | 1     | the project                                                             | stated by synthetic example for #2288 |
| a-branch: Branch from the shared route to Example Building A                                  | connection    | 80 m     | 25.00 per m        | 2,000.00  | 2     | Example Building A                                                      | stated by synthetic example for #2288 |
| b-branch: Branch from the shared route to Example Building B                                  | connection    | 120 m    | 25.00 per m        | 3,000.00  | 2     | Example Building B                                                      | stated by synthetic example for #2288 |

- Common cost: USD 11,000.00, the route's USD 10,000.00 and the project's USD 1,000.00.
- Direct cost: Example Building A USD 2,000.00. Example Building B USD 3,000.00.
- Total project cost: USD 16,000.00.
- Example Building A alone: USD 13,000.00.
- Example Building B alone: USD 14,000.00.
- Adding Example Building A to Example Building B: USD 2,000.00.
- Adding Example Building B to Example Building A: USD 3,000.00.
- Capex range, as scenarios: low USD 14,400.00 (every construction line 10% under the rate card), base USD 16,000.00 (rate card as stated), high USD 18,500.00 (outside plant 25% over the rate card).

### Decision outputs

- NPV at 10.00%: USD 2,676.08, against a target of USD 0.00.
- First revenue: month 4 (2027-02).
- Cash required before first revenue: USD 17,170.00.
- Peak funding: USD 20,285.00, reached in month 6 (2027-04), after first revenue.
- Affordable extra construction spend: USD 2,697.42 paid in month 1 (2026-11), at the factor 1.00797414, keeps the NPV at or above USD 0.00.
- Break-even take rate: 45.84% of occupied units under the uptake assumption. In month 24 (2028-10), 18 of 40 occupied units subscribe (45.00%), and the NPV is USD 580.30.

### Comparison

Every case keeps the base case's buildings and conventions and changes the one assumption it states. Amounts are in USD.

| Case                           | Assumption                                                                                                                          | Capex     | NPV       | First revenue | Cash before first revenue | Peak funding          |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------- | --------- | --------- | ------------- | ------------------------- | --------------------- |
| Base case                      | the scenario as stated                                                                                                              | 16,000.00 | 2,676.08  | month 4       | 17,170.00                 | 20,285.00 in month 6  |
| No build                       | no construction and no subscribers, so every flow is zero                                                                           | 0.00      | 0.00      | none          | 0.00                      | 0.00                  |
| Delayed access and activation  | service in every selected building starts 6 months later than in the base case                                                      | 16,000.00 | -1,088.07 | month 10      | 18,030.00                 | 21,450.00 in month 12 |
| Slower uptake                  | activations reach 30.00% of occupied units over 8 months instead of 50.00% over 4 months                                            | 16,000.00 | -7,245.62 | month 5       | 16,590.00                 | 18,680.00 in month 9  |
| Lower competitor-driven price  | from month 12 (2027-10) the monthly price is USD 45.00 instead of USD 55.00                                                         | 16,000.00 | -3,056.83 | month 4       | 17,170.00                 | 20,285.00 in month 6  |
| Cost overrun                   | every construction line 30% over the rate card                                                                                      | 20,800.00 | -2,074.17 | month 4       | 21,970.00                 | 25,085.00 in month 6  |
| Retrofit timing for Building B | Building B is connected after occupancy: its branch and 4 floors of riser work are paid in month 10, and service starts in month 11 | 17,200.00 | 139.14    | month 4       | 14,170.00                 | 19,270.00 in month 13 |

Lowest NPV among the cases: USD -7,245.62, under "Slower uptake": activations reach 30.00% of occupied units over 8 months instead of 50.00% over 4 months.

### Monthly cash flow

Unfinanced project cash flow in USD. Cash flow is receipts minus promotion, service and maintenance, acquisition and activation, construction and replacement, the working-capital increase and tax.

| Month | Calendar | Occupied | Active | New | Churn | Receipts  | Promotion | Service and maintenance | Acquisition and activation | Construction and replacement | Working-capital increase | Tax  | Cash flow  | Cumulative | Factor     | Present value |
| ----- | -------- | -------- | ------ | --- | ----- | --------- | --------- | ----------------------- | -------------------------- | ---------------------------- | ------------------------ | ---- | ---------- | ---------- | ---------- | ------------- |
| 0     | 2026-10  | 24       | 0      | 0   | 0     | 0.00      | 0.00      | 0.00                    | 0.00                       | 0.00                         | 0.00                     | 0.00 | 0.00       | 0.00       | 1.00000000 | 0.00          |
| 1     | 2026-11  | 24       | 0      | 0   | 0     | 0.00      | 0.00      | 0.00                    | 0.00                       | 11,000.00                    | 0.00                     | 0.00 | -11,000.00 | -11,000.00 | 1.00797414 | -10,912.98    |
| 2     | 2026-12  | 24       | 0      | 0   | 0     | 0.00      | 0.00      | 0.00                    | 0.00                       | 5,000.00                     | 0.00                     | 0.00 | -5,000.00  | -16,000.00 | 1.01601187 | -4,921.20     |
| 3     | 2027-01  | 24       | 3      | 3   | 0     | 165.00    | 165.00    | 70.00                   | 900.00                     | 0.00                         | 200.00                   | 0.00 | -1,170.00  | -17,170.00 | 1.02411369 | -1,142.45     |
| 4     | 2027-02  | 32       | 8      | 5   | 0     | 440.00    | 275.00    | 120.00                  | 1,500.00                   | 0.00                         | 0.00                     | 0.00 | -1,455.00  | -18,625.00 | 1.03228012 | -1,409.50     |
| 5     | 2027-03  | 32       | 12     | 4   | 0     | 660.00    | 220.00    | 160.00                  | 1,200.00                   | 0.00                         | 0.00                     | 0.00 | -920.00    | -19,545.00 | 1.04051166 | -884.18       |
| 6     | 2027-04  | 32       | 16     | 4   | 0     | 880.00    | 220.00    | 200.00                  | 1,200.00                   | 0.00                         | 0.00                     | 0.00 | -740.00    | -20,285.00 | 1.04880885 | -705.56       |
| 7     | 2027-05  | 32       | 16     | 0   | 0     | 880.00    | 0.00      | 200.00                  | 0.00                       | 0.00                         | 0.00                     | 0.00 | 680.00     | -19,605.00 | 1.05717220 | 643.23        |
| 8     | 2027-06  | 40       | 20     | 4   | 0     | 1,100.00  | 220.00    | 240.00                  | 1,200.00                   | 0.00                         | 0.00                     | 0.00 | -560.00    | -20,165.00 | 1.06560224 | -525.52       |
| 9     | 2027-07  | 40       | 20     | 1   | 1     | 1,100.00  | 55.00     | 240.00                  | 300.00                     | 0.00                         | 0.00                     | 0.00 | 505.00     | -19,660.00 | 1.07409950 | 470.16        |
| 10    | 2027-08  | 40       | 20     | 0   | 0     | 1,100.00  | 0.00      | 240.00                  | 0.00                       | 0.00                         | 0.00                     | 0.00 | 860.00     | -18,800.00 | 1.08266452 | 794.34        |
| 11    | 2027-09  | 40       | 20     | 0   | 0     | 1,100.00  | 0.00      | 240.00                  | 0.00                       | 0.00                         | 0.00                     | 0.00 | 860.00     | -17,940.00 | 1.09129784 | 788.05        |
| 12    | 2027-10  | 40       | 20     | 0   | 0     | 1,100.00  | 0.00      | 240.00                  | 0.00                       | 0.00                         | 0.00                     | 0.00 | 860.00     | -17,080.00 | 1.10000000 | 781.82        |
| 13    | 2027-11  | 40       | 20     | 2   | 2     | 1,100.00  | 110.00    | 240.00                  | 600.00                     | 0.00                         | 0.00                     | 0.00 | 150.00     | -16,930.00 | 1.10877155 | 135.28        |
| 14    | 2027-12  | 40       | 20     | 0   | 0     | 1,100.00  | 0.00      | 240.00                  | 0.00                       | 0.00                         | 0.00                     | 0.00 | 860.00     | -16,070.00 | 1.11761305 | 769.50        |
| 15    | 2028-01  | 40       | 20     | 0   | 0     | 1,100.00  | 0.00      | 240.00                  | 0.00                       | 0.00                         | 0.00                     | 0.00 | 860.00     | -15,210.00 | 1.12652506 | 763.41        |
| 16    | 2028-02  | 40       | 20     | 0   | 0     | 1,100.00  | 0.00      | 240.00                  | 0.00                       | 0.00                         | 0.00                     | 0.00 | 860.00     | -14,350.00 | 1.13550813 | 757.37        |
| 17    | 2028-03  | 40       | 20     | 1   | 1     | 1,100.00  | 55.00     | 240.00                  | 300.00                     | 0.00                         | 0.00                     | 0.00 | 505.00     | -13,845.00 | 1.14456283 | 441.22        |
| 18    | 2028-04  | 40       | 20     | 0   | 0     | 1,100.00  | 0.00      | 240.00                  | 0.00                       | 0.00                         | 0.00                     | 0.00 | 860.00     | -12,985.00 | 1.15368973 | 745.43        |
| 19    | 2028-05  | 40       | 20     | 1   | 1     | 1,100.00  | 55.00     | 240.00                  | 300.00                     | 0.00                         | 0.00                     | 0.00 | 505.00     | -12,480.00 | 1.16288942 | 434.26        |
| 20    | 2028-06  | 40       | 20     | 0   | 0     | 1,100.00  | 0.00      | 240.00                  | 0.00                       | 0.00                         | 0.00                     | 0.00 | 860.00     | -11,620.00 | 1.17216246 | 733.69        |
| 21    | 2028-07  | 40       | 20     | 0   | 0     | 1,100.00  | 0.00      | 240.00                  | 0.00                       | 0.00                         | 0.00                     | 0.00 | 860.00     | -10,760.00 | 1.18150945 | 727.88        |
| 22    | 2028-08  | 40       | 20     | 1   | 1     | 1,100.00  | 55.00     | 240.00                  | 300.00                     | 0.00                         | 0.00                     | 0.00 | 505.00     | -10,255.00 | 1.19093097 | 424.04        |
| 23    | 2028-09  | 40       | 20     | 0   | 0     | 1,100.00  | 0.00      | 240.00                  | 0.00                       | 0.00                         | 0.00                     | 0.00 | 860.00     | -9,395.00  | 1.20042762 | 716.41        |
| 24    | 2028-10  | 40       | 20     | 0   | 0     | 1,100.00  | 0.00      | 240.00                  | 0.00                       | 0.00                         | 0.00                     | 0.00 | 860.00     | -8,535.00  | 1.21000000 | 710.74        |
| 25    | 2028-11  | 40       | 20     | 0   | 0     | 1,100.00  | 0.00      | 240.00                  | 0.00                       | 0.00                         | 0.00                     | 0.00 | 860.00     | -7,675.00  | 1.21964871 | 705.12        |
| 26    | 2028-12  | 40       | 20     | 2   | 2     | 1,100.00  | 110.00    | 240.00                  | 600.00                     | 0.00                         | 0.00                     | 0.00 | 150.00     | -7,525.00  | 1.22937436 | 122.01        |
| 27    | 2029-01  | 40       | 20     | 0   | 0     | 1,100.00  | 0.00      | 240.00                  | 0.00                       | 0.00                         | 0.00                     | 0.00 | 860.00     | -6,665.00  | 1.23917756 | 694.01        |
| 28    | 2029-02  | 40       | 20     | 0   | 0     | 1,100.00  | 0.00      | 240.00                  | 0.00                       | 0.00                         | 0.00                     | 0.00 | 860.00     | -5,805.00  | 1.24905894 | 688.52        |
| 29    | 2029-03  | 40       | 20     | 0   | 0     | 1,100.00  | 0.00      | 240.00                  | 0.00                       | 0.00                         | 0.00                     | 0.00 | 860.00     | -4,945.00  | 1.25901911 | 683.07        |
| 30    | 2029-04  | 40       | 20     | 1   | 1     | 1,100.00  | 55.00     | 240.00                  | 300.00                     | 0.00                         | 0.00                     | 0.00 | 505.00     | -4,440.00  | 1.26905871 | 397.93        |
| 31    | 2029-05  | 40       | 20     | 0   | 0     | 1,100.00  | 0.00      | 240.00                  | 0.00                       | 0.00                         | 0.00                     | 0.00 | 860.00     | -3,580.00  | 1.27917836 | 672.31        |
| 32    | 2029-06  | 40       | 20     | 1   | 1     | 1,100.00  | 55.00     | 240.00                  | 300.00                     | 0.00                         | 0.00                     | 0.00 | 505.00     | -3,075.00  | 1.28937871 | 391.66        |
| 33    | 2029-07  | 40       | 20     | 0   | 0     | 1,100.00  | 0.00      | 240.00                  | 0.00                       | 0.00                         | 0.00                     | 0.00 | 860.00     | -2,215.00  | 1.29966039 | 661.71        |
| 34    | 2029-08  | 40       | 20     | 1   | 1     | 1,100.00  | 55.00     | 240.00                  | 300.00                     | 0.00                         | 0.00                     | 0.00 | 505.00     | -1,710.00  | 1.31002407 | 385.49        |
| 35    | 2029-09  | 40       | 20     | 0   | 0     | 1,100.00  | 0.00      | 240.00                  | 0.00                       | 0.00                         | 0.00                     | 0.00 | 860.00     | -850.00    | 1.32047038 | 651.28        |
| 36    | 2029-10  | 40       | 20     | 0   | 0     | 1,100.00  | 0.00      | 240.00                  | 0.00                       | 600.00                       | 0.00                     | 0.00 | 260.00     | -590.00    | 1.33100000 | 195.34        |
| 37    | 2029-11  | 40       | 20     | 0   | 0     | 1,100.00  | 0.00      | 240.00                  | 0.00                       | 0.00                         | 0.00                     | 0.00 | 860.00     | 270.00     | 1.34161358 | 641.02        |
| 38    | 2029-12  | 40       | 20     | 2   | 2     | 1,100.00  | 110.00    | 240.00                  | 600.00                     | 0.00                         | 0.00                     | 0.00 | 150.00     | 420.00     | 1.35231180 | 110.92        |
| 39    | 2030-01  | 40       | 20     | 0   | 0     | 1,100.00  | 0.00      | 240.00                  | 0.00                       | 0.00                         | 0.00                     | 0.00 | 860.00     | 1,280.00   | 1.36309532 | 630.92        |
| 40    | 2030-02  | 40       | 20     | 0   | 0     | 1,100.00  | 0.00      | 240.00                  | 0.00                       | 0.00                         | 0.00                     | 0.00 | 860.00     | 2,140.00   | 1.37396483 | 625.93        |
| 41    | 2030-03  | 40       | 20     | 0   | 0     | 1,100.00  | 0.00      | 240.00                  | 0.00                       | 0.00                         | 0.00                     | 0.00 | 860.00     | 3,000.00   | 1.38492102 | 620.97        |
| 42    | 2030-04  | 40       | 20     | 1   | 1     | 1,100.00  | 55.00     | 240.00                  | 300.00                     | 0.00                         | 0.00                     | 0.00 | 505.00     | 3,505.00   | 1.39596458 | 361.76        |
| 43    | 2030-05  | 40       | 20     | 0   | 0     | 1,100.00  | 0.00      | 240.00                  | 0.00                       | 0.00                         | 0.00                     | 0.00 | 860.00     | 4,365.00   | 1.40709619 | 611.19        |
| 44    | 2030-06  | 40       | 20     | 1   | 1     | 1,100.00  | 55.00     | 240.00                  | 300.00                     | 0.00                         | 0.00                     | 0.00 | 505.00     | 4,870.00   | 1.41831658 | 356.06        |
| 45    | 2030-07  | 40       | 20     | 0   | 0     | 1,100.00  | 0.00      | 240.00                  | 0.00                       | 0.00                         | 0.00                     | 0.00 | 860.00     | 5,730.00   | 1.42962643 | 601.56        |
| 46    | 2030-08  | 40       | 20     | 0   | 0     | 1,100.00  | 0.00      | 240.00                  | 0.00                       | 0.00                         | 0.00                     | 0.00 | 860.00     | 6,590.00   | 1.44102647 | 596.80        |
| 47    | 2030-09  | 40       | 20     | 1   | 1     | 1,100.00  | 55.00     | 240.00                  | 300.00                     | 0.00                         | 0.00                     | 0.00 | 505.00     | 7,095.00   | 1.45251742 | 347.67        |
| 48    | 2030-10  | 40       | 20     | 0   | 0     | 1,100.00  | 0.00      | 240.00                  | 0.00                       | 0.00                         | 0.00                     | 0.00 | 860.00     | 7,955.00   | 1.46410000 | 587.39        |
| Total |          |          |        | 36  | 16    | 48,125.00 | 1,980.00  | 10,590.00               | 10,800.00                  | 16,600.00                    | 200.00                   | 0.00 | 7,955.00   |            |            | 2,676.08      |

### Financing view

The financing view adds each flow once beside the unfinanced table, which it leaves unchanged.

| Flow                                   | Kind           | Months  | Amount per month | Total     | Basis                                 |
| -------------------------------------- | -------------- | ------- | ---------------- | --------- | ------------------------------------- |
| equity: Synthetic equity contribution  | equity         | 0       | 8,000.00         | 8,000.00  | stated by synthetic example for #2288 |
| draw: Synthetic construction loan draw | debt_draw      | 1       | 10,000.00        | 10,000.00 | stated by synthetic example for #2288 |
| grant: Synthetic build grant           | grant          | 2       | 3,000.00         | 3,000.00  | stated by synthetic example for #2288 |
| interest: Synthetic loan interest      | interest       | 2 to 48 | 50.00            | 2,350.00  | stated by synthetic example for #2288 |
| repay-1: Synthetic loan repayment      | debt_repayment | 12      | 2,500.00         | 2,500.00  | stated by synthetic example for #2288 |
| repay-2: Synthetic loan repayment      | debt_repayment | 24      | 2,500.00         | 2,500.00  | stated by synthetic example for #2288 |
| repay-3: Synthetic loan repayment      | debt_repayment | 36      | 2,500.00         | 2,500.00  | stated by synthetic example for #2288 |
| repay-4: Synthetic loan repayment      | debt_repayment | 48      | 2,500.00         | 2,500.00  | stated by synthetic example for #2288 |

- Net cash flow: project USD 7,955.00, plus equity USD 8,000.00, draws USD 10,000.00 and grants USD 3,000.00, minus repayments USD 10,000.00 and interest USD 2,350.00, is USD 16,605.00.
- In each of the 49 months, the net cash flow minus that month's financing flows equals the project cash flow.
- Funding gap: none. The cash balance stays at or above zero in every month.

### Transaction cases

Each case is optional and reads against the base case, whose NPV is USD 2,676.08 with zero terminal value. Amounts are in USD.

| Case                                                         | Kind        | Integration | Avoided construction | Subscriber change | Obligations | Proceeds | Case NPV | Reconciles |
| ------------------------------------------------------------ | ----------- | ----------- | -------------------- | ----------------- | ----------- | -------- | -------- | ---------- |
| Resale of the building electronics at the end of the horizon | salvage     | month 48    | 0.00                 | 0.00              | 0.00        | 4,000.00 | 5,408.14 | yes        |
| Lease of the shared route instead of construction            | lease       | month 1     | 10,000.00            | 0.00              | 7,200.00    | 0.00     | 6,634.17 | yes        |
| Acquisition of 4 subscribers in Building A                   | acquisition | month 6     | 0.00                 | 1,555.00          | 1,600.00    | 0.00     | 2,619.85 | yes        |
| Wholesale access sold to another provider                    | wholesale   | month 12    | 0.00                 | 0.00              | 740.00      | 7,400.00 | 7,942.96 | yes        |

Resale of the building electronics at the end of the horizon (salvage, from month 48 (2030-10)):

- Obligations: none.
- Proceeds: electronics-resale, Resale value of the building electronics: USD 4,000.00 in month 48 (stated by synthetic example for #2288).

Lease of the shared route instead of construction (lease, from month 1 (2026-11)):

- Leased segments: shared-route.
- Obligation: route-lease, Lease payment for the shared route: USD 150.00 per month in months 1 to 48 (stated by synthetic example for #2288).
- Proceeds: none.

Acquisition of 4 subscribers in Building A (acquisition, from month 6 (2027-04)):

- Acquired subscribers: 4 in Example Building A, joining without activation cost.
- Obligation: purchase-price, Purchase price of the acquired subscribers: USD 1,600.00 in month 6 (stated by synthetic example for #2288).
- Proceeds: none.

Wholesale access sold to another provider (wholesale, from month 12 (2027-10)):

- Obligation: wholesale-port, Port cost of the wholesale access: USD 20.00 per month in months 12 to 48 (stated by synthetic example for #2288).
- Proceeds: wholesale-fee, Wholesale access fee: USD 200.00 per month in months 12 to 48 (stated by synthetic example for #2288).
```
