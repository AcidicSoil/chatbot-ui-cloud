// Only used in use-chat-handler.tsx to keep it clean

import { createChatFiles } from "@/db/chat-files"
import { createChat } from "@/db/chats"
import { createMessageFileItems } from "@/db/message-file-items"
import { createMessages, updateMessage } from "@/db/messages"
import { uploadMessageImage } from "@/db/storage/message-images"
import {
  buildFinalMessages,
  adaptMessagesForGoogleGemini
} from "@/lib/build-prompt"
import { consumeReadableStream } from "@/lib/consume-stream"
import { Tables, TablesInsert } from "@/supabase/types"
import {
  ChatFile,
  ChatMessage,
  ChatPayload,
  ChatSettings,
  LLM,
  MessageImage
} from "@/types"
import React from "react"
import { toast } from "sonner"
import { v4 as uuidv4 } from "uuid"

export const validateChatSettings = (
  chatSettings: ChatSettings | null,
  modelData: LLM | undefined,
  profile: Tables<"profiles"> | null,
  selectedWorkspace: Tables<"workspaces"> | null,
  messageContent: string
) => {
  if (!chatSettings) {
    throw new Error("Chat settings not found")
  }

  if (!modelData) {
    throw new Error("Model not found")
  }

  if (!profile) {
    throw new Error("Profile not found")
  }

  if (!selectedWorkspace) {
    throw new Error("Workspace not found")
  }

  if (!messageContent) {
    throw new Error("Message content not found")
  }
}

export const handleRetrieval = async (
  userInput: string,
  newMessageFiles: ChatFile[],
  chatFiles: ChatFile[],
  embeddingsProvider: "openai" | "local",
  sourceCount: number
) => {
  const response = await fetch("/api/retrieval/retrieve", {
    method: "POST",
    body: JSON.stringify({
      userInput,
      fileIds: [...newMessageFiles, ...chatFiles].map(file => file.id),
      embeddingsProvider,
      sourceCount
    })
  })

  if (!response.ok) {
    console.error("Error retrieving:", response)
  }

  const { results } = (await response.json()) as {
    results: Tables<"file_items">[]
  }

  return results
}

export const createTempMessages = (
  messageContent: string,
  chatMessages: ChatMessage[],
  chatSettings: ChatSettings,
  b64Images: string[],
  isRegeneration: boolean,
  setChatMessages: React.Dispatch<React.SetStateAction<ChatMessage[]>>,
  selectedAssistant: Tables<"assistants"> | null
) => {
  let tempUserChatMessage: ChatMessage = {
    message: {
      chat_id: "",
      assistant_id: null,
      content: messageContent,
      created_at: "",
      id: uuidv4(),
      image_paths: b64Images,
      model: chatSettings.model,
      role: "user",
      sequence_number: chatMessages.length,
      updated_at: "",
      user_id: ""
    },
    fileItems: []
  }

  let tempAssistantChatMessage: ChatMessage = {
    message: {
      chat_id: "",
      assistant_id: selectedAssistant?.id || null,
      content: "",
      created_at: "",
      id: uuidv4(),
      image_paths: [],
      model: chatSettings.model,
      role: "assistant",
      sequence_number: chatMessages.length + 1,
      updated_at: "",
      user_id: ""
    },
    fileItems: []
  }

  let newMessages = []

  if (isRegeneration) {
    const lastMessageIndex = chatMessages.length - 1
    chatMessages[lastMessageIndex].message.content = ""
    newMessages = [...chatMessages]
  } else {
    newMessages = [
      ...chatMessages,
      tempUserChatMessage,
      tempAssistantChatMessage
    ]
  }

  setChatMessages(newMessages)

  return {
    tempUserChatMessage,
    tempAssistantChatMessage
  }
}

export const handleLocalChat = async (
  payload: ChatPayload,
  profile: Tables<"profiles">,
  chatSettings: ChatSettings,
  tempAssistantMessage: ChatMessage,
  isRegeneration: boolean,
  newAbortController: AbortController,
  setIsGenerating: React.Dispatch<React.SetStateAction<boolean>>,
  setFirstTokenReceived: React.Dispatch<React.SetStateAction<boolean>>,
  setChatMessages: React.Dispatch<React.SetStateAction<ChatMessage[]>>,
  setToolInUse: React.Dispatch<React.SetStateAction<string>>
) => {
  const formattedMessages = await buildFinalMessages(payload, profile, [])

  const baseLmstudioUrl = (
    process.env.NEXT_PUBLIC_LMSTUDIO_URL || "http://localhost:1234"
  ).replace(/\/$/, "")

  // LM Studio exposes an OpenAI-compatible chat completions endpoint
  const response = await fetchChatResponse(
    `${baseLmstudioUrl}/v1/chat/completions`,
    {
      model: chatSettings.model,
      messages: formattedMessages,
      temperature: payload.chatSettings.temperature,
      stream: true
    },
    false,
    newAbortController,
    setIsGenerating,
    setChatMessages
  )

  return await processResponse(
    response,
    isRegeneration
      ? payload.chatMessages[payload.chatMessages.length - 1]
      : tempAssistantMessage,
    false,
    newAbortController,
    setFirstTokenReceived,
    setChatMessages,
    setToolInUse
  )
}

