# Generation boundary (DYAI-37)

`POST /api/generate` turns one source image and one Visual Command into one generated image through
OpenRouter. It runs only for an authenticated principal, within a per-principal burst limit and
generation quota, a global daily spend budget, and a kill switch, and only for a command whose
Command → Recipe → Model contract resolves to an approved, allowlisted model (`docs/contracts.md`).
Everything that is not configured fails closed.

Product sources: Jira DYAI-37 (parent DYAI-29); Confluence 04.1 v0.5 §5, §6, §9, §13, §14, §16;
04.2 v1.3 §8–§10; 09 D-013, D-014, D-017. Ported from the migration source `DYAI-Studio/DYAI-slash-cmnd`
draft PR #3 head `967e0e0522e7dd8bcedcfffaa4296aa7ce195b7d` (`docs/migration-sources.md`); that code
resolved commands from an in-memory contract over the JSON files and was adapted, not copied (see
Resolution boundary).

## Request

`multipart/form-data` with exactly these fields; any other field is rejected (`unexpected_field`):

| Field | Required | Value |
| --- | --- | --- |
| `command` | yes | Canonical slash (`/actionfigure`), a publicly allowed alias, or a command id |
| `image` | yes | The source image file. JPEG, PNG or WebP, identified from its bytes; a declared part type other than the detected one is rejected (an empty type or `application/octet-stream` is accepted and the bytes decide) |
| `parameters` | no | JSON object of recipe parameter values, all strings (for example `{"packaging":"none"}`); a `string`-typed parameter takes one line of at most 200 characters without control characters |

`Authorization: Bearer <token>` identifies the principal (see Authentication). There is no free-text
instruction field in this slice: the provider prompt is built on the server from the recipe only.

## Response

`200`:

```json
{
  "status": "succeeded",
  "requestId": "…",
  "command": { "id": "actionfigure", "slash": "/actionfigure", "lane": "play" },
  "recipe": { "id": "actionfigure-v1", "version": "0.1.0", "truthMode": "creative_entertainment" },
  "synthetic": true,
  "output": { "mimeType": "image/png", "width": 1024, "height": 1024, "byteLength": 123456, "base64": "…" }
}
```

`synthetic: true` marks every result as a synthetic AI visualisation (04.1 §4). The response never
contains the prompt, the provider model id, provider cost or any provider response text.

Errors are `{ "error": "<code>", "requestId": "…" }`, plus `retryAfterSeconds` and a `Retry-After`
header where a retry can succeed later. All responses carry `Cache-Control: no-store`.

## Order of checks

Each step fails closed, and nothing reaches OpenRouter unless every earlier step passed:

1. kill switch;
2. configuration (auth, rate limit, budget, provider key, limits);
3. authentication;
4. burst limit (every authenticated attempt counts);
5. bounded body read and parse;
6. command (repository), then the central command stop list;
7. recipe → model → execution plan through the repositories and the model registry (Resolution
   boundary), then the central model stop list;
8. execution profile for the model, source image (count, type from bytes, dimensions) and recipe parameters;
9. one generation in flight per principal;
10. generation quota reservation;
11. global spend reservation, then the kill switch once more;
12. provider call, then settle quota and spend.

| Status | `error` | Meaning |
| --- | --- | --- |
| 400 | `invalid_request`, `invalid_command`, `unexpected_field`, `image_required`, `image_empty`, `too_many_images`, `image_type_mismatch`, `invalid_parameters` | Malformed request |
| 401 | `authentication_required` | No or wrong credential |
| 404 | `command_not_found` | No command resolves the given slash or id |
| 409 | `generation_in_flight` | This principal already has a generation running |
| 413 | `request_too_large`, `image_too_large` | Body or image above the configured cap |
| 415 | `unsupported_content_type`, `unsupported_image_type` | Not multipart, or image not one the command accepts |
| 422 | `command_not_executable` (+ `detail`: `recipe_not_assigned`, `command_not_executable`, `no_compatible_model`, `no_approved_model`) | The contract does not resolve an approved execution |
| 422 | `image_dimensions_out_of_range` | Shorter edge below the minimum or longer edge above the maximum |
| 422 | `source_image_rejected`, `content_refused` | The provider refused the image or the content |
| 429 | `rate_limited`, `quota_exceeded` | Burst limit or generation quota reached |
| 503 | `generation_disabled`, `command_disabled`, `model_disabled` | Kill switch or stop list |
| 503 | `budget_exhausted` | The daily budget cannot cover another reservation |
| 503 | `server_security_boundary_not_configured`, `provider_not_configured`, `execution_not_configured` | Missing configuration, or repository data that does not form a valid contract |
| 503 | `provider_busy`, `provider_unavailable` | Provider rate limit, credits or routing unavailable |
| 502 | `provider_failed`, `provider_rejected_request`, `provider_invalid_response`, `provider_unreachable` | Provider failure, sanitized |
| 504 | `provider_timeout` | Provider did not answer in `OPENROUTER_TIMEOUT_MS` |
| 500 | `generation_boundary_failed` | Unexpected server error, sanitized |

