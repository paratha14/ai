# Testing Strategy

This repository uses a contract-first strategy with risk-tiered live coverage.
It documents **current test scope only** and does not claim exhaustive correctness.

## Philosophy

Tests exist to catch regressions that would break users — not to prove every function works in isolation. Before writing a test, ask: **"what breaks if this regresses?"** If the answer is "nothing observable," skip it.

- Test **protocol boundaries** (what crosses between modules, what the user sees) not internal helpers.
- Test **failure modes** (what happens when the provider 500s, when the stream drops, when the key rotates) not happy-path plumbing.
- A function that formats a string or checks if a number is odd does not need its own test. If it breaks, a contract test that exercises the real flow will catch it.
- If adding a feature requires no new test because existing contracts already cover the regression surface, that's fine. Don't add a test just to bump the count.

The goal is a suite where every test file maps to a real failure scenario, and contributors can add code without feeling obligated to write ceremonial tests for trivial logic.

## Goals

- Catch protocol regressions before release with deterministic contract checks.
- Keep live tests focused on provider drift and high-risk behaviors.
- Avoid test-count inflation by mapping tests to concrete failure modes.
- Minimize mental load — a contributor adding a new provider or middleware should know exactly where tests go and what they need to cover, nothing more.

## Risk Tiers

- `tests/unit/contracts/**`
  - Core protocol behavior: retries, middleware lifecycle, tool loop semantics, proxy parsing, provider transforms.
  - No network calls.
  - PR gate.

- `tests/live/canary/**`
  - Per-provider `generate` + `stream` smoke checks.
  - Detects broken auth, endpoint drift, and stream wiring failures quickly.
  - Frequent gate.

- `tests/live/nightly/**`
  - Per-provider deeper contracts: structured output, tool loop execution, normalized invalid-model errors.
  - Includes provider-specific paths such as multi-API mode checks, embedding coverage, proxy transport, and provider caching coverage (gated).
  - Scheduled gate.

- `tests/live/release/**`
  - Expensive, high-value paths: image generation, media input, built-in tools, reasoning.
  - Implemented as provider-scoped file suites:
    - `tests/live/release/reasoning.live.test.ts`
    - `tests/live/release/image.live.test.ts`
    - `tests/live/release/media.live.test.ts`
    - `tests/live/release/builtin-tools.live.test.ts`
    - `tests/live/release/responses.live.test.ts`
    - `tests/live/release/openrouter.live.test.ts`
    - `tests/live/release/groq.live.test.ts`
    - `tests/live/release/cerebras.live.test.ts`
    - `tests/live/release/moonshot.live.test.ts`
    - `tests/live/release/ollama.live.test.ts`
    - `tests/live/release/proxy.live.test.ts`
  - Manual/release gate with `RUN_RELEASE_LIVE=1` plus per-provider access gates (API key + model env).

## Contract Test Map

Each contract file validates a specific protocol surface. This section exists so contributors can quickly find where a behavior is already tested — and avoid writing duplicate coverage.

### Core Protocol

| File | What It Protects |
|------|-----------------|
| `core/llm-core.contract` | Tool loop cycles, approval gates, capability rejection, cancellation surfacing, custom param passthrough |
| `core/llm-stream-retry.contract` | Stream retry event emission, partial-stream non-duplication on retry, noRetry enforcement |
| `core/embedding-image.contract` | Provider capability matrix for embedding/image, modality mismatch errors |
| `core/document-media.contract` | Document and media input handling across providers |
| `core/tool-strategy.contract` | Tool selection strategies and execution semantics |

### HTTP Layer

| File | What It Protects |
|------|-----------------|
| `http/fetch-retry.contract` | Retry-After header parsing with max clamp, timeout → UPPError normalization, beforeRequest hook per attempt |
| `http/retry-strategy.contract` | Exponential/linear backoff math, jitter, retryable vs non-retryable error codes, maxAttempts bounds |
| `http/sse-parser.contract` | Chunked event assembly, `[DONE]` termination, malformed JSON recovery |
| `http/key-strategies.contract` | Round-robin cycling, weighted probability, dynamic async keys, config-over-env fallback |

### Middleware

| File | What It Protects |
|------|-----------------|
| `middleware/middleware-order.contract` | Hook execution order: onStart → onRequest → onResponse (reverse) → onTurn (reverse) → onEnd (reverse). Event transformation and filtering semantics. runTurnHook continue-on-error guarantee (all middleware run even if one throws, first error re-thrown). |
| `middleware/middleware-isolation.contract` | Each middleware only writes to its own namespaced state keys. Logging and pubsub return stream events by reference. Pipeline doesn't mutate turns or leak into state. Persistence skips non-LLM modalities. Cross-middleware state keys don't collide. |
| `middleware/pipeline.contract` | Pipeline stage event shapes, continueOnError vs fail-fast, onStageError callback timing |
| `middleware/persistence.contract` | Thread message deduplication, turnStartIndex calculation, adapter failure wrapping |
| `middleware/pubsub-memory.contract` | Cursor monotonicity, stream lifecycle (create → append → publish → finalize), retry buffer clearing |
| `middleware/parsed-object.contract` | Incremental JSON parsing per index, state isolation across tool calls, reset on retry |
| `middleware/logging.contract` | Log level filtering, tool call/result gating, abort vs error differentiation |

