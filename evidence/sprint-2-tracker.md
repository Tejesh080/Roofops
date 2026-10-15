# Sprint 2 tracker (testing and hardening, from `4099aa0`)

| # | Area | Issue (reproduced) | Fix | Verified |
|---|---|---|---|---|
| 1 | Copilot | Preview: DeepSeek 503 "Service is too busy" → 2/20 browser tests failed. Other failures: one 503 failed the whole question (no retry); a provider failure after `prepare_invoice` discarded the prepared card; a non-JSON gateway page showed a raw parse error; nothing worked without the AI | Bounded retries (3 attempts, 25 s each, 45 s deadline, 0.8/2 s backoff, `Retry-After` capped at 4 s; 4xx not retried). On failure, a deterministic answer from RoofOps data using the read-only tools only (project, attention today, open issues); never prepares; a preview already prepared is reported, not repeated. The drawer survives non-JSON errors | `test/copilot-resilience.test.ts` (6 unit + 4×2 engines); browser, local, AI unreachable: answers in 3–4 s, input stays enabled |
