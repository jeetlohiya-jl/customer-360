# Phase 9: right names, dates with the year, history answers, follow-ups

## Problems seen in Slack (28 Oct 2026)
1. Wrong people. "Glenn" became "David", "Umar" was named instead of Glenn, "Vaishnavi" instead of Vaibhav.
   - Extraction never saw who wrote an email: signatures are removed, so the AI guessed from greetings ("Hi Glenn" made Glenn the writer).
   - The Slack answer added the *mailbox owner* as the sender or recipient. The same email sits in several mailboxes, so this was often wrong.
2. Dates had no year.
3. "Month-wise summary since the beginning" returned the latest 4 items: only the newest 120 facts were read and the answer was capped at 4 bullets.
4. A follow-up without a customer name ("…of this account", or just "Premio" after a question) was not understood.

## Changes
- Extraction prompt x6: the AI is given `From (the writer)`, `To` and `Cc` as names with company (Cirkla, or the other side's domain). Email addresses are never sent. Rules: statements in the email belong to the writer; recipients are only the people asked or told.
- Slack: names come from the fact summary only; the mailbox owner is no longer shown to the AI. Dates always include the year.
- Slack history mode (`wantsHistory`): up to 1000 facts are read (migration 0016 raises the worker cap from 120), duplicates removed, up to 4 per month kept (orders, pricing, quality issues first), one line per month.
- Slack follow-ups: when a message names no customer, or is only a customer name, the person's previous messages in the DM (last 30 minutes, read from Slack with the existing `im:history` scope, never stored or logged) supply the customer or the question.
- Test fix: `011_gmail_sync` used a fixed watch expiry (30 Oct 2026) that started failing as the date came close; it is now relative to today.

## Existing facts
`supabase/ops/2026-10-28_reextract_names.sql` re-queues already extracted emails so they are re-read with x6 (newest first, 25 a minute, about $0.0004 each). Emails with any human-reviewed fact are skipped. Run it only after the x6 code is live (it checks).
