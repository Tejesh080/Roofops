# RoofOps Lite demo run (2026-10-20T12:21:16.363Z)

Config: `lite/config/demo.json` (Harbourside Roofing (Lite demo)). Messaging: **test-sink**: nothing was sent to a real phone or inbox.
Workflows built into `lite\demo\output\workflows`: [Lite] Instant Lead Follow-Up (34 nodes), [Lite] Google Review Requests (20 nodes), [Lite] Lead Reactivation (20 nodes), [Lite] Inbound Replies (24 nodes), [Lite] Monitor (33 nodes).

## Steps

### 1. New website lead (HTTP POST to the lead webhook)

```json
{
 "status": 200,
 "body": {
  "ok": true,
  "duplicate": false,
  "job_ref": "LJ-20261020-848S",
  "new_contact": true,
  "stage": "Contacted",
  "acknowledgement": {
   "status": "Simulated Sent",
   "channel": "SMS",
   "reason": null
  }
 }
}
```

### 2. The same person submits the form again (duplicate)

```json
{
 "status": 200,
 "body": {
  "ok": true,
  "duplicate": true,
  "job_ref": "LJ-20261020-848S",
  "message": "We already have this enquiry and will be in touch."
 }
}
```

### 3. An invalid lead (no phone or email)

```json
{
 "status": 400,
 "body": {
  "ok": false,
  "errors": [
   "an email address or phone number is required"
  ]
 }
}
```

### 4. A lead that gave an email but no consent to be messaged

```json
{
 "status": 200,
 "body": {
  "ok": true,
  "duplicate": false,
  "job_ref": "LJ-20261020-9359",
  "new_contact": true,
  "stage": "New Lead",
  "acknowledgement": {
   "status": "Skipped",
   "channel": null,
   "reason": "no consent or no reachable contact detail"
  }
 }
}
```

### 5. Google review requests: first run

```json
{
 "ok": true,
 "ran_at": "2026-10-20T12:21:16.293Z",
 "mode": "test-sink",
 "sent": 2,
 "failed": 0,
 "unknown": 0,
 "duplicates": 0,
 "blocked": 0,
 "finished_jobs": 6,
 "planned": 2,
 "skipped": 3,
 "skip_reasons": {
  "opted out": 1,
  "no permission for review requests": 2
 },
 "not_due_yet": 1,
 "already_requested": 0,
 "awaiting_retry": 0,
 "deferred_to_next_run": 0
}
```

### 6. Google review requests: run again (no one is asked twice)

```json
{
 "ok": true,
 "ran_at": "2026-10-20T12:21:16.300Z",
 "mode": "test-sink",
 "sent": 0,
 "failed": 0,
 "unknown": 0,
 "duplicates": 0,
 "blocked": 0,
 "finished_jobs": 1,
 "planned": 0,
 "skipped": 0,
 "skip_reasons": {},
 "not_due_yet": 1,
 "already_requested": 0,
 "awaiting_retry": 0,
 "deferred_to_next_run": 0
}
```

### 7. Lead reactivation: first run

```json
{
 "ok": true,
 "ran_at": "2026-10-20T12:21:16.313Z",
 "mode": "test-sink",
 "sent": 2,
 "failed": 0,
 "unknown": 0,
 "duplicates": 0,
 "blocked": 0,
 "open_leads": 9,
 "planned": 2,
 "still_active": 3,
 "excluded": 4,
 "exclusion_reasons": {
  "no marketing permission": 1,
  "opted out": 1,
  "consent not recorded (source and date)": 1,
  "followed up within the cooldown": 1
 },
 "deferred_to_next_run": 0
}
```

### 8. Lead reactivation: run again (cooldown, nobody messaged twice)

```json
{
 "ok": true,
 "ran_at": "2026-10-20T12:21:16.319Z",
 "mode": "test-sink",
 "sent": 0,
 "failed": 0,
 "unknown": 0,
 "duplicates": 0,
 "blocked": 0,
 "open_leads": 9,
 "planned": 0,
 "still_active": 3,
 "excluded": 6,
 "exclusion_reasons": {
  "no marketing permission": 1,
  "opted out": 1,
  "followed up within the cooldown": 3,
  "consent not recorded (source and date)": 1
 },
 "deferred_to_next_run": 0
}
```

### 9. Daniel replies YES to the reactivation SMS

```json
{
 "status": 200,
 "body": {
  "ok": true,
  "known_contact": true,
  "opted_out": false,
  "job_ref": "LJ-DEMO-A1"
 }
}
```

### 10. Olivia replies STOP

```json
{
 "status": 200,
 "body": {
  "ok": true,
  "known_contact": true,
  "opted_out": true,
  "job_ref": null
 }
}
```

### 11. Reactivation again after the replies (Daniel is active again, Olivia opted out)

```json
{
 "ok": true,
 "ran_at": "2026-10-20T12:21:16.349Z",
 "mode": "test-sink",
 "sent": 0,
 "failed": 0,
 "unknown": 0,
 "duplicates": 0,
 "blocked": 0,
 "open_leads": 9,
 "planned": 0,
 "still_active": 4,
 "excluded": 5,
 "exclusion_reasons": {
  "no marketing permission": 1,
  "opted out": 1,
  "followed up within the cooldown": 2,
  "consent not recorded (source and date)": 1
 },
 "deferred_to_next_run": 0
}
```

