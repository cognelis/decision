export interface ObsidianSearchStatus {
  state: "idle" | "indexing" | "ready" | "unavailable" | "error";
  discoveredNotes: number;
  indexedNotes: number;
  chunkCount: number;
  processedNotes: number;
  totalNotes: number;
  skippedNotes: number;
  failedNotes: number;
  synchronizedAt: string | null;
  semanticAvailable: boolean;
  message: string | null;
}

export interface ObsidianSearchResult {
  relativePath: string;
  title: string;
  heading: string | null;
  snippet: string;
  matchKind: "keyword" | "semantic" | "hybrid";
}

export interface ObsidianSearchResponse {
  query: string;
  results: ObsidianSearchResult[];
  status: ObsidianSearchStatus;
}
