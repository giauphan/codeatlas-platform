import { logger } from "../utils/logger.js";

// ── Type Definitions ─────────────────────────────────────────────────────────
interface NvidiaEmbeddingData {
  embedding: number[];
  index: number;
  object: string;
}

interface NvidiaEmbeddingResponse {
  data: NvidiaEmbeddingData[];
  model: string;
  usage: { prompt_tokens: number; total_tokens: number };
}

/**
 * Generates an embedding vector using NVIDIA NIM Embeddings API
 */
export async function generateEmbedding(text: string, inputType: 'passage' | 'query'): Promise<number[] | null> {
  const apiKey = process.env.NVIDIA_API_KEY;
  if (!apiKey) {
    logger.warn("[NVIDIA SDK] NVIDIA_API_KEY is not set. Skipping embedding generation.");
    return null;
  }

  // NVIDIA API rejects empty input with 400 "All input must be non-empty"
  if (!text?.trim()) {
    return null;
  }

  try {
    const response = await fetch("https://integrate.api.nvidia.com/v1/embeddings", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: "nvidia/nv-embed-v1",
        input: [text],
        input_type: inputType,
        encoding_format: "float",
        truncate: "NONE"
      })
    });

    if (!response.ok) {
      const errText = await response.text();
      logger.error(`[NVIDIA SDK] API returned error ${response.status}: ${errText}`);
      return null;
    }

    const data: NvidiaEmbeddingResponse = await response.json();
    if (data?.data?.[0]?.embedding) {
      return data.data[0].embedding;
    }
    return null;
  } catch (error) {
    logger.error("[NVIDIA SDK] Connection error to NVIDIA Embeddings API:", error);
    return null;
  }
}

/**
 * Generates embeddings in batches using NVIDIA NIM Embeddings API
 */
export async function generateEmbeddingsBatch(texts: string[], inputType: 'passage' | 'query'): Promise<number[][] | null> {
  const apiKey = process.env.NVIDIA_API_KEY;
  if (!apiKey) {
    logger.warn("[NVIDIA SDK] NVIDIA_API_KEY is not set. Skipping embedding generation.");
    return null;
  }

  const results: number[][] = [];
  const chunkSize = 50; // process 50 texts at a time to prevent payload size issues

  for (let i = 0; i < texts.length; i += chunkSize) {
    const chunk = texts.slice(i, i + chunkSize);
    try {
      const response = await fetch("https://integrate.api.nvidia.com/v1/embeddings", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${apiKey}`
        },
        body: JSON.stringify({
          model: "nvidia/nv-embed-v1",
          input: chunk,
          input_type: inputType,
          encoding_format: "float",
          truncate: "NONE"
        })
      });

      if (!response.ok) {
        const errText = await response.text();
        logger.error(`[NVIDIA SDK] API returned error ${response.status}: ${errText}`);
        return null;
      }

      const data: NvidiaEmbeddingResponse = await response.json();
      if (data?.data) {
        const embeddings = data.data.map((item: NvidiaEmbeddingData) => item.embedding);
        results.push(...embeddings);
      } else {
        return null;
      }
    } catch (error) {
      logger.error("[NVIDIA SDK] Connection error to NVIDIA Embeddings API:", error);
      return null;
    }
  }

  return results;
}