## Resolution boundary

Generation resolves Command → Recipe → Model only through the application boundary
(`src/server/generation/resolve.ts`):

- the command from `CommandRepository` (`findBySlash` for a slash or alias, `getById` for an id);
- its recipe from `RecipeRepository.getById`;
- the models from the Model Capability registry port (`src/server/models`), which stays separate from
  authoring persistence (ADR-0001, `docs/architecture.md`).

Bootstrap binds the repositories to the validated static adapter (`src/server/catalogue/static-adapter.ts`);
DYAI-39 replaces that adapter without changing this path. Whatever the repositories return is the
runtime truth: no generation code reads `catalogue.json` or `recipes.json`, and none uses the in-memory
contract in `src/server/contract/`. `tests/generation-boundary.test.mjs` enforces this on the import
graph of the route and the generation scripts (with a canary that proves the check detects a
violation).

Each request reads one command, its one recipe and the registry once, and validates exactly that
snapshot (the command record on its own first, so a malformed record or a recipe id that resolves to
nothing is a data error, not a client error) with the domain contract validator before anything else uses it, so the cross-document
invariants (an allowlisted model needs a passing benchmark and an approved privacy review, an approved
adapter needs a passing test, …) hold for repository data too. A snapshot that fails validation answers
`503 execution_not_configured` and never reaches the provider. Resolution failures keep their contract
codes (`422 command_not_executable` with `detail`). The generation scripts resolve through the same
module (`scripts/lib/plan.mjs`), so the plan they record is the plan the server executes.

## Configuration

All variables are server-only. Required values have no defaults; numeric limits are configurable,
and none of them is a product decision (04.1 §6.9: quotas and budgets stay TBD until cost and
traffic are baselined).

| Variable | Required | Meaning |
| --- | --- | --- |
| `AUTH_PROVIDER` | yes | `integration_token` is the only adapter in this slice; unset or anything else fails closed |
| `AUTH_INTEGRATION_TOKEN_SHA256` | with `integration_token` | Lowercase hex SHA-256 of the bearer token. The token itself is not configured on the server |
| `AUTH_INTEGRATION_PRINCIPAL` | no (`integration`) | Principal id for that token |
| `RATE_LIMIT_PROVIDER` | yes | `memory` (process-local); unset or anything else fails closed |
| `RATE_LIMIT_BURST_MAX`, `RATE_LIMIT_BURST_WINDOW_SECONDS` | yes | Attempts per principal per sliding window |
| `RATE_LIMIT_QUOTA_MAX`, `RATE_LIMIT_QUOTA_WINDOW_SECONDS` | yes | Successful generations per principal per sliding window |
| `GENERATION_DAILY_BUDGET_USD` | yes | Global spend per UTC day |
| `GENERATION_MAX_COST_PER_REQUEST_USD` | yes | Reserved per generation before the provider call; at most the daily budget |
| `GENERATION_KILL_SWITCH` | no | Off only when unset, empty, `off`, `0` or `false`; any other value stops all generation |
| `GENERATION_DISABLED_COMMANDS`, `GENERATION_DISABLED_MODELS` | no | Comma-separated command ids / model ids to block |
| `OPENROUTER_API_KEY` | yes | Sent only in the `Authorization` header to OpenRouter |
| `OPENROUTER_BASE_URL` | no (`https://openrouter.ai/api/v1`) | `https`, or `http` on loopback for a local stub |
| `OPENROUTER_TIMEOUT_MS` | no (120000) | 1000–300000 |
| `GENERATION_MAX_UPLOAD_BYTES` | no (8 MiB) | Source image cap |
| `GENERATION_MIN_IMAGE_EDGE_PX`, `GENERATION_MAX_IMAGE_EDGE_PX` | no (64, 4096) | Source image dimension bounds |
| `GENERATION_MAX_OUTPUT_BYTES` | no (20 MiB) | Generated image cap |