export const handleHostedChat = async (
  payload: ChatPayload,
  profile: Tables<"profiles">,
  modelData: LLM,
  tempAssistantChatMessage: ChatMessage,
  isRegeneration: boolean,
  newAbortController: AbortController,
  newMessageImages: MessageImage[],
  chatImages: MessageImage[],
  setIsGenerating: React.Dispatch<React.SetStateAction<boolean>>,
  setFirstTokenReceived: React.Dispatch<React.SetStateAction<boolean>>,
  setChatMessages: React.Dispatch<React.SetStateAction<ChatMessage[]>>,
  setToolInUse: React.Dispatch<React.SetStateAction<string>>
) => {
  const provider =
    modelData.provider === "openai" && profile.use_azure_openai
      ? "azure"
      : modelData.provider

  let draftMessages = await buildFinalMessages(payload, profile, chatImages)

  let formattedMessages: any[] = []
  if (provider === "google") {
    formattedMessages = await adaptMessagesForGoogleGemini(
      payload,
      draftMessages
    )
  } else {
    formattedMessages = draftMessages
  }

  const apiEndpoint =
    provider === "custom" ? "/api/chat/custom" : `/api/chat/${provider}`

  const requestBody = {
    chatSettings: payload.chatSettings,
    messages: formattedMessages,
    customModelId: provider === "custom" ? modelData.hostedId : ""
  }

  const response = await fetchChatResponse(
    apiEndpoint,
    requestBody,
    true,
    newAbortController,
    setIsGenerating,
    setChatMessages
  )

  return await processResponse(
    response,
    isRegeneration
      ? payload.chatMessages[payload.chatMessages.length - 1]
      : tempAssistantChatMessage,
    true,
    newAbortController,
    setFirstTokenReceived,
    setChatMessages,
    setToolInUse
  )
}

export const fetchChatResponse = async (
  url: string,
  body: object,
  isHosted: boolean,
  controller: AbortController,
  setIsGenerating: React.Dispatch<React.SetStateAction<boolean>>,
  setChatMessages: React.Dispatch<React.SetStateAction<ChatMessage[]>>
) => {
  const headers: Record<string, string> = {
    "Content-Type": "application/json"
  }

  if (!isHosted) {
    headers["Accept"] = "text/event-stream"
  }

  const response = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: controller.signal
  })

  if (!response.ok) {
    if (response.status === 404 && !isHosted) {
      toast.error(
        "Model not found. Make sure you have it downloaded via lmstudio."
      )
    }

    let errorMessage = "An unexpected error occurred"

    try {
      const errorText = await response.text()
      if (errorText) {
        try {
          const parsedError = JSON.parse(errorText)
          errorMessage =
            parsedError.message ||
            parsedError.error?.message ||
            parsedError.error ||
            errorMessage
        } catch {
          errorMessage = errorText
        }
      } else if (response.statusText) {
        errorMessage = response.statusText
      }
    } catch {
      if (response.statusText) {
        errorMessage = response.statusText
      }
    }

    toast.error(errorMessage)

    setIsGenerating(false)
    setChatMessages(prevMessages => prevMessages.slice(0, -2))

    throw new Error(errorMessage)
  }

  return response
}

export const processResponse = async (
  response: Response,
  lastChatMessage: ChatMessage,
  isHosted: boolean,
  controller: AbortController,
  setFirstTokenReceived: React.Dispatch<React.SetStateAction<boolean>>,
  setChatMessages: React.Dispatch<React.SetStateAction<ChatMessage[]>>,
  setToolInUse: React.Dispatch<React.SetStateAction<string>>
) => {
  let fullText = ""
  const updateAssistantMessage = (content: string) => {
    setChatMessages(prev =>
      prev.map(chatMessage => {
        if (chatMessage.message.id === lastChatMessage.message.id) {
          return {
            message: {
              ...chatMessage.message,
              content
            },
            fileItems: chatMessage.fileItems
          }
        }

        return chatMessage
      })
    )
  }

  const lmstudioParser = !isHosted ? createLmstudioStreamParser() : null

  if (response.body) {
    await consumeReadableStream(
      response.body,
      chunk => {
        const contentToAdd = isHosted
          ? chunk
          : (lmstudioParser?.parse(chunk) ?? "")

        if (!contentToAdd) {
          return
        }

        setFirstTokenReceived(true)
        setToolInUse("none")

        fullText += contentToAdd

        updateAssistantMessage(fullText)
      },
      controller.signal
    )

    if (!isHosted && lmstudioParser) {
      const remainingText = lmstudioParser.flush()
      if (remainingText) {
        setFirstTokenReceived(true)
        setToolInUse("none")
        fullText += remainingText
        updateAssistantMessage(fullText)
      }
    }

    return fullText
  } else {
    throw new Error("Response body is null")
  }
}