### 12. Monitor: failed and unconfirmed messages, leads nobody contacted, finished jobs without a date

```json
{
 "ok": true,
 "ran_at": "2026-10-20T12:21:16.362Z",
 "mode": "test-sink",
 "alerts_raised": 1,
 "problem_messages": 0,
 "stuck_sending": 0,
 "failed": 0,
 "unknown": 0,
 "retry_requests": 0,
 "stale_leads": 1,
 "incomplete_jobs": 0,
 "retried": 0,
 "found_already_sent": 0,
 "retry_postponed": 0,
 "resent": 0,
 "resend_failed": 0,
 "resend_unknown": 0
}
```

## Pipeline after the run (Lite Jobs by Stage)

| Stage | Jobs |
|---|---|
| New Lead | LJ-DEMO-A3, LJ-20261020-9359 |
| Contacted | LJ-DEMO-A2, LJ-DEMO-A5, LJ-20261020-848S |
| Quoted | LJ-DEMO-A1, LJ-DEMO-A4, LJ-DEMO-A6, LJ-DEMO-A7 |
| Accepted | LJ-DEMO-P1 |
| Job In Progress | LJ-DEMO-P2 |
| Completed | LJ-DEMO-R1, LJ-DEMO-R3, LJ-DEMO-R5, LJ-DEMO-R6 |
| Invoiced | LJ-DEMO-R4 |
| Paid | LJ-DEMO-R2 |
| Lost | - |

## Message Log

| Workflow | Purpose | Contact | Job | Channel | Status | Reason / To |
|---|---|---|---|---|---|---|
| Lead Follow-Up | Operational | ZZ Lite Demo Emma Walsh | LJ-20261020-848S | SMS | Simulated Sent | 0400000201 |
| Lead Follow-Up | Operational | ZZ Lite Demo Emma Walsh | LJ-20261020-848S |  | Skipped | repeat enquiry within 30 days of LJ-20261020-848S |
| Lead Follow-Up | Operational | ZZ Lite Demo Ethan Cole | LJ-20261020-9359 |  | Skipped | no consent or no reachable contact detail |
| Review Request | Review | ZZ Lite Demo Priya Nair | LJ-DEMO-R3 |  | Skipped | opted out |
| Review Request | Review | ZZ Lite Demo Tom Fraser | LJ-DEMO-R4 |  | Skipped | no permission for review requests |
| Review Request | Review | ZZ Lite Demo Ben Carter | LJ-DEMO-R6 |  | Skipped | no permission for review requests |
| Review Request | Review | ZZ Lite Demo Olivia Chen | LJ-DEMO-R1 | SMS | Simulated Sent | 0400000101 |
| Review Request | Review | ZZ Lite Demo Marcus Webb | LJ-DEMO-R2 | Email | Simulated Sent | marcus.webb@example.test |
| Reactivation | Marketing | ZZ Lite Demo Mia Rossi | LJ-DEMO-A6 | Email | Simulated Sent | mia.rossi@example.test |
| Reactivation | Marketing | ZZ Lite Demo Daniel Brooks | LJ-DEMO-A1 | SMS | Simulated Sent | 0400000106 |
| Inbound Reply | Inbound | ZZ Lite Demo Daniel Brooks | LJ-DEMO-A1 | SMS | Received | reply recorded; enquiry reopened for a call |
| Inbound Reply | Inbound | ZZ Lite Demo Olivia Chen |  | SMS | Opt-Out | contact opted out of all messages |

## Lite Alerts

| Kind | Record | Detail |
|---|---|---|
| Stuck Lead | LJ-DEMO-A3 | New Lead for more than 24 hours: nobody has contacted them yet. |

## Sample message bodies

**Lead Follow-Up to 0400000201 (SMS)**

```
Hi Emma, thanks for contacting Harbourside Roofing (Lite demo) about roof leak repair. We've got your enquiry and will call you within one business day. Reply STOP to opt out.
```

**Review Request to 0400000101 (SMS)**

```
Hi Olivia, thanks for choosing Harbourside Roofing (Lite demo) for your roof restoration. If you're happy with the work, a quick Google review would really help us: https://g.page/r/EXAMPLE-REVIEW-ID/review Reply STOP to opt out.
```

**Review Request to marcus.webb@example.test (Email)**

```
Subject: How did we do? - Harbourside Roofing (Lite demo)

Hi Marcus,

Thanks for choosing Harbourside Roofing (Lite demo) for your gutter replacement. If you are happy with the result, we would be grateful for a short Google review:
https://g.page/r/EXAMPLE-REVIEW-ID/review

The Harbourside Roofing team

Reply STOP to stop these emails.
```

**Reactivation to mia.rossi@example.test (Email)**

```
Subject: Still thinking about your roof painting? - Harbourside Roofing (Lite demo)

Hi Mia,

A while ago you asked Harbourside Roofing (Lite demo) about roof painting. If it's still on your list, just reply to this email and we'll book a free inspection at a time that suits you.

The Harbourside Roofing team

Don't want these emails? Reply STOP.
```
