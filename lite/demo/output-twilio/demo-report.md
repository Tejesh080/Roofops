# RoofOps Lite demo run (2026-10-20T12:21:18.584Z)

Config: `lite/config/example-plumbing-twilio.json` (ZZ Example Plumbing (test client)). Messaging: **twilio** against a LOCAL FAKE of the Twilio API (signed webhooks, real error codes): nothing was sent to a real phone or inbox.
Workflows built into `lite\demo\output-twilio\workflows`: [Lite] Instant Lead Follow-Up (34 nodes), [Lite] Google Review Requests (20 nodes), [Lite] Lead Reactivation (20 nodes), [Lite] Inbound Replies (24 nodes), [Lite] Monitor (35 nodes).

## Steps

### 1. New website lead (HTTP POST to the lead webhook)

```json
{
 "status": 200,
 "body": {
  "ok": true,
  "duplicate": false,
  "job_ref": "LJ-20261020-K427",
  "new_contact": true,
  "stage": "Contacted",
  "acknowledgement": {
   "status": "Sent",
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
  "job_ref": "LJ-20261020-K427",
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
  "job_ref": "LJ-20261020-8DJE",
  "new_contact": true,
  "stage": "New Lead",
  "acknowledgement": {
   "status": "Skipped",
   "channel": null,
   "reason": "no SMS consent or no mobile number"
  }
 }
}
```

### 5. Google review requests: first run

```json
{
 "ok": true,
 "ran_at": "2026-10-20T12:21:18.449Z",
 "mode": "twilio",
 "sent": 2,
 "failed": 0,
 "unknown": 0,
 "duplicates": 0,
 "blocked": 0,
 "finished_jobs": 6,
 "planned": 2,
 "skipped": 4,
 "skip_reasons": {
  "no SMS consent or no mobile number": 1,
  "opted out": 1,
  "no permission for review requests": 2
 },
 "not_due_yet": 0,
 "already_requested": 0,
 "awaiting_retry": 0,
 "deferred_to_next_run": 0
}
```

### 6. Google review requests: run again (no one is asked twice)

```json
{
 "ok": true,
 "ran_at": "2026-10-20T12:21:18.456Z",
 "mode": "twilio",
 "sent": 0,
 "failed": 0,
 "unknown": 0,
 "duplicates": 0,
 "blocked": 0,
 "finished_jobs": 0,
 "planned": 0,
 "skipped": 0,
 "skip_reasons": {},
 "not_due_yet": 0,
 "already_requested": 0,
 "awaiting_retry": 0,
 "deferred_to_next_run": 0
}
```

### 7. Lead reactivation: first run

```json
{
 "ok": true,
 "ran_at": "2026-10-20T12:21:18.471Z",
 "mode": "twilio",
 "sent": 1,
 "failed": 0,
 "unknown": 0,
 "duplicates": 0,
 "blocked": 0,
 "open_leads": 9,
 "planned": 1,
 "still_active": 3,
 "excluded": 5,
 "exclusion_reasons": {
  "no marketing permission": 1,
  "opted out": 1,
  "no SMS consent or no mobile number": 1,
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
 "ran_at": "2026-10-20T12:21:18.478Z",
 "mode": "twilio",
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
  "no SMS consent or no mobile number": 1,
  "consent not recorded (source and date)": 1,
  "followed up within the cooldown": 2
 },
 "deferred_to_next_run": 0
}
```

### 9. Daniel replies YES to the reactivation SMS

```json
{
 "status": 200,
 "body": "<?xml version=\"1.0\" encoding=\"UTF-8\"?><Response></Response>"
}
```

### 10. Olivia replies STOP

```json
{
 "status": 200,
 "body": "<?xml version=\"1.0\" encoding=\"UTF-8\"?><Response></Response>"
}
```

### 11. Reactivation again after the replies (Daniel is active again, Olivia opted out)

```json
{
 "ok": true,
 "ran_at": "2026-10-20T12:21:18.510Z",
 "mode": "twilio",
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
  "no SMS consent or no mobile number": 1,
  "consent not recorded (source and date)": 1,
  "followed up within the cooldown": 1
 },
 "deferred_to_next_run": 0
}
```

### 12. Twilio reports Emma's acknowledgement delivered (signed status callback)

```json
{
 "status": 200
}
```

### 13. A lead whose mobile number Twilio refuses (error 21211)

```json
{
 "status": 200,
 "body": {
  "ok": true,
  "duplicate": false,
  "job_ref": "LJ-20261020-KAOD",
  "new_contact": true,
  "stage": "New Lead",
  "acknowledgement": {
   "status": "Failed",
   "channel": "SMS",
   "reason": "invalid phone number (not sent)"
  }
 }
}
```

### 14. Monitor: failed and unconfirmed messages, leads nobody contacted, finished jobs without a date