const createLmstudioStreamParser = () => {
  let buffer = ""

  const parse = (incomingChunk: string) => {
    let parsedText = ""
    const normalizedChunk = incomingChunk.replace(/\r/g, "")
    const combined = buffer + normalizedChunk
    const lines = combined.split("\n")
    buffer = lines.pop() ?? ""

    for (const rawLine of lines) {
      const normalizedLine = normalizeLmstudioLine(rawLine)

      if (!normalizedLine || normalizedLine === "[DONE]") {
        continue
      }

      const payload = tryParseLmstudioJson(normalizedLine)

      if (!payload) {
        buffer = normalizedLine + "\n" + buffer
        break
      }

      const extracted = extractTextFromLmstudioPayload(payload)
      if (extracted) {
        parsedText += extracted
      }
    }

    return parsedText
  }

  const flush = () => {
    if (!buffer.trim()) {
      buffer = ""
      return ""
    }

    const flushedText = parse("\n")
    buffer = ""
    return flushedText
  }

  return { parse, flush }
}

const normalizeLmstudioLine = (line: string) => {
  const trimmedLine = line.trim()

  if (!trimmedLine) {
    return ""
  }

  if (trimmedLine.startsWith("data:")) {
    return trimmedLine.slice(5).trim()
  }

  if (
    trimmedLine.startsWith("event:") ||
    trimmedLine.startsWith("id:") ||
    trimmedLine.startsWith(":")
  ) {
    return ""
  }

  return trimmedLine
}

const tryParseLmstudioJson = (value: string) => {
  try {
    return JSON.parse(value)
  } catch {
    return null
  }
}

const extractTextFromLmstudioPayload = (payload: any): string => {
  if (!payload) {
    return ""
  }

  if (payload.message?.content) {
    const messageContent = flattenLmstudioContent(payload.message.content)
    if (messageContent) {
      return messageContent
    }
  }

  if (Array.isArray(payload.choices)) {
    return payload.choices
      .map((choice: any) => {
        if (choice.delta) {
          return (
            flattenLmstudioContent(choice.delta.content) ||
            flattenLmstudioContent(choice.delta.text)
          )
        }

        if (choice.message) {
          return flattenLmstudioContent(choice.message.content)
        }

        if (typeof choice.text === "string") {
          return choice.text
        }

        return ""
      })
      .join("")
  }

  if (payload.delta) {
    return (
      flattenLmstudioContent(payload.delta.content) ||
      flattenLmstudioContent(payload.delta.text)
    )
  }

  if (typeof payload.response === "string") {
    return payload.response
  }

  if (payload.response?.message?.content) {
    return flattenLmstudioContent(payload.response.message.content)
  }

  if (typeof payload.content === "string") {
    return payload.content
  }

  if (typeof payload.output === "string") {
    return payload.output
  }

  if (typeof payload.output_text === "string") {
    return payload.output_text
  }

  return ""
}

const flattenLmstudioContent = (value: any): string => {
  if (!value) {
    return ""
  }

  if (typeof value === "string") {
    return value
  }

  if (Array.isArray(value)) {
    return value
      .map(part => {
        if (typeof part === "string") {
          return part
        }

        if (typeof part?.text === "string") {
          return part.text
        }

        if (typeof part?.content === "string") {
          return part.content
        }

        return ""
      })
      .join("")
  }

  if (typeof value?.text === "string") {
    return value.text
  }

  if (typeof value?.content === "string") {
    return value.content
  }

  return ""
}

