# LM Studio configuration

LM Studio is already wired into your `handleLocalChat` via `process.env.NEXT_PUBLIC_LMSTUDIO_URL + "/v1/chat/completions"`, so configuration is just wiring the LM Studio server + env vars + model ids, and (optionally) swapping to the AI SDK provider if you want responses-style models instead of raw fetch. In LM Studio: install and load the model you want (e.g. `llama-3.2-1b`), then in the “Local Server” tab click “Start Server”; by default this exposes an OpenAI-compatible API at `http://localhost:1234/v1` serving `/chat/completions`, `/responses`, `/embeddings`, etc. [ai-sdk.dev+1](https://ai-sdk.dev/providers/openai-compatible-providers/lmstudio?utm_source=chatgpt.com) In your Chatbot UI repo, set up `.env.local` with the LM Studio base URL so your existing `handleLocalChat` code works:

```bash
# .env.local
NEXT_PUBLIC_LMSTUDIO_URL=http://localhost:1234
```

Your `handleLocalChat` will then hit `http://localhost:1234/v1/chat/completions` with `model: chatSettings.model` and `messages: formattedMessages`, which matches LM Studio’s OpenAI-compatible chat endpoint expectations. [LM Studio](https://lmstudio.ai/docs/developer/openai-compat?utm_source=chatgpt.com) In the Chatbot UI database (Supabase `llms` / `models` tables depending on your schema), define a model entry whose `provider` is whatever your `use-chat-handler` branches to `handleLocalChat` on (in the stock code this is `"ollama"`, so use that provider string) and set its `model` / `model_id` to the _exact_ LM Studio model identifier shown in the LM Studio UI (the same string you would pass as `"model"` in a raw OpenAI-style request). [LM Studio](https://lmstudio.ai/docs/developer/openai-compat?utm_source=chatgpt.com) Then, in the app’s UI, pick that model for the chat; when `modelData.provider === "ollama"` (or your local-provider label), your existing code will go down `handleLocalChat`, hit LM Studio, and stream chunks using the newline-delimited JSON logic you already have commented for “lmstudio’s streaming endpoint returns new-line separated JSON objects”.

If you want to run this through the Vercel AI SDK instead of manual `fetch`, configure LM Studio as an AI SDK provider using the OpenAI-compatible package:

```ts
// path: lib/ai/providers/lmstudio.ts
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'

export const lmstudio = createOpenAICompatible({
  name: 'lmstudio',
  baseURL: process.env.LMSTUDIO_BASE_URL ?? 'http://localhost:1234/v1',
})
```

`createOpenAICompatible` is the AI SDK’s generic OpenAI-style provider factory and is what their LM Studio docs expect. [ai-sdk.dev+1](https://ai-sdk.dev/providers/openai-compatible-providers?utm_source=chatgpt.com) Then, in your chat route that currently uses `openai(...)`, swap to `lmstudio(...)` and point at the LM Studio model id:

```ts
// path: app/api/chat/route.ts
import { streamText } from 'ai'
import { lmstudio } from '@/lib/ai/providers/lmstudio'

export async function POST(req: Request) {
  const { messages } = await req.json()

  const result = await streamText({
    model: lmstudio(process.env.LMSTUDIO_MODEL ?? 'llama-3.2-1b'),
    messages,
    maxRetries: 1, // fail fast if LM Studio server is down
  })

  return result.toAIStreamResponse()
}
```

Here `LMSTUDIO_BASE_URL` (e.g. `http://localhost:1234/v1`) and `LMSTUDIO_MODEL` (e.g. `llama-3.2-1b`) live in `.env.local`, and the AI SDK handles mapping the OpenAI-compatible LM Studio API into its unified provider interface. [ai-sdk.dev+1](https://ai-sdk.dev/providers/openai-compatible-providers/lmstudio?utm_source=chatgpt.com) With this setup, the Chatbot UI frontend stays unchanged; the “hosted” path uses AI SDK + `lmstudio(...)` when you select that model, and the “local” path uses your existing `handleLocalChat` hitting `NEXT_PUBLIC_LMSTUDIO_URL` directly, both backed by LM Studio’s OpenAI-compatible endpoints.


Thread 1 – 500 error diagnosis: The 500 on `/api/chat/custom` was interpreted as a backend failure rather than a frontend issue, most likely caused by either an unimplemented or malformed route handler (wrong export, missing `POST`, not returning a `Response`, or throwing when reading env vars). The error lined up with you switching provider wiring, so the failure was treated as a consequence of routing requests for a provider that no longer had a valid server implementation behind `/api/chat/custom`.

Thread 2 – Provider and LM Studio wiring: The internal model of the situation was that you started from the template’s “ollama” local provider, then pointed it at LM Studio’s OpenAI-compatible server. From there, the main conclusion was that the model entry must still use the provider key that the local code path expects (e.g. `"ollama"`), with the LM Studio base URL and model id swapped in via env/config, and that switching the provider label to `"custom"` without wiring a matching route would immediately surface as 500s.

Thread 3 – Local vs custom route strategy: There were two competing strategies considered: keep everything on the existing `handleLocalChat` path (simpler; just change base URL/model and ignore `/api/chat/custom` entirely), or introduce a full `/api/chat/custom` implementation using the AI SDK with an OpenAI-compatible provider pointed at LM Studio. The preference that emerged was to favour the first approach to remove the 500 by avoiding the unused custom route, and only pursue the custom route pattern if you explicitly needed a “hosted-style” endpoint for LM Studio.

Thread 4 – Model selection and `customModelId`: A smaller reasoning thread focused on locating how `customModelId` and `chatSettings` are used in the template to drive which API route gets called, on the assumption that misconfigured mappings between model id, provider string, and route (e.g. a model flagged as “custom” when no `/api/chat/custom` exists) were contributing to the error. The goal in that thread was to understand and align the model/provider selection logic with whichever of the two integration strategies (local vs custom route) you ultimately apply.

---
