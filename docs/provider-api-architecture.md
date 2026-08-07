# Provider API architecture

## Product boundary

The current product exposes only ChatGPT Plus/Pro login. This document maps the other API families we may support later; it does not authorize, configure, or display any additional provider today.

An account provider and an API protocol are different concepts. For example, Azure OpenAI and the public OpenAI Platform can both speak the Responses protocol, while DeepSeek, Qwen-compatible gateways, and many relays speak an OpenAI Chat Completions protocol. The runtime should therefore resolve four independent fields:

```text
provider identity -> authentication method -> protocol adapter -> endpoint/model
```

This follows the useful part of Cherry Studio's provider resolution design: the user-facing provider id is not used as the wire-protocol switch.

## Protocol families

| Protocol family | Typical providers | Request shape | Streaming shape | Authentication |
| --- | --- | --- | --- | --- |
| `openai-responses` | OpenAI Platform, Azure OpenAI, ChatGPT/Codex compatibility route | `model`, `instructions`, `input`, `tools`, `stream` | typed SSE events such as `response.output_text.delta` and `response.completed` | API key, Entra token, or provider-specific OAuth |
| `openai-chat` | DeepSeek, many Qwen/Model Studio gateways, OpenRouter-style relays | `model`, `messages`, `tools`, `stream` | SSE chunks under `choices[].delta`, ending with `[DONE]` | usually bearer API key |
| `anthropic-messages` | Anthropic API, compatible Bedrock/Vertex routes | `model`, `system`, `messages`, `max_tokens`, `stream` | named SSE lifecycle: `message_start`, content block events, `message_stop` | `x-api-key`/Anthropic version headers or cloud IAM |
| `google-generate-content` | Gemini API, Vertex Gemini | `contents[].parts`, `systemInstruction`, generation/tool config | SSE stream of `GenerateContentResponse` objects | `x-goog-api-key` or Google IAM |
| `ollama-chat` | Local Ollama | `model`, `messages`, `tools`, `think`, `stream` | newline-delimited JSON; terminal object has `done:true` | none on local loopback; deployment-specific otherwise |
| `bedrock-converse` | Amazon Bedrock multi-model runtime | `modelId`, `messages`, `system`, `toolConfig` | AWS event stream from `ConverseStream` | SigV4/IAM |

Primary references:

- [OpenAI Responses API](https://developers.openai.com/api/docs/guides/migrate-to-responses)
- [Anthropic Messages streaming](https://platform.claude.com/docs/en/build-with-claude/streaming)
- [Gemini API reference](https://ai.google.dev/api)
- [DeepSeek Chat Completions](https://api-docs.deepseek.com/api/create-chat-completion/)
- [Ollama chat API](https://docs.ollama.com/api/chat)
- [Amazon Bedrock ConverseStream](https://docs.aws.amazon.com/bedrock/latest/APIReference/API_runtime_ConverseStream.html)
- [Azure OpenAI Responses](https://learn.microsoft.com/en-us/rest/api/microsoft-foundry/azureopenai/responses)

## Canonical runtime contract

Provider adapters should accept one internal request:

```ts
interface ResearchModelRequest {
  runId: string
  model: string
  instructions?: string
  messages: Array<{
    role: 'user' | 'assistant' | 'system' | 'tool'
    content: ContentPart[]
  }>
  tools?: ResearchTool[]
  signal: AbortSignal
  options?: {
    temperature?: number
    reasoningEffort?: string
    maxOutputTokens?: number
  }
}
```

Each wire adapter converts this request into its own protocol and emits the same internal event union:

```ts
type ResearchStreamEvent =
  | { type: 'start'; runId: string; model: string }
  | { type: 'text-delta'; text: string }
  | { type: 'reasoning-delta'; text: string }
  | { type: 'tool-call'; id: string; name: string; argumentsDelta?: string }
  | { type: 'tool-result'; id: string; result: unknown }
  | { type: 'usage'; inputTokens?: number; outputTokens?: number }
  | { type: 'complete'; responseId?: string; finishReason?: string }
  | { type: 'error'; code?: string; message: string; retryable: boolean }
```

The UI should consume only this normalized stream. It must never parse OpenAI, Anthropic, Gemini, Ollama, or AWS wire events directly.

## Registry shape

A future registry entry should declare capabilities rather than rely on provider-name checks:

```json
{
  "id": "anthropic-api",
  "label": "Anthropic API",
  "protocol": "anthropic-messages",
  "auth": "api-key",
  "modelCatalog": "remote",
  "baseUrl": "https://api.anthropic.com",
  "capabilities": {
    "streaming": true,
    "tools": true,
    "vision": true,
    "reasoning": true
  }
}
```

Model availability, context limits, and tool support belong to the model record, not a hard-coded UI list. Providers with an authenticated model-catalog endpoint should discover and cache account-visible models; routes that cannot list models should use a curated, versioned registry.

## Error and retry policy

Adapters should normalize HTTP failures and in-stream failures separately. Retry only requests that are safe to repeat and have not produced an irreversible tool side effect.

- `401/403`: refresh or re-authenticate according to the credential strategy; retry at most once after a successful refresh.
- `408/425/429` and transient `5xx`: bounded exponential backoff with jitter and provider `Retry-After` support.
- malformed request or unsupported model: fail without retry.
- interrupted stream after visible text: preserve partial output and mark it incomplete.
- tool call already executed: resume from persisted run state rather than replaying the full model request blindly.

## Secret boundary

API keys, OAuth refresh tokens, IAM credentials, and cloud service-account material must remain in the local service or later desktop main process. The renderer receives provider status, model metadata, and normalized stream events only. A Web deployment would require server-side sessions and encrypted secret storage; loopback trust is not a public-host security model.

## Implementation order

1. Keep the existing ChatGPT adapter as the only enabled credential route.
2. Extract the current Responses SSE parser into the canonical event contract.
3. Add protocol adapters in this order when requested: OpenAI-compatible Chat, Anthropic Messages, Gemini, Ollama, then cloud IAM variants.
4. Add API-key/IAM configuration only together with secure desktop storage; do not place provider secrets in browser local storage.
5. Move stream ownership, cancellation, replay buffering, and terminal persistence to the Electron main process before desktop release.
