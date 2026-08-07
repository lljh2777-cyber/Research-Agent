# ChatGPT API integration notes

## Scope

Research-Agent currently supports one account login: ChatGPT Plus/Pro through the Codex-compatible OAuth route. Other subscription providers are intentionally out of scope.

This route must not be presented as the public OpenAI Platform API. The public API uses API credentials and separate billing. The local bridge instead follows the login-based Codex transport used by current open-source desktop and coding clients.

## Source comparison

### Cherry Studio

Cherry Studio models provider identity, wire protocol, and SDK adapter as separate concepts. Its OpenAI Codex provider selects the OpenAI Responses adapter, changes the base URL to the ChatGPT Codex backend, and injects OAuth credentials in a custom fetch layer.

Relevant implementation:

- [`packages/provider-registry/src/providers/openai-codex.ts`](https://github.com/CherryHQ/cherry-studio/blob/main/packages/provider-registry/src/providers/openai-codex.ts)
- [`src/main/ai/provider/codex.ts`](https://github.com/CherryHQ/cherry-studio/blob/main/src/main/ai/provider/codex.ts)
- [`src/main/services/oauth/runtime/OAuthRuntimeService.ts`](https://github.com/CherryHQ/cherry-studio/blob/main/src/main/services/oauth/runtime/OAuthRuntimeService.ts)
- [`docs/references/ai/stream-manager.md`](https://github.com/CherryHQ/cherry-studio/blob/main/docs/references/ai/stream-manager.md)

The useful patterns are request coercion, a single authenticated-fetch boundary, one forced refresh after `401`, and a stream manager that owns cancellation and persistence outside the renderer.

### OpenCode

OpenCode registers OAuth as a provider hook. Its fetch wrapper removes SDK-generated authorization, injects the current bearer token and ChatGPT account id, rewrites Responses/Chat Completions URLs to the Codex endpoint, and shares in-flight token refresh work.

Relevant implementation:

- [`packages/opencode/src/plugin/openai/codex.ts`](https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/plugin/openai/codex.ts)

The useful patterns are PKCE with loopback callback, refresh-token rotation, account-id extraction from JWT claims, a strict subscription model allowlist, and provider-specific request headers.

### OpenAI public API

OpenAI recommends the Responses API for new public API projects. Its streaming transport emits typed server-sent events such as `response.output_text.delta` and `response.completed`.

- [Responses API migration guide](https://developers.openai.com/api/docs/guides/migrate-to-responses)
- [Streaming API responses](https://developers.openai.com/api/docs/guides/streaming-responses)

## Current Research-Agent contract

The browser talks only to the loopback service at `127.0.0.1:4318`:

- `GET /api/auth/status`
- `POST /api/auth/chatgpt/start`
- `POST /api/auth/chatgpt/logout`
- `POST /api/chatgpt/responses/stream`

The stream endpoint returns local SSE events:

- `start`: selected model metadata
- `delta`: one text increment
- `completed`: final text, model, response id, and usage when available
- `error`: a safe error message

OAuth tokens never enter browser storage. The loopback service stores them outside the repository, refreshes shortly before expiry, and retries one request after a `401`. The upstream request is forced to `store: false`, includes `reasoning.encrypted_content`, and uses a curated model allowlist.

## Next architecture step

When the Web prototype is stable, move the stream lifecycle into the desktop main process. Keep active runs keyed by conversation id, buffer recent deltas for renderer reattachment, persist terminal results, and use an `AbortController` per execution. This follows the durable part of Cherry Studio's design without importing its multi-provider complexity.
