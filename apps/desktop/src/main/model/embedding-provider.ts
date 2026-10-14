export interface EmbeddingBatch {
  model: string;
  vectors: number[][];
}

export interface EmbeddingProvider {
  embed(texts: string[], signal?: AbortSignal): Promise<EmbeddingBatch>;
}
