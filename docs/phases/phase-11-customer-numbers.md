# Phase 11: customer numbers (migration 0018, prompt x7)

Any number that tells Cirkla how big a customer is or what it needs, read from
customer emails in the same AI call as facts:

| Category | Examples |
|---|---|
| Production | lbs of meat a week, birds or head a day, lines, shifts |
| Packaging usage | trays a month, truckloads of foam trays a year, by tray size |
| Requirement / forecast | annual requirement, launch or rollout volume, expected growth |
| Orders | truckload every 2 weeks, typical PO size, MOQ asked for |
| Spend / price | budget, target price, price paid to the current supplier, annual spend |
| Company size | plants, stores, DCs, SKUs, revenue |
| Supplier | incumbent's volume or share, contract length |

Each number keeps value (and range), unit, currency, period, scope (plant /
product), kind (actual, capacity, forecast, target, estimate), the year or month
it is for when stated, who said it, the email date and an evidence quote.

Checks (as for facts): the number must appear in the email (ranges such as
"15-18 million" included), quotes verbatim or dropped, every string redacted
again, personal matters dropped, numbers about other companies dropped, money
needs a currency or unit, low confidence or unverifiable numbers go to review.
The AI copies numbers as written; yearly equivalents are worked out by the app
(daily figures assume 260 working days), never by the AI.

Where to see them:
- **Customer numbers** page (`/numbers`): the newest figure per measure, older
  figures as history, "differs" when an earlier figure is more than 20% apart.
  Mailbox owners and admins can mark a number correct or wrong.
- **Slack**: "How many birds a day does Fieldale process?", "What's Premio's
  annual tray usage?", "What's their forecast for next year?".
- Visibility is exactly the facts rule (`facts_visibility`).

Rollout:
1. `db push` (0018), deploy. New email is read with x7 at once.
2. Look at the first numbers on `/numbers`.
3. Run `supabase/ops/2026-11-13_extract_numbers.sql` (preview first) to read
   past emails again (about $0.0005 per email).

Reverse: `supabase/rollback/20261113000018_customer_metrics.down.sql` (removes
the numbers); prompt x6 code restores the previous extraction.
