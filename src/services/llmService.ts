import { logger } from "../utils/logger.js";

// --- Type Definitions ---
interface AnthropicMessage {
  role: "user" | "assistant";
  content: string;
}

interface AnthropicResponse {
  id: string;
  type: "message";
  role: "assistant";
  model: string;
  stop_reason: string;
  stop_sequence: null;
  usage: {
    input_tokens: number;
    output_tokens: number;
  };
  content: Array<{
    type: "text";
    text: string;
  }>;
}

/**
 * Generates text using Anthropic Messages API (or compatible local LLM).
 */
export async function generateText(
  prompt: string,
  system?: string,
  model: string = "claude-3-opus-20240229", // Default to a capable Claude model
  temperature: number = 0.7,
  maxTokens: number = 1024
): Promise<string | null> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  const apiUrl = process.env.ANTHROPIC_API_URL || "https://api.anthropic.com/v1/messages";

  if (!apiKey) {
    logger.warn("[LLM Service] ANTHROPIC_API_KEY is not set. Skipping text generation.");
    return null;
  }

  const messages: AnthropicMessage[] = [{ role: "user", content: prompt }];
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "x-api-key": apiKey,
    "anthropic-version": "2023-06-01",
  };

  try {
    const response = await fetch(apiUrl, {
      method: "POST",
      headers: headers,
      body: JSON.stringify({
        model: model,
        max_tokens: maxTokens,
        temperature: temperature,
        system: system,
        messages: messages,
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      logger.error(`[LLM Service] API returned error ${response.status}: ${errText}`);
      return null;
    }

    const data: AnthropicResponse = await response.json();
    if (data?.content?.[0]?.text) {
      return data.content[0].text;
    }
    return null;
  } catch (error) {
    logger.error("[LLM Service] Connection error to LLM API:", error);
    return null;
  }
}

/**
 * Summarizes conversation transcripts to extract key learnings/dreams.
 */
export async function summarizeConversationForDreams(
  transcript: string,
  provider: string,
  project: string,
  sessionId: string
): Promise<Array<{ memoryType: string; content: string; importance: number }> | null> {
  const systemPrompt = `You are an expert AI assistant tasked with identifying key learnings, mistakes, preferences, and patterns from conversation transcripts. Your goal is to extract concise "dream memories" that can guide future AI interactions.

Output format: A JSON array of objects, each with 'memoryType' (MISTAKE, PREFERENCE, KNOWLEDGE, PATTERN), 'content' (the extracted dream), and 'importance' (1-9).`;

  const userPrompt = `Analyze the following conversation transcript from session "${sessionId}" for project "${project}" (AI provider: ${provider}). Extract up to 5 distinct dream memories. Each memory should be a single, concise sentence.

Transcript:
"""
${transcript}
"""

Example output:
[
  { "memoryType": "KNOWLEDGE", "content": "User prefers concise responses.", "importance": 7 },
  { "memoryType": "MISTAKE", "content": "Previous interaction failed due to misinterpreting context.", "importance": 8 }
]`;

  const response = await generateText(userPrompt, systemPrompt);
  if (!response) {
    return null;
  }

  try {
    const dreams = JSON.parse(response);
    if (Array.isArray(dreams) && dreams.every(d => d.memoryType && d.content && d.importance)) {
      return dreams;
    }
    logger.error("[LLM Service] Invalid dream format from LLM:", response);
    return null;
  } catch (e) {
    logger.error("[LLM Service] Failed to parse LLM response for dreams:", e);
    return null;
  }
}