export const handleCreateChat = async (
  chatSettings: ChatSettings,
  profile: Tables<"profiles">,
  selectedWorkspace: Tables<"workspaces">,
  messageContent: string,
  selectedAssistant: Tables<"assistants">,
  newMessageFiles: ChatFile[],
  setSelectedChat: React.Dispatch<React.SetStateAction<Tables<"chats"> | null>>,
  setChats: React.Dispatch<React.SetStateAction<Tables<"chats">[]>>,
  setChatFiles: React.Dispatch<React.SetStateAction<ChatFile[]>>
) => {
  const createdChat = (await createChat({
    user_id: profile.user_id,
    workspace_id: selectedWorkspace.id,
    assistant_id: selectedAssistant?.id || null,
    context_length: chatSettings.contextLength,
    include_profile_context: chatSettings.includeProfileContext,
    include_workspace_instructions: chatSettings.includeWorkspaceInstructions,
    model: chatSettings.model,
    name: messageContent.substring(0, 100),
    prompt: chatSettings.prompt,
    temperature: chatSettings.temperature,
    embeddings_provider: chatSettings.embeddingsProvider
  })) as Tables<"chats">

  setSelectedChat(createdChat)
  setChats(chats => [createdChat, ...chats])

  await createChatFiles(
    newMessageFiles.map(file => ({
      user_id: profile.user_id,
      chat_id: createdChat.id,
      file_id: file.id
    }))
  )

  setChatFiles(prev => [...prev, ...newMessageFiles])

  return createdChat
}

export const handleCreateMessages = async (
  chatMessages: ChatMessage[],
  currentChat: Tables<"chats">,
  profile: Tables<"profiles">,
  modelData: LLM,
  messageContent: string,
  generatedText: string,
  newMessageImages: MessageImage[],
  isRegeneration: boolean,
  retrievedFileItems: Tables<"file_items">[],
  setChatMessages: React.Dispatch<React.SetStateAction<ChatMessage[]>>,
  setChatFileItems: React.Dispatch<
    React.SetStateAction<Tables<"file_items">[]>
  >,
  setChatImages: React.Dispatch<React.SetStateAction<MessageImage[]>>,
  selectedAssistant: Tables<"assistants"> | null
) => {
  const finalUserMessage: TablesInsert<"messages"> = {
    chat_id: currentChat.id,
    assistant_id: null,
    user_id: profile.user_id,
    content: messageContent,
    model: modelData.modelId,
    role: "user",
    sequence_number: chatMessages.length,
    image_paths: []
  }

  const finalAssistantMessage: TablesInsert<"messages"> = {
    chat_id: currentChat.id,
    assistant_id: selectedAssistant?.id || null,
    user_id: profile.user_id,
    content: generatedText,
    model: modelData.modelId,
    role: "assistant",
    sequence_number: chatMessages.length + 1,
    image_paths: []
  }

  let finalChatMessages: ChatMessage[] = []

  if (isRegeneration) {
    const lastStartingMessage = chatMessages[chatMessages.length - 1].message

    const updatedMessage = await updateMessage(lastStartingMessage.id, {
      ...lastStartingMessage,
      content: generatedText
    })

    chatMessages[chatMessages.length - 1].message = updatedMessage

    finalChatMessages = [...chatMessages]

    setChatMessages(finalChatMessages)
  } else {
    const createdMessages = (await createMessages([
      finalUserMessage,
      finalAssistantMessage
    ])) as Tables<"messages">[]

    // Upload each image (stored in newMessageImages) for the user message to message_images bucket
    const uploadPromises = newMessageImages
      .filter(obj => obj.file !== null)
      .map(obj => {
        let filePath = `${profile.user_id}/${currentChat.id}/${
          createdMessages[0].id
        }/${uuidv4()}`

        return uploadMessageImage(filePath, obj.file as File).catch(error => {
          console.error(`Failed to upload image at ${filePath}:`, error)
          return null
        })
      })

    const paths = (await Promise.all(uploadPromises)).filter(
      Boolean
    ) as string[]

    setChatImages(prevImages => [
      ...prevImages,
      ...newMessageImages.map((obj, index) => ({
        ...obj,
        messageId: createdMessages[0].id,
        path: paths[index]
      }))
    ])

    const updatedMessage = await updateMessage(createdMessages[0].id, {
      ...createdMessages[0],
      image_paths: paths
    })

    const createdMessageFileItems = await createMessageFileItems(
      retrievedFileItems.map(fileItem => {
        return {
          user_id: profile.user_id,
          message_id: createdMessages[1].id,
          file_item_id: fileItem.id
        }
      })
    )

    finalChatMessages = [
      ...chatMessages,
      {
        message: updatedMessage,
        fileItems: []
      },
      {
        message: createdMessages[1],
        fileItems: retrievedFileItems.map(fileItem => fileItem.id)
      }
    ]

    setChatFileItems(prevFileItems => {
      const newFileItems = retrievedFileItems.filter(
        fileItem => !prevFileItems.some(prevItem => prevItem.id === fileItem.id)
      )

      return [...prevFileItems, ...newFileItems]
    })

    setChatMessages(finalChatMessages)
  }
}