### Provider Transforms

| File | What It Protects |
|------|-----------------|
| `providers/transform-invariants.contract` | Per-provider request shaping: system prompt normalization, tool result expansion, structured output mode selection, cache control preservation |
| `providers/first-party-transforms.contract` | Tool parameter normalization and structured output mode per provider |
| `providers/metadata-namespacing.contract` | Provider metadata must be namespaced, top-level fields must not leak, token count normalization |
| `providers/provider-matrix.contract` | All providers instantiate with correct type signatures |

### Types and Serialization

| File | What It Protects |
|------|-----------------|
| `types/thread-serialization.contract` | Message identity preservation across JSON round-trips, Turn append ordering, unknown message rejection |
| `types/message-stream-factories.contract` | Message constructor normalization, role/type guards, stream event factory shapes |

### Proxy

| File | What It Protects |
|------|-----------------|
| `proxy/webapi.contract` | Request body parsing/validation, tool binding requirements, SSE serialization |
| `proxy/modality-pass-through.contract` | Embedding/image param forwarding without mutation, header preservation, response deserialization |

### Utilities

| File | What It Protects |
|------|-----------------|
| `utils/partial-json.contract` | Incomplete JSON recovery, nested object repair, escape sequence handling |

## Test Infrastructure

### Mock Provider (`tests/helpers/mock-llm-provider.ts`)

All contract tests use `createMockLLMProvider()` instead of mocking internals. It accepts `onComplete` and `onStream` callbacks with an attempt counter, making multi-cycle scenarios (retries, tool loops) deterministic.

Supporting factories:
- `createTextResponse(text)` — standard LLM response
- `createUsage(input, output)` — token usage with cache fields

### Live Helpers (`tests/helpers/live.ts`)

- `envModel(name, fallback)` — model env var resolution with fallback
- `collectTextStream(stream)` — consumes a stream, returns text + event count + retry count + turn
- `createAddTool()` — deterministic math tool for tool loop tests

Use these instead of writing ad-hoc setup per test file.

## Provider Coverage Matrix

| Provider | Canary | Nightly | Release |
| --- | --- | --- | --- |
| anthropic | generate + stream | structured + tools + invalid model + cache_control (`RUN_ANTHROPIC_CACHE_LIVE=1`) | `reasoning.live` + `media.live` + `builtin-tools.live` |
| openai | generate + stream | structured + tools + invalid model + embedding | `reasoning.live` + `image.live` + `media.live` + `builtin-tools.live` |
| google | generate + stream | structured + tools + invalid model + embedding + cache API/cachedContent (`RUN_GOOGLE_CACHE_LIVE=1`) | `reasoning.live` + `image.live` + `media.live` + `builtin-tools.live` |
| responses | generate + stream | structured + tools + invalid model | `responses.live` |
| openrouter | generate + stream | completions structured + tools + invalid model + responses stream | `openrouter.live` |
| xai | generate + stream | completions structured + tools + invalid model + messages stream + responses stream | `image.live` + `builtin-tools.live` |
| groq | generate + stream | structured + tools + invalid model | `groq.live` |
| cerebras | generate + stream | structured + tools + invalid model | `cerebras.live` |
| moonshot | generate + stream | structured + tools + invalid model | `moonshot.live` |
| ollama | generate + stream (`OLLAMA_TEST_HOST` or `OLLAMA_TEST_MODEL`) | structured + tools + invalid model (`RUN_OLLAMA_LIVE=1`) | `ollama.live` |
| proxy | generate + stream (OpenAI/Anthropic backends) | structured + tools + stream transport + invalid model (`RUN_PROXY_LIVE` gate) | `proxy.live` (LLM + embedding + image transport) |

## Acknowledged Gaps

- Every provider has release-gated live coverage, but each file validates selected regression paths only.
- Passing this suite is a regression signal, not a completeness proof.
- Caching, image generation, reasoning, and built-in tools have live coverage only — no unit-level contracts. This is intentional; these features are thin wrappers over provider APIs where the real risk is provider drift, not local logic bugs.
- Cache live tests are opt-in and model-dependent:
  - `RUN_ANTHROPIC_CACHE_LIVE=1` with `ANTHROPIC_CACHE_TEST_MODEL` (or `ANTHROPIC_TEST_MODEL`).
  - `RUN_GOOGLE_CACHE_LIVE=1` with `GOOGLE_CACHE_TEST_MODEL` (or `GOOGLE_TEST_MODEL`).

