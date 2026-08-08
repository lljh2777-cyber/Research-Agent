# Provider Runtime

Research Agent implements its provider layer independently. It does not combine or vendor the source trees of Cherry Studio, OpenAI Codex, or OpenCode.

## Runtime boundary

```text
Research UI
  -> providerRuntimeClient
  -> local Provider Runtime
     -> OpenAI Responses
     -> Anthropic Messages
     -> Gemini streamGenerateContent
     -> DeepSeek / OpenRouter / OpenAI-compatible Chat Completions
```

All public API adapters emit the same internal lifecycle:

```text
run.started
  -> message.delta / reasoning.delta
  -> usage.updated
  -> run.completed | run.failed
```

ChatGPT subscription access is intentionally outside this public API adapter. It continues through the official `codex app-server`, which owns OAuth, model discovery, conversation lifecycle, and operating-system credential storage.

## Design references and licensing

- [Cherry Studio](https://github.com/CherryHQ/cherry-studio) (AGPL-3.0): provider configuration, dynamic model catalogs, model capability presentation, MCP, skills, and knowledge-base settings informed the product boundary.
- [OpenAI Codex app-server](https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md) (Apache-2.0): thread/turn lifecycle, typed streaming notifications, model discovery, permissions, and sandbox separation informed the event model and the subscription-login boundary.
- [OpenCode provider transforms](https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/provider/transform.ts) (MIT): provider-neutral messages and provider-specific transforms informed the adapter boundary.

No third-party source code was copied into this implementation. If that changes later, the relevant copyright, license, and NOTICE material must be added before distribution.

## Security boundary

- Web milestone API keys remain session-only and are forwarded to the loopback adapter only for the selected request.
- Credentials are never embedded in provider URLs or written to application logs.
- Desktop packaging must move provider keys to Windows Credential Manager, macOS Keychain, or the corresponding OS secure store.
- ChatGPT refresh tokens remain managed by Codex and are not exposed to the browser application.