The services are built once per server process from its environment, on the first request that
finds a complete configuration; the kill switch and stop lists are re-read on every request.

## Authentication

`AUTH_PROVIDER=integration_token` maps one operator-provisioned bearer token to one fixed principal,
compared by SHA-256 in constant time. It exists so the boundary can be exercised as an authenticated
caller before DYAI-35 wires real user login. It is opt-in, absent from the default runtime, and not a
user login: do not configure it on a public deployment. DYAI-35 adds its adapter in
`src/server/auth/provider.ts`.

## Rate limit, quota and spend

- **Burst limit:** every authenticated attempt counts, whatever its outcome. Rejected attempts are
  not recorded, so they do not extend the window.
- **Generation quota:** a slot is reserved before the provider call and committed only when the
  generation succeeds; a failed or blocked generation returns its slot (DYAI-29: failed/blocked
  requests do not consume the quota of a successful generation). Pending slots count, so concurrent
  requests cannot overshoot.
- **Spend:** each generation reserves `GENERATION_MAX_COST_PER_REQUEST_USD` before the call; a
  reservation is rejected when spent + reserved + this reservation would exceed the daily budget. On
  settlement the reservation is replaced by OpenRouter's reported `usage.cost`; it is kept as the
  charge when the cost is unknown (timeout, network failure, malformed success); it is released when
  the provider returned an HTTP error (OpenRouter image billing is all-or-nothing: failed generations
  are not billed). A cost above the reservation is recorded in full, so the budget can be exceeded by
  the overshoots of the generations that were in flight at the same time (at most one per principal;
  with the single integration principal of this slice, at most one).
- **In flight:** one generation per principal at a time (`409`).

**Single-instance limitation.** The limiter, quota, spend ledger and in-flight set live in the memory
of one server process. Several instances each keep their own counts, and a restart resets them. This
is acceptable for this non-deployed slice only; it is not a distributed or durable control. A shared
store is required before any multi-instance or public deployment (DYAI-20), and that choice is an
architecture decision (09 D-013 excludes a cache/database until evidence requires one).

## Processing and retention boundary

- The source image is read into memory for the request, checked, sent once to OpenRouter as a base64
  data URL, and dropped when the request ends. It is not written to disk, a database or a log.
- The generated image is decoded from OpenRouter's `b64_json`, checked (type from bytes, size,
  dimensions), returned in the response body, and dropped. It is not stored.
- Telemetry (`src/server/telemetry/generation.ts`) writes one JSON line per attempt with request id,
  outcome, error code, HTTP status, command id, lane, recipe id/version, model id, latency, provider
  latency and status, provider-reported cost, and for an unexpected 500 the error class name. It never contains image bytes or base64, prompt
  text, provider response text, credentials or the principal id.
- OpenRouter receives a hashed principal id (`user`), which it hashes again and does not forward raw.
- Upstream retention is governed by the provider (see Privacy review).

## Model, routing and privacy review

Execution profiles (`EXECUTION_PROFILES` in `src/server/openrouter/client.ts`) pin each executable
model to named OpenRouter endpoints with `allow_fallbacks: false`; a model without a profile is not
executed. Only `google/gemini-3.1-flash-image` has one: endpoint `google-vertex/global`, resolution
`1K`, `n: 1`. The pin is the privacy control, because the Image API (`POST /api/v1/images`) documents
only `only`, `order`, `ignore`, `sort` and `allow_fallbacks` as routing fields, not `zdr` or
`data_collection`.

