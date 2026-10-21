# RoofOps Lite: messaging rules for an Australian client

Lite is set up for a business messaging people in Australia. It applies the **Spam Act 2003** rules that matter for
SMS from a small business:
- consent;
- sender identification;
- a working unsubscribe that is honoured within 5 working days.

This note says what Lite does about each, and what stays with the business. It is practical guidance from the ACMA's
published material, not legal advice. A client with unusual messaging, such as bulk campaigns or buying lists, should
get their own advice.

Sources (ACMA, read 2026-10-20):
- "Avoid sending spam": consent, express and inferred; unsubscribe within 5 working days.
- "SMS Sender ID Register": branded sender IDs must be registered from 1 July 2026.

## The three kinds of Lite message

| Lite message | What it is | Consent Lite requires |
|---|---|---|
| Lead acknowledgement ("thanks, we'll call you") | A reply to the person's own enquiry, about that enquiry | They ticked SMS consent on the form (Consent SMS) |
| Google review request | Commercial: it promotes the business | **Express** permission: Review Opt-In or Marketing Opt-In, with a recorded source and date |
| Reactivation ("is your re-roof still on your list?") | Marketing | **Express** permission: Marketing Opt-In, with a recorded source and date |

### Why express consent for review requests

The ACMA says inferred consent is less reliable than express consent. It also says inferred consent does not cover
messaging someone just because they bought something from you. Lite therefore asks for a separate tick: "After the
job, send me a link to leave a review."

A business that is confident it has inferred consent can set `consent.reviewRequests` to `"service"`. That is the
client's decision and should be written down.

### What "recorded" means

Lite stores consent with each contact:
- **Consent Source:** for example "Website form (https://acme.example/contact)".
- **Consent Recorded At:** the date and time.
- **Consent Wording:** the exact words they agreed to, from `consent.wording`.

The form writes all three. When staff record consent themselves (for example in a phone call), they fill in the same
three fields.

A ticked box with no source and date is **not** treated as consent for review requests or marketing. This is
deliberate, so imported or old contacts are never messaged on an assumption. Do not fill these fields in for old
contacts without real evidence.

## Identify the sender

Every Lite template must contain `{businessName}`; the build refuses one that does not.

Use a real Twilio number (+61 4xx…) as the sender. Lite refuses an alphanumeric sender ID (a name instead of a
number), for two reasons:
- **STOP replies:** people cannot reply STOP to an alphanumeric sender, so the unsubscribe would not work by SMS.
- **The register:** since 1 July 2026, branded sender IDs must be on the ACMA's SMS Sender ID Register.

**Twilio trial accounts are for testing only.** A trial sends Twilio's own template text from a trial number. That text
does not name the business or offer STOP, so trial messages go only to the owner's own verified phone. A customer
needs an upgraded account with the business's own number.

## Unsubscribe

- Every review and marketing template must say "Reply STOP"; the build refuses one that does not.
- A reply of STOP, STOPALL, UNSUBSCRIBE, CANCEL, END, QUIT, OPT OUT, OPTOUT or REMOVE (configurable) does three
  things **at once**: ticks Opted Out, sets Opted Out At, and clears Marketing Opt-In. This is well within 5 working
  days.
- Twilio error 21610 ("unsubscribed recipient") also opts the contact out.
- An opted-out contact gets **nothing** from Lite again: no acknowledgement, review request, reactivation or retry.
- **START** is only logged for staff. Lite never re-subscribes anyone by itself. Staff untick Opted Out only when the
  person clearly asks again, and record that consent.
- A new form from an opted-out person creates the enquiry but does not message them, and does not undo the opt-out.

## What stays with the business

- **Wording:** the consent wording on the form must match what the business actually does.
- **Promises:** do not send more, or other, marketing than people agreed to. Lite sends at most one reactivation per
  enquiry per cooldown (180 days by default).
- **Records:** keep Lite Contacts and the Message Log; they are the record of consent and of every message. Deleting
  them deletes the evidence.
- **Privacy:** the Privacy Act may apply (for example a turnover above $3 million, or health information). Lite stores
  only what the form asks for. The privacy notice is the business's.
- **Timing:** schedules run in the business timezone, with reviews daily at 10:00 and reactivation on Mondays at
  09:00. Keep them in business hours.
