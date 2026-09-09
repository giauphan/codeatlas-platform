import { logger } from "../utils/logger.js";

// ── Type Definitions ─────────────────────────────────────────────────────────
// Both NVIDIA NIM and Mistral expose an OpenAI-compatible embeddings response.
interface EmbeddingData {
  embedding: number[];
  index: number;
  object: string;
}

interface EmbeddingResponse {
  data: EmbeddingData[];
  model: string;
  usage?: { prompt_tokens: number; total_tokens: number };
}

type Provider = "nvidia" | "mistral";

const NVIDIA_EMBEDDINGS_URL = "https://integrate.api.nvidia.com/v1/embeddings";
const MISTRAL_EMBEDDINGS_URL = "https://api.mistral.ai/v1/embeddings";

// Target embedding dimension. MUST match the DB schema (vector(1024) / 1024-float
// BLOB). Override with EMBEDDING_DIM only if you also migrate the schema and
// re-embed existing rows — mixing dims corrupts vector search. Read per call so
// it can be reconfigured without a restart. (Legacy NVIDIA_EMBEDDING_DIM still
// honored for backwards compatibility.)
function embeddingDim(): number {
  return Number(process.env.EMBEDDING_DIM ?? process.env.NVIDIA_EMBEDDING_DIM) || 1024;
}

// Ordered failover chain across providers, all verified live to emit 1024-dim:
//   - mistral/codestral-embed        → 1536 native, 1024 via `output_dimension` (code-tuned)
//   - mistral/mistral-embed          → natively 1024, rejects `output_dimension`
//   - nvidia/llama-nemotron-embed-vl-1b-v2 → 2048 native, 1024 via `dimensions`
//   - nvidia/nemotron-3-embed-1b     → fixed 2048 (only usable when EMBEDDING_DIM=2048)
// Codestral leads because CodeAtlas embeds source code. The retired NVIDIA ids
// (`nv-embed-v1`, `nv-embedqa-*`, `arctic-embed-l`, `bge-m3`) now 410/404.
// Prefix each id with `mistral/` or `nvidia/` (bare ids default to nvidia).
// Override via EMBEDDING_MODELS (comma-separated, first = primary).
const DEFAULT_MODELS = [
  "mistral/codestral-embed",
  "mistral/mistral-embed",
  "nvidia/llama-nemotron-embed-vl-1b-v2",
  "nvidia/nemotron-3-embed-1b",
];

// Mistral rejects `output_dimension` on the mistral-embed family (400 code 3051)
// but requires it on codestral-embed* to down-project from 1536 to 1024.
const MISTRAL_SUPPORTS_OUTPUT_DIMENSION = /^codestral-embed/;

// Statuses where the key — not the model — is the problem, so retrying the same
// model with the next key is worthwhile.
const KEY_ROTATION_STATUSES = new Set([401, 403, 429]);

interface ModelSpec {
  provider: Provider;
  model: string;
}

function parseModel(entry: string): ModelSpec {
  const trimmed = entry.trim();
  if (trimmed.startsWith("mistral/")) {
    return { provider: "mistral", model: trimmed.slice("mistral/".length) };
  }
  // NVIDIA model ids keep their `nvidia/` prefix in the request body, and bare
  // ids default to NVIDIA for backwards compatibility.
  return { provider: "nvidia", model: trimmed };
}

/** Human-readable id used in logs; also the canonical form for EMBEDDING_MODELS. */
function specLabel(spec: ModelSpec): string {
  return spec.provider === "mistral" ? `mistral/${spec.model}` : spec.model;
}

function getModels(): ModelSpec[] {
  const raw = process.env.EMBEDDING_MODELS ?? process.env.NVIDIA_EMBEDDING_MODELS;
  const source = raw?.trim()
    ? raw.split(",").map((m) => m.trim()).filter(Boolean)
    : DEFAULT_MODELS;
  const list = source.length ? source : DEFAULT_MODELS;
  return list.map(parseModel);
}

/** API keys may be a comma-separated pool; each is tried on auth/rate-limit errors. */
function providerKeys(provider: Provider): string[] {
  const raw = provider === "mistral" ? process.env.MISTRAL_API_KEY : process.env.NVIDIA_API_KEY;
  return (raw ?? "").split(",").map((k) => k.trim()).filter(Boolean);
}

function providerUrl(provider: Provider): string {
  return provider === "mistral" ? MISTRAL_EMBEDDINGS_URL : NVIDIA_EMBEDDINGS_URL;
}

function providerKeyName(provider: Provider): string {
  return provider === "mistral" ? "MISTRAL_API_KEY" : "NVIDIA_API_KEY";
}

function buildBody(
  spec: ModelSpec,
  input: string[],
  inputType: 'passage' | 'query',
  dim: number,
): Record<string, unknown> {
  if (spec.provider === "mistral") {
    // Mistral has no input_type/encoding_format/truncate fields.
    const body: Record<string, unknown> = { model: spec.model, input };
    if (MISTRAL_SUPPORTS_OUTPUT_DIMENSION.test(spec.model)) {
      body.output_dimension = dim;
    }
    return body;
  }
  return {
    model: spec.model,
    input,
    input_type: inputType,
    encoding_format: "float",
    truncate: "END",
    dimensions: dim,
  };
}