Provider state re-queried 2026-10-08 (public OpenRouter endpoints, no generation call):

- `google/gemini-3.1-flash-image` is listed (no expiry), input `image, text`, output `image, text`;
  on the Image API its endpoints take up to 14 `input_references` and `n` 1. Endpoints:
  `google-ai-studio` and `google-vertex/global`. Only `google-vertex/global` is on the
  zero-data-retention list (`GET /api/v1/endpoints/zdr`). Provider data policy: Google Vertex
  `training: false`, `retainsPrompts: false`; Google AI Studio `retainsPrompts: true` (55 days), which
  the pin excludes.
- `openai/gpt-5-image-mini` is listed; its only endpoint (`openai`) is not on the ZDR list and its data
  policy is `retainsPrompts: true`. It has no execution profile and is not executable.

**Registry state in this repository: both models are `candidate`, `unbenchmarked`,
`privacyReview: unreviewed`.** Nothing is executable. The migration source recorded a bounded privacy
review (synthetic, non-personal fixtures sent by the operator integration principal) and flipped the
registry to `approved`; that change is not ported, because an approval is a decision with its own
evidence, not code. The registry schema cannot express a scoped approval (`policy` has only
`privacyReview` and `dataRetention`), so any future `approved` must name its scope in `evidenceRefs`.
**Real user photos are not covered by any review.** Before public use, the provider/retention
configuration and the privacy notice need a PO/legal review (DYAI-29), including face photos as
possible biometric data, the absence of an EU in-region endpoint for this model, and abuse-monitoring
retention.

## Qualification (what would make `/actionfigure` executable)

The contract allows execution only with an `allowed` model (active, `benchmarkStatus: passed`,
`privacyReview: approved`) and an `approved` recipe adapter backed by a passing test record. DYAI-37
qualifies one technical path, `/actionfigure` (`actionfigure-v1`) on `google/gemini-3.1-flash-image`:

1. `node scripts/qualify-model.mjs --live` makes one real OpenRouter Image API call through the route's
   adapter with `tests/fixtures/qualification/synthetic-figure-01.png` (a programmatically drawn
   cartoon figure; regenerate with `scripts/make-qualification-fixture.mjs`) and writes
   `docs/evidence/dyai-37/qualification-*.json` (metadata and hashes only, plus the commit it ran on).
   It refuses a second call when a passing record for the same model, fixture and prompt exists.
2. Only after a technical pass: a separate commit records the test on the recipe (`testedModels`,
   `evaluationStatus: fixture_tested`, an approved adapter) and moves the model to `allowed` with
   `benchmarkStatus: passed` and a scoped privacy approval, citing the evidence file and its sha256.
   "Passed" means the narrow technical check in that file (HTTP 200, a decodable image within limits,
   reported cost), not a quality, likeness or user-value benchmark. That commit is the explicit,
   reviewable point at which a model becomes executable; nothing else changes the registry.
3. `npm run build` on that clean commit, then `node scripts/live-route-smoke.mjs --live` runs one real
   generation through `next start` over HTTP and writes `docs/evidence/dyai-37/live-route-*.json`. It
   refuses to run unless the working tree is clean and the build (`.next/dyai-build-source.json`,
   written by `postbuild`) was made from `HEAD`, and it records that commit as the candidate.

Status: see `docs/evidence/dyai-37/`. Steps 1–3 need an `OPENROUTER_API_KEY` with available account
credit; until they pass, no command is executable.

## Verification

- `npm test`: unit tests for every check above, with fake providers (`tests/generation-*.test.mjs`,
  `tests/openrouter-client.test.mjs`).
- `npm run smoke:runtime` (part of `npm run verify`, after the build): starts `next start` per
  environment group and calls the route over HTTP against a stub OpenRouter on loopback — default
  fail-closed, 401, input rejection, contract rejection, burst limit, kill switch, and, when the
  committed repositories resolve an executable command, success, budget exhaustion, cost telemetry and
  sanitized provider errors. It greps the server log for the key, token, provider error text and image
  base64. It proves the route/runtime boundary, not the external provider.
- The two `--live` scripts above prove the external boundary. Mocked tests are never evidence for it.
