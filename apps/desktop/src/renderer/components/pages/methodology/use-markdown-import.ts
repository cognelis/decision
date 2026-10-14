import { useState } from "react";

import type {
  MethodologyImportPreview,
  MethodologyRecordsApi,
} from "../../../../shared/renderer-api.js";
import type { MethodologyWorkspaceHost } from "./methodology-view-types.js";

/**
 * Importing principles written outside this app, lifted out of
 * MethodologyPanel.
 *
 * Five pieces of state and four functions over a two-step flow: read the files
 * into a preview, then commit the candidates the reader ticked. Nothing is
 * written until that second step, and a candidate the importer thinks it has
 * seen before starts unticked rather than being dropped — deciding that two
 * texts are the same principle is the reader's call.
 */
export type MarkdownImportApi = Pick<
  MethodologyRecordsApi,
  "importMethodologyMarkdown" | "commitMethodologyMarkdownImport"
>;

export interface MarkdownImportOptions {
  api: MarkdownImportApi;
  host: MethodologyWorkspaceHost;
}

export const useMarkdownImport = ({ api, host }: MarkdownImportOptions) => {
  const [importing, setImporting] = useState(false);
  const [importPreview, setImportPreview] =
    useState<MethodologyImportPreview | null>(null);
  const [selectedImportCandidates, setSelectedImportCandidates] = useState<
    string[]
  >([]);
  const [importSaving, setImportSaving] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);

  const importMarkdown = async (): Promise<void> => {
    setImporting(true);
    host.notify(null);
    try {
      const preview = await api.importMethodologyMarkdown();
      if (preview.cancelled) return;
      if (preview.batchId === null || preview.candidates.length === 0) {
        // One duplicate among them, and the files that could not be read went unmentioned.
        const outcomes = [
          preview.duplicates.length > 0
            ? `已识别并跳过 ${preview.duplicates.length} 条重复内容`
            : null,
          preview.failures.length > 0
            ? `${preview.failures.length} 个文件没能导入：${preview.failures
                .slice(0, 3)
                .map((failure) => `${failure.fileName}（${failure.message.replace(/[。.]$/u, "")}）`)
                .join("、")}${preview.failures.length > 3 ? "等" : ""}`
            : null,
        ].filter((value): value is string => value !== null);
        host.notify({
          tone: "warning",
          text:
            outcomes.length === 0
              ? "没有发现可导入的内容。"
              : `没有新增候选；${outcomes.join("；")}。`,
        });
        return;
      }
      setImportPreview(preview);
      setSelectedImportCandidates(
        preview.candidates
          .filter((candidate) => candidate.similarTo === null)
          .map((candidate) => candidate.id),
      );
      setImportError(null);
    } catch (caught) {
      host.notify({
        tone: "error",
        text: `导入失败：${caught instanceof Error ? caught.message : String(caught)}`,
      });
    } finally {
      setImporting(false);
    }
  };

  const toggleImportCandidate = (id: string): void => {
    setSelectedImportCandidates((current) =>
      current.includes(id)
        ? current.filter((candidateId) => candidateId !== id)
        : [...current, id],
    );
  };

  const chooseImportCandidates = (ids: string[]): void =>
    setSelectedImportCandidates([...ids]);

  const closeImportPreview = (): void => {
    if (importSaving) return;
    setImportPreview(null);
    setSelectedImportCandidates([]);
    setImportError(null);
  };

  const commitMarkdownImport = async (): Promise<void> => {
    if (
      importPreview?.batchId === null ||
      importPreview?.batchId === undefined ||
      selectedImportCandidates.length === 0
    ) {
      return;
    }
    setImportSaving(true);
    setImportError(null);
    try {
      const report = await api.commitMethodologyMarkdownImport(
        importPreview.batchId,
        selectedImportCandidates,
      );
      setImportPreview(null);
      setSelectedImportCandidates([]);
      const summary = [
        report.imported.length > 0
          ? `已导入 ${report.imported.length} 条候选`
          : null,
        report.duplicates.length > 0
          ? `提交前又识别到 ${report.duplicates.length} 条重复内容`
          : null,
        report.failures.length > 0
          ? `${report.failures.length} 条未完成`
          : null,
      ]
        .filter((value): value is string => value !== null)
        .join("；");
      host.notify({
        tone: report.failures.length > 0 ? "warning" : "success",
        text: summary || "没有新增候选。",
      });
      if (report.imported.length > 0) {
        host.filterBy("candidate");
        host.refreshRecords();
      }
    } catch (caught) {
      setImportError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setImportSaving(false);
    }
  };

  return {
    chooseImportCandidates,
    closeImportPreview,
    commitMarkdownImport,
    importError,
    importMarkdown,
    importPreview,
    importSaving,
    importing,
    selectedImportCandidates,
    toggleImportCandidate,
  };
};
