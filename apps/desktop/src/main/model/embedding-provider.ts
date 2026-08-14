export interface EmbeddingBatch {
  model: string;
  vectors: number[][];
}

export interface EmbeddingProvider {
  embed(texts: string[], signal?: AbortSignal): Promise<EmbeddingBatch>;
}

export const supportsEmbeddings = (
  value: unknown,
): value is EmbeddingProvider =>
  typeof value === "object" &&
  value !== null &&
  "embed" in value &&
  typeof value.embed === "function";