```json
{
 "ok": true,
 "ran_at": "2026-10-20T12:21:18.557Z",
 "mode": "twilio",
 "alerts_raised": 2,
 "problem_messages": 1,
 "stuck_sending": 0,
 "failed": 1,
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

### 15. Staff fix the number and tick Retry Requested; Monitor checks Twilio first, then resends once

```json
{
 "ok": true,
 "ran_at": "2026-10-20T12:21:18.573Z",
 "mode": "twilio",
 "alerts_raised": 0,
 "problem_messages": 1,
 "stuck_sending": 0,
 "failed": 1,
 "unknown": 0,
 "retry_requests": 1,
 "stale_leads": 1,
 "incomplete_jobs": 0,
 "retried": 1,
 "found_already_sent": 0,
 "retry_postponed": 0,
 "resent": 1,
 "resend_failed": 0,
 "resend_unknown": 0
}
```

### 16. Monitor again: nothing is resent

```json
{
 "ok": true,
 "ran_at": "2026-10-20T12:21:18.583Z",
 "mode": "twilio",
 "alerts_raised": 0,
 "problem_messages": 1,
 "stuck_sending": 0,
 "failed": 1,
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
| New Lead | LJ-DEMO-A3, LJ-20261020-8DJE |
| Contacted | LJ-DEMO-A2, LJ-DEMO-A5, LJ-20261020-K427, LJ-20261020-KAOD |
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
| Lead Follow-Up | Operational | ZZ Lite Demo Emma Walsh | LJ-20261020-K427 | SMS | Delivered | 0400000201 |
| Lead Follow-Up | Operational | ZZ Lite Demo Emma Walsh | LJ-20261020-K427 |  | Skipped | repeat enquiry within 30 days of LJ-20261020-K427 |
| Lead Follow-Up | Operational | ZZ Lite Demo Ethan Cole | LJ-20261020-8DJE |  | Skipped | no SMS consent or no mobile number |
| Review Request | Review | ZZ Lite Demo Marcus Webb | LJ-DEMO-R2 |  | Skipped | no SMS consent or no mobile number |
| Review Request | Review | ZZ Lite Demo Priya Nair | LJ-DEMO-R3 |  | Skipped | opted out |
| Review Request | Review | ZZ Lite Demo Tom Fraser | LJ-DEMO-R4 |  | Skipped | no permission for review requests |
| Review Request | Review | ZZ Lite Demo Ben Carter | LJ-DEMO-R6 |  | Skipped | no permission for review requests |
| Review Request | Review | ZZ Lite Demo Olivia Chen | LJ-DEMO-R1 | SMS | Sent | 0400000101 |
| Review Request | Review | ZZ Lite Demo Grace Lee | LJ-DEMO-R5 | SMS | Sent | 0400000105 |
| Reactivation | Marketing | ZZ Lite Demo Daniel Brooks | LJ-DEMO-A1 | SMS | Sent | 0400000106 |
| Inbound Reply | Inbound | ZZ Lite Demo Daniel Brooks | LJ-DEMO-A1 | SMS | Received | reply recorded; enquiry reopened for a call |
| Inbound Reply | Inbound | ZZ Lite Demo Olivia Chen |  | SMS | Opt-Out | contact opted out of all messages |
| Lead Follow-Up | Operational | ZZ Lite Demo Sam Typo | LJ-20261020-KAOD | SMS | Failed | invalid phone number (not sent); resent as attempt 2 |
| Lead Follow-Up | Operational | ZZ Lite Demo Sam Typo | LJ-20261020-KAOD | SMS | Sent | 0400000302 |

## Lite Alerts

| Kind | Record | Detail |
|---|---|---|
| Delivery Failed | LM-20261020122118-OIBC | Lead Follow-Up message to 0400000301 failed: invalid phone number (not sent). Fix the cause, then tick Retry Requested. |
| Stuck Lead | LJ-DEMO-A3 | New Lead for more than 24 hours: nobody has contacted them yet. |

## What the fake Twilio received (accepted messages)

| To | Body |
|---|---|
| +61400000201 | Hi Emma, thanks for contacting ZZ Example Plumbing (test client) about roof leak repair. A plumber will call you today. Reply STOP to opt out. |
| +61400000101 | Hi Olivia, thanks for choosing ZZ Example Plumbing (test client) for your roof restoration. If you're happy with the work, a quick Google review would really help us: https://g.page/r/ZZ-EXAMPLE-PLUMBING/review Reply STOP to opt out. |
| +61400000105 | Hi Grace, thanks for choosing ZZ Example Plumbing (test client) for your skylight install. If you're happy with the work, a quick Google review would really help us: https://g.page/r/ZZ-EXAMPLE-PLUMBING/review Reply STOP to opt out. |
| +61400000106 | Hi Daniel, it's ZZ Example Plumbing (test client). You asked us about full re-roof a while ago - is it still on your list? Reply YES and we'll call you to book a free inspection. Reply STOP to opt out. |
| +61491570110 | ZZ Example Plumbing (test client) (Lite): 2 new alerts: 1 Delivery Failed, 1 Stuck Lead. See Lite Alerts in Airtable. |
| +61400000302 | Hi Sam, thanks for contacting ZZ Example Plumbing (test client) about blocked drain. A plumber will call you today. Reply STOP to opt out. |

## Sample message bodies

**Lead Follow-Up to 0400000201 (SMS)**

```
Hi Emma, thanks for contacting ZZ Example Plumbing (test client) about roof leak repair. A plumber will call you today. Reply STOP to opt out.
```

**Review Request to 0400000101 (SMS)**

```
Hi Olivia, thanks for choosing ZZ Example Plumbing (test client) for your roof restoration. If you're happy with the work, a quick Google review would really help us: https://g.page/r/ZZ-EXAMPLE-PLUMBING/review Reply STOP to opt out.
```

**Review Request to 0400000105 (SMS)**

```
Hi Grace, thanks for choosing ZZ Example Plumbing (test client) for your skylight install. If you're happy with the work, a quick Google review would really help us: https://g.page/r/ZZ-EXAMPLE-PLUMBING/review Reply STOP to opt out.
```

**Reactivation to 0400000106 (SMS)**

```
Hi Daniel, it's ZZ Example Plumbing (test client). You asked us about full re-roof a while ago - is it still on your list? Reply YES and we'll call you to book a free inspection. Reply STOP to opt out.
```
