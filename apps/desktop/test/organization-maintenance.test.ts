import { describe, expect, it } from "vitest";
import { maintenanceDrafts } from "../src/main/organization-maintenance.js";
import { hashOf } from "../src/main/organization-core.js";
import { pendingConfirmationMaterial, readSources, type SourceUnit } from "../src/main/organization-sources.js";
const unit = (kind: SourceUnit["kind"], material: string, role: SourceUnit["role"] = "statement"): SourceUnit => ({ key: `${kind}:1`, kind, title: material, label: material, material, project: "项目", at: null, relativePath: null, fingerprint: hashOf(material), evidenceFingerprint: hashOf(material), role, rootKeys: [`${kind}:1`], lineage: "self" });
const empty = { memory: null, triage: null, question: null };
describe("自动整理的证据与注意力边界", () => {
  it("机器记忆只使用本次来源的连续原文，不把模型改写当作引文", () => {
    const source = unit("preference", "先验证自动重试；网络切换仍未知。");
    const memory = { title: "重试范围", scene: "项目", observations: [{ ref: "K1", quote: "网络切换已成功" }], inference: "有限推断", unknowns: "无独立验证" };
    expect(maintenanceDrafts([source], { ...empty, memory }, null)).toEqual([]);
    memory.observations[0]!.quote = "网络切换仍未知";
    expect(maintenanceDrafts([source], { ...empty, memory }, null)[0]?.content).toMatchObject({ type: "experience", verification: "machine_synthesis", outcome: "unknown", memoryKind: "knowledge" });
  });
  it("摘要或候选不能成为用户承诺，没有当前待处理事项也不提出判断", () => {
    const task = unit("pending_confirmation", "本周发布", "derived");
    const commitment = unit("decision", "承诺先完成网络切换修复");
    const question = { category: "commitment", task: "K1", commitments: [{ ref: "K2", quote: "先完成网络切换修复" }], question: "先修复还是延期？", impact: "当前发布受影响", unknowns: "工程师估算未核验", options: ["先完成修复", "按期发布"], recommendation: "option_a", recommendationReason: "已有承诺" };
    expect(maintenanceDrafts([task, commitment], { ...empty, question }, null).filter((s) => s.type === "judgment")).toHaveLength(1);
    expect(maintenanceDrafts([task, { ...commitment, role: "derived" }], { ...empty, question }, null).filter((s) => s.type === "judgment")).toHaveLength(0);
    expect(maintenanceDrafts([unit("summary", "本周发布", "derived"), commitment], { ...empty, question }, null).filter((s) => s.type === "judgment")).toHaveLength(0);
  });
  it("已确认选择只引用实际确认的原文，机器背景和推断不能成为新承诺", async () => {
    const at = "2026-11-14T00:00:00.000Z";
    const body = { title: "发布安排", scene: "机器背景：所有功能必须本周发布", action: "只记录选择，尚未执行", observation: "用户确认：先验证重试；仅测试环境，正式发布仍待批准", inference: "机器推断：正式发布已经获批", exceptions: "机器估算：无需补充审核" };
    const snapshot = await readSources({
      todos: async () => ({ lists: [], diagnostics: [] }),
      journal: async () => ({ entries: [], diagnostics: [] }),
      decisions: async () => ({ documents: [], sources: [] }),
      amendments: async () => ({ records: new Map(), unavailable: false }),
      experiences: async () => ({ diagnostics: [], experiences: [true, false].map((choice) => ({
        path: `experience-${choice}.md`, relativePath: `experience-${choice}.md`, noteHash: hashOf(String(choice)),
        record: { id: `choice-${choice}`, revision: 1, status: "active", project: "项目", createdAt: at, updatedAt: at, reporter: "user", verification: "user_reported", outcome: "unknown", adoptedFrom: "judgment@r1", generator: null, body, sources: [], ...(choice ? { userChoice: true as const } : {}) },
      })) }),
      relative: (path) => path,
    }, new Date(at));
    const choice = snapshot.units.get("experience:choice-true")!;
    const task = unit("pending_confirmation", "本周发布", "derived");
    const question = { category: "authorization", task: "K1", commitments: [{ ref: "K2", quote: "" }], question: "是否立即正式发布？", impact: "发布时机", unknowns: "尚未执行", options: ["立即发布", "继续等待"], recommendation: "option_b", recommendationReason: "保留授权边界" };
    for (const quote of [body.scene, body.inference, body.exceptions]) {
      question.commitments[0]!.quote = quote;
      expect(maintenanceDrafts([task, choice], { ...empty, question }, null).filter((entry) => entry.type === "judgment")).toHaveLength(0);
    }
    question.commitments[0]!.quote = body.observation;
    expect(maintenanceDrafts([task, choice], { ...empty, question }, null).filter((entry) => entry.type === "judgment")).toHaveLength(1);
    expect(choice.material).toContain(body.observation);
    expect(snapshot.units.get("experience:choice-false")?.material).toContain(body.inference);
    expect(snapshot.units.get("experience:choice-false")?.role).toBe("derived");
  });
  it("没有可引用的用户陈述时不能报成已关联；缺理由和缺结果都不产生问题", () => {
    for (const kind of ["pending_rationale", "review"] as const) {
      const source = unit(kind, "未知", "derived");
      const drafts = maintenanceDrafts([source], { ...empty, triage: { disposition: "linked", explanation: "模型声称找到答案", evidence: [{ ref: "K8", quote: "用户已经确认" }] } }, null);
      expect(drafts).toHaveLength(1);
      expect(drafts[0]?.content).toMatchObject({ type: "triage", disposition: kind === "review" ? "waiting" : "unknown", links: [] });
    }
  });
});

it("待确认来源保留问题、原回复和缺失边界，不把内部元数据写进材料", () => {
  const material = pendingConfirmationMaterial({ eventVersion: 1, captureMode: "transcript", sourceClient: "test", sessionId: "internal-session", batchId: "internal-batch", cwd: "/private/local/path", project: "项目", capturedAt: "2026-11-13T00:00:00Z", questions: [{ questionIndex: 0, question: "日志保留多久？", options: [{ label: "14 天", description: "只包含当前项目" }], answer: { kind: "preset", values: ["14 天"], reply: "暂按 14 天，理由未定" }, multiSelect: false }], context: { truncated: true } });
  expect(material).toContain("暂按 14 天，理由未定");
  expect(material).toContain("只包含当前项目");
  expect(material).toContain("原始背景不完整");
  expect(material).not.toMatch(/internal-session|internal-batch|private\/local|eventVersion/u);
});
