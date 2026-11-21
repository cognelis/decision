import { createHash } from "node:crypto";
import { capacityState } from "./organization-capacity-fixture.js";
import { inputFingerprint } from "../src/main/organization-core.js";

export type StateDensity = "repeated" | "unique" | "compact";
const token = (id: string, length: number): string => {
  let text = "";
  for (let index = 0; text.length < length; index += 1) text += createHash("sha256").update(`${id}:${index}`).digest("base64");
  return text.slice(0, length);
};

/** Fixed synthetic content: equal byte targets can exercise different record counts and compression ratios. */
export const densityState = (count: number, density: StateDensity) => {
  const state = capacityState(count);
  for (const [index, suggestion] of Object.values(state.suggestions).entries()) {
    if (suggestion.content?.type !== "experience") throw new Error("unexpected capacity fixture");
    const body = suggestion.content.body;
    if (density === "compact") {
      body.scene = `合成范围 ${index % 8}`; body.action = "仅记录";
      body.inference = "尚未验证"; body.exceptions = "不可用于实际业务";
      suggestion.apply = null;
    } else if (density === "unique") {
      body.scene = `RSI14 synthetic ${token(`scene-${index}`, 420)}`;
      body.action = `RSI14 synthetic ${token(`action-${index}`, 350)}`;
      body.inference = `Unverified ${token(`inference-${index}`, 390)}`;
      body.exceptions = `Synthetic boundary ${token(`boundary-${index}`, 260)}`;
    }
    const kind = ["decision", "preference", "idea", "summary"] as const;
    const source = `${kind[index % kind.length]}:synthetic-${index}`;
    suggestion.anchor = [source]; suggestion.inputKeys = [source]; suggestion.directInputKeys = [source];
    const evidence = suggestion.evidence.sources[0]!;
    evidence.key = source; evidence.kind = kind[index % kind.length]!; evidence.rootKeys = [source];
    evidence.fingerprint = createHash("sha256").update(body.observation).digest("hex");
    evidence.evidenceFingerprint = evidence.fingerprint;
    if (evidence.basis) evidence.basis.excerptHash = createHash("sha256").update(evidence.basis.excerpt).digest("hex");
    suggestion.evidence.inputFingerprint = inputFingerprint([evidence]);
    if (suggestion.apply) suggestion.apply.dependencies = [{ key: source, fingerprint: evidence.fingerprint }];
    for (const receipt of suggestion.receipts) if (receipt.evidence) receipt.evidence = { [source]: evidence.evidenceFingerprint };
  }
  return state;
};