// Round-robin cursors: persist across calls so healthy models/keys stay primary.
// The model cursor resets when the configured list changes so a stale index
// can't pin the wrong provider after reconfiguration.
let modelCursor = 0;
let lastModelSignature = "";
const keyCursors: Record<Provider, number> = { nvidia: 0, mistral: 0 };

function resolveModels(): ModelSpec[] {
  const models = getModels();
  const signature = models.map(specLabel).join("|");
  if (signature !== lastModelSignature) {
    lastModelSignature = signature;
    modelCursor = 0;
  }
  return models;
}

/**
 * Requests embeddings for one model, rotating through that provider's key pool
 * on auth/rate-limit failures.
 *
 * Returns the embeddings on success, or `null` to signal "advance to the next
 * model in the failover chain".
 */
async function requestFromModel(
  spec: ModelSpec,
  input: string[],
  inputType: 'passage' | 'query',
  dim: number,
): Promise<number[][] | null> {
  const label = specLabel(spec);
  const keys = providerKeys(spec.provider);

  if (!keys.length) {
    logger.warn(`[Embeddings] Skipping ${label}: ${providerKeyName(spec.provider)} is not set.`);
    return null;
  }

  const url = providerUrl(spec.provider);
  const body = JSON.stringify(buildBody(spec, input, inputType, dim));
  const startCursor = keyCursors[spec.provider];

  for (let keyAttempt = 0; keyAttempt < keys.length; keyAttempt++) {
    const keyIndex = (startCursor + keyAttempt) % keys.length;
    const keyRef = keys.length > 1 ? ` (key #${keyIndex})` : "";

    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${keys[keyIndex]}`
        },
        body
      });

      if (!response.ok) {
        logger.error(`[Embeddings] Model ${label}${keyRef} returned error ${response.status} for ${response.url}: ${response.statusText}`);
        // Bad/throttled key: try the next key on the same model. Anything else
        // is a model-level problem, so move on to the next model.
        if (KEY_ROTATION_STATUSES.has(response.status)) continue;
        return null;
      }

      const data: EmbeddingResponse = await response.json();
      const embeddings = data?.data?.length ? data.data.map((item) => item.embedding) : null;
      if (!embeddings) {
        logger.error(`[Embeddings] Model ${label} returned empty data payload.`);
        return null;
      }

      // Guard the vector store: reject dims that don't match the schema.
      if (embeddings.some((e) => e.length !== dim)) {
        logger.error(`[Embeddings] Model ${label} returned dim ${embeddings[0]?.length}, expected ${dim}. Rotating.`);
        return null;
      }

      // Pin the key that just worked as primary for this provider.
      keyCursors[spec.provider] = keyIndex;
      return embeddings;
    } catch (error) {
      logger.error(`[Embeddings] Connection error to embeddings API (model ${label}${keyRef}):`, error);
      return null;
    }
  }

  return null;
}

/**
 * POSTs to the configured embeddings providers for a single input chunk,
 * rotating through the model list (round-robin) whenever a model is
 * unconfigured, errors, or returns the wrong dimension. Returns the raw
 * embedding arrays, or null if every model failed.
 */
async function requestEmbeddings(
  input: string[],
  inputType: 'passage' | 'query',
): Promise<number[][] | null> {
  const models = resolveModels();
  const dim = embeddingDim();

  for (let attempt = 0; attempt < models.length; attempt++) {
    const index = (modelCursor + attempt) % models.length;
    const embeddings = await requestFromModel(models[index], input, inputType, dim);
    if (embeddings) {
      // Advance cursor so the model that just worked stays primary.
      modelCursor = index;
      return embeddings;
    }
  }

  logger.error(`[Embeddings] All embedding models failed: ${models.map(specLabel).join(", ")}`);
  return null;
}

/**
 * Generates an embedding vector using the configured provider failover chain.
 */
export async function generateEmbedding(text: string, inputType: 'passage' | 'query'): Promise<number[] | null> {
  // Embedding APIs reject empty input with 400 "All input must be non-empty".
  if (!text?.trim()) {
    return null;
  }

  const result = await requestEmbeddings([text], inputType);
  return result?.[0] ?? null;
}

/**
 * Generates embeddings in batches using the configured provider failover chain.
 */
export async function generateEmbeddingsBatch(texts: string[], inputType: 'passage' | 'query'): Promise<number[][] | null> {
  const results: number[][] = [];
  const chunkSize = 50; // process 50 texts at a time to prevent payload size issues

  for (let i = 0; i < texts.length; i += chunkSize) {
    const chunk = texts.slice(i, i + chunkSize);
    const embeddings = await requestEmbeddings(chunk, inputType);
    if (!embeddings) {
      return null;
    }
    results.push(...embeddings);
  }

  return results;
}
