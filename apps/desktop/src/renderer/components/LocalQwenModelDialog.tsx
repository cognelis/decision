import { managedQwenModelIdSchema, type ManagedQwenModelStatus, type RedactedModelProviderProfile } from "@cognelis/decision-protocol";
import { useEffect, useState } from "react";
import type { DecisionApi } from "../../shared/renderer-api.js";
import { ModalDialog } from "./ModalDialog.js";

export const LocalQwenModelDialog = ({ api, profile, onClose, onSaved }: { api: DecisionApi; profile: RedactedModelProviderProfile; onClose(): void; onSaved(): Promise<void> }) => {
  const [model, setModel] = useState(profile.model ?? "qwen3.5-4b-q4-k-m");
  const [models, setModels] = useState<ManagedQwenModelStatus[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // A status read that failed: said until a later one succeeds, apart from what installing or saving said.
  const [readError, setReadError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const selected = models.find((item) => item.modelId === model);
  const installing = models.some((item) => item.status === "installing");

  useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // A read that fails is tried again: stopped at the first, a download's progress froze, and so did its end.
    const load = async () => {
      try {
        const next = await api.listManagedQwenModels();
        if (!disposed) {
          setModels(next);
          setReadError(null);
          timer = setTimeout(() => void load(), next.some((item) => item.status === "installing") ? 1000 : 3000);
        }
      } catch (caught) {
        if (disposed) return;
        setReadError(caught instanceof Error ? caught.message : String(caught));
        timer = setTimeout(() => void load(), 3000);
      }
    };
    void load();
    return () => { disposed = true; clearTimeout(timer); };
  }, [api]);

  const install = async () => {
    setBusy(true); setError(null); setNotice(null);
    try {
      await api.installManagedQwenModel(managedQwenModelIdSchema.parse(model));
      setModels(await api.listManagedQwenModels());
      setNotice("安装完成，保存后使用所选模型。");
    } catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)); }
    finally { setBusy(false); }
  };

  const save = async () => {
    if (selected?.status !== "available") return;
    setBusy(true); setError(null);
    try {
      await api.saveModelProviderProfile({ profile: { ...profile, model: managedQwenModelIdSchema.parse(model) } });
      await onSaved(); onClose();
    } catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)); }
    finally { setBusy(false); }
  };

  return <ModalDialog title="配置 Qwen 本地模型" description="选择并安装在本机运行的模型" onClose={onClose}>
    <form className="model-provider-dialog-form" aria-label="配置 Qwen 本地模型" onSubmit={(event) => { event.preventDefault(); void save(); }}>
      <div className="provider-form-grid local-qwen-model-grid"><label>本地模型
        <select aria-label="Qwen 本地模型" autoFocus value={model} disabled={busy} onChange={(event) => { setModel(event.currentTarget.value); setNotice(null); setError(null); }}>
          <option value="qwen3.5-2b-q4-k-m">Qwen3.5-2B Q4_K_M · 约 1.33 GB</option>
          <option value="qwen3.5-4b-q4-k-m">Qwen3.5-4B Q4_K_M · 约 3.01 GB · 推荐</option>
        </select>
      </label></div>
      <p className="provider-privacy-copy">4B 在决策识别实测中表现更好；2B 占用更少。安装只下载所选模型，校验通过后才能使用。已有模型会保留，可随时切换。</p>
      <div role="status" aria-live="polite">
        {selected === undefined ? "正在检查安装状态…" : selected.status === "available" ? "已安装，文件校验通过。" : selected.status === "installing" ? `正在下载 ${Math.floor(selected.downloadedBytes / selected.totalBytes * 100)}%（下载完成后校验文件）` : selected.status === "checksum_failed" ? "文件校验未通过，请重新安装。" : selected.status === "failed" ? selected.error : "尚未安装。"}
        {notice === null ? null : <p>{notice}</p>}
      </div>
      {selected !== undefined && selected.status !== "available" ? <div><button type="button" className="secondary-button" disabled={busy || installing} onClick={() => void install()}>{busy || installing ? "正在安装…" : selected.status === "failed" || selected.status === "checksum_failed" ? "重新安装所选模型" : "安装所选模型"}</button></div> : null}
      {(error ?? readError) === null ? null : <p className="model-provider-dialog-error" role="alert">{error ?? readError}</p>}
      <div className="modal-form-actions"><button type="button" className="secondary-button" onClick={onClose}>取消</button><button type="submit" className="primary-button" disabled={busy || selected?.status !== "available"}>保存模型选择</button></div>
    </form>
  </ModalDialog>;
};