## Execution

- `bun run test`: runs `test:unit`
- `bun run test:unit`: deterministic contract tests
- `bun run test:live`: alias for `test:live:canary`
- `bun run test:live:canary`: live smoke suite
- `bun run test:live:nightly`: deeper live drift suite
- `bun run test:live:release`: release pack (`RUN_RELEASE_LIVE=1`)
- `bun run test:all`: `test:unit` + `test:live:canary`
- Optional nightly gates:
  - `RUN_ANTHROPIC_CACHE_LIVE=1` enables `tests/live/nightly/anthropic-cache.live.test.ts`.
  - `RUN_GOOGLE_CACHE_LIVE=1` enables `tests/live/nightly/google-cache.live.test.ts`.
  - `RUN_OLLAMA_LIVE=1` enables Ollama nightly tests.
  - `RUN_PROXY_LIVE=0` disables proxy nightly tests.
- Release gates:
  - `RUN_RELEASE_LIVE=1` enables `tests/live/release/*.live.test.ts`.
  - Additional provider-specific release files:
    - `tests/live/release/responses.live.test.ts`: requires `OPENRESPONSES_API_KEY` or `OPENAI_API_KEY`.
    - `tests/live/release/openrouter.live.test.ts`: requires `OPENROUTER_API_KEY`.
    - `tests/live/release/groq.live.test.ts`: requires `GROQ_API_KEY`.
    - `tests/live/release/cerebras.live.test.ts`: requires `CEREBRAS_API_KEY`.
    - `tests/live/release/moonshot.live.test.ts`: requires `MOONSHOT_API_KEY` or `KIMI_API_KEY`.
    - `tests/live/release/ollama.live.test.ts`: requires `OLLAMA_TEST_MODEL` or `OLLAMA_TEST_HOST`.
    - `tests/live/release/proxy.live.test.ts`: local Bun server only; no external provider key required.
  - `reasoning.live` requires API key + model gate for each provider:
    - OpenAI: `OPENAI_API_KEY` + `OPENAI_REASONING_TEST_MODEL` (fallback: `OPENAI_TEST_MODEL`).
    - Anthropic: `ANTHROPIC_API_KEY` + `ANTHROPIC_REASONING_TEST_MODEL` (fallback: `ANTHROPIC_TEST_MODEL`).
    - Google: `GOOGLE_API_KEY` + `GOOGLE_REASONING_TEST_MODEL` (fallback: `GOOGLE_TEST_MODEL`).
  - `image.live` requires:
    - OpenAI: `OPENAI_API_KEY` + `OPENAI_IMAGE_TEST_MODEL`.
    - Google: `GOOGLE_API_KEY` + `GOOGLE_IMAGE_TEST_MODEL`.
    - xAI: `XAI_API_KEY` + `XAI_IMAGE_TEST_MODEL`.
  - `media.live` requires API key + model gate:
    - OpenAI: `OPENAI_API_KEY` + `OPENAI_MEDIA_TEST_MODEL` (fallback: `OPENAI_TEST_MODEL`).
    - Anthropic: `ANTHROPIC_API_KEY` + `ANTHROPIC_MEDIA_TEST_MODEL` (fallback: `ANTHROPIC_TEST_MODEL`).
    - Google: `GOOGLE_API_KEY` + `GOOGLE_MEDIA_TEST_MODEL` (fallback: `GOOGLE_TEST_MODEL`).
  - `builtin-tools.live` requires API key + model gate:
    - OpenAI: `OPENAI_API_KEY` + `OPENAI_BUILTIN_TOOLS_TEST_MODEL` (fallback: `OPENAI_TEST_MODEL`).
    - Anthropic: `ANTHROPIC_API_KEY` + `ANTHROPIC_BUILTIN_TOOLS_TEST_MODEL` (fallback: `ANTHROPIC_TEST_MODEL`).
    - Google: `GOOGLE_API_KEY` + `GOOGLE_BUILTIN_TOOLS_TEST_MODEL` (fallback: `GOOGLE_TEST_MODEL`).
    - xAI: `XAI_API_KEY` + `XAI_BUILTIN_TOOLS_TEST_MODEL` (fallback: `XAI_TEST_MODEL`).

## Authoring Rules

- One provider per live test file.
- Unit tests assert protocol contracts, not internal implementation details.
- Each new test must map to a specific regression risk. If you can't name what breaks without it, don't write it.
- Don't test trivial logic (formatters, type guards, simple math) in isolation. If it matters, a contract test exercising the real flow will catch it.
- Reuse helpers in `tests/helpers/**`; avoid setup duplication.
- Keep assertions deterministic and avoid brittle exact-text checks.
- New providers need: one canary file (generate + stream), one nightly file (structured + tools + invalid model), and relevant entries in an existing release file if applicable.
- New middleware needs: one contract file validating its lifecycle hooks and edge cases. Skip if the middleware is trivial passthrough.
