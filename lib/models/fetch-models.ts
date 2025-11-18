import { Tables } from "@/supabase/types"
import { LLM, LLMID, OpenRouterLLM } from "@/types"
import { toast } from "sonner"
import { LLM_LIST_MAP } from "./llm/llm-list"

export const fetchHostedModels = async (profile: Tables<"profiles">) => {
  try {
    const providers = ["google", "anthropic", "mistral", "groq", "perplexity"]

    if (profile.use_azure_openai) {
      providers.push("azure")
    } else {
      providers.push("openai")
    }

    const response = await fetch("/api/keys")

    if (!response.ok) {
      throw new Error(`Server is not responding.`)
    }

    const data = await response.json()

    let modelsToAdd: LLM[] = []

    for (const provider of providers) {
      let providerKey: keyof typeof profile

      if (provider === "google") {
        providerKey = "google_gemini_api_key"
      } else if (provider === "azure") {
        providerKey = "azure_openai_api_key"
      } else {
        providerKey = `${provider}_api_key` as keyof typeof profile
      }

      if (profile?.[providerKey] || data.isUsingEnvKeyMap[provider]) {
        const models = LLM_LIST_MAP[provider]

        if (Array.isArray(models)) {
          modelsToAdd.push(...models)
        }
      }
    }

    return {
      envKeyMap: data.isUsingEnvKeyMap,
      hostedModels: modelsToAdd
    }
  } catch (error) {
    console.warn("Error fetching hosted models: " + error)
  }
}

export const fetchLmstudioModels = async () => {
  try {
    const baseUrl = (
      process.env.NEXT_PUBLIC_LMSTUDIO_URL || "http://localhost:1234"
    ).replace(/\/$/, "")

    const response = await fetch(`${baseUrl}/v1/models`)

    if (!response.ok) {
      throw new Error(`lmstudio server is not responding.`)
    }

    const data = await response.json()

    const lmstudioModels = normalizeLmstudioModelResponse(data)

    if (lmstudioModels.length === 0) {
      throw new Error("lmstudio server returned no models.")
    }

    const localModels: LLM[] = lmstudioModels
      .map(model => {
        const identifier =
          model.id || model.name || model.model || model.model_id

        if (!identifier) {
          return null
        }

        const displayName = model.name || model.id || identifier

        return {
          modelId: identifier as LLMID,
          modelName: displayName,
          provider: "lmstudio",
          hostedId: identifier,
          platformLink: "https://lmstudio.ai/models",
          imageInput: Boolean(model?.supports_images || model?.image_input)
        }
      })
      .filter(Boolean) as LLM[]

    return localModels
  } catch (error) {
    console.warn("Error fetching lmstudio models: " + error)
  }
}

const normalizeLmstudioModelResponse = (payload: any) => {
  if (!payload) {
    return []
  }

  if (Array.isArray(payload.models)) {
    return payload.models
  }

  if (Array.isArray(payload.data)) {
    return payload.data
  }

  if (Array.isArray(payload)) {
    return payload
  }

  if (Array.isArray(payload?.response?.data)) {
    return payload.response.data
  }

  return []
}

export const fetchOpenRouterModels = async () => {
  try {
    const response = await fetch("https://openrouter.ai/api/v1/models")

    if (!response.ok) {
      throw new Error(`OpenRouter server is not responding.`)
    }

    const { data } = await response.json()

    const openRouterModels = data.map(
      (model: {
        id: string
        name: string
        context_length: number
      }): OpenRouterLLM => ({
        modelId: model.id as LLMID,
        modelName: model.id,
        provider: "openrouter",
        hostedId: model.name,
        platformLink: "https://openrouter.dev",
        imageInput: false,
        maxContext: model.context_length
      })
    )

    return openRouterModels
  } catch (error) {
    console.error("Error fetching Open Router models: " + error)
    toast.error("Error fetching Open Router models: " + error)
  }
}
