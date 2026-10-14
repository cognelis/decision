import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ObsidianSearchIndex,
  ObsidianVaultRepository,
} from "@cognelis/decision-storage";
import { ObsidianSearchService } from "../src/main/obsidian-search/obsidian-search-service.js";

/**
 * A graded retrieval corpus, in the shape the semantic classifier already has.
 *
 * Everything else in this suite grades *shape* — fields inside their limits,
 * boundaries that hold, steps in order. None of it can tell whether asking a
 * question actually finds the note that answers it, which is the only thing the
 * reader cares about. This is that measurement.
 *
 * Scope, stated plainly: the embeddings here are synthetic, so this grades
 * KEYWORD retrieval — the chunker, the index and the query path. Semantic
 * ranking needs the real Qwen weights and belongs in an opt-in harness beside
 * `check:semantic`, not in a suite that must run anywhere.
 */

/*
 * Floors, not targets: measured at recall@5 = 1.0 and MRR = 0.9 over this
 * corpus, then set one notch below so ordinary noise does not fail the suite
 * while a real regression still does. Chance would score about 0.21 here —
 * five results drawn from twenty-four notes — which is what makes the number
 * worth reading.
 */
const RECALL_AT_5_FLOOR = 0.9;
const MRR_FLOOR = 0.8;

const roots: string[] = [];
const services: ObsidianSearchService[] = [];

afterEach(async () => {
  await Promise.allSettled(
    services.splice(0).map((service) => service.close()),
  );
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

/**
 * Every chunk gets the same unit vector, so cosine similarity carries no
 * signal and ranking falls entirely to the keyword path — which is the path
 * this file grades.
 */
const flatEmbedding = {
  model: "synthetic",
  embed: async (texts: string[]) => ({
    model: "synthetic",
    vectors: texts.map(() => [1, 0, 0]),
  }),
  close: async () => undefined,
};

const VAULT: ReadonlyArray<readonly [string, string]> = [
  [
    "运维/发布回滚.md",
    "# 发布回滚检查清单\n\n发布出问题时先确认回滚入口可用，再决定是否继续发布。\n回滚演练每季度做一次。\n",
  ],
  [
    "运维/配置变更.md",
    "# 配置变更流程\n\n配置变更先留在测试环境验证，dev 环境完整可验之后才推线上。\n不把暂未开放的能力写进线上配置。\n",
  ],
  [
    "工程/桌面检索.md",
    "# 桌面检索方案\n\n本地关键词检索作为降级路径，语义检索不可用时仍能返回结果。\n索引只在本机建立。\n",
  ],
  [
    "工程/模型后端.md",
    "# 模型后端选择\n\n本机模型优先，远程 API 需要用户明确确认后才发送内容。\n终端后端按优先级回退。\n",
  ],
  [
    "团队/复盘节奏.md",
    "# 复盘节奏\n\n决策落地后按到期日回填结果，再安排复盘。\n没有结果就不写复盘结论。\n",
  ],
  [
    "团队/会议记录/2026-08.md",
    "# 八月例会\n\n讨论了发布回滚演练的频率，以及配置变更的验证顺序。\n",
  ],
  [
    "个人/阅读笔记.md",
    "# 阅读笔记\n\n关于组织决策的记录方式，作者主张把理由和结论分开保存。\n",
  ],
  [
    "个人/工具链.md",
    "# 工具链\n\n编辑器、终端和笔记工具之间的衔接，尽量少装插件。\n",
  ],
  // Distractors. Without a vault larger than the result window, recall@5
  // is something chance scores well on and therefore measures nothing.
  [
    "参考/容器编排.md",
    "# 容器编排\n\n调度器如何分配副本，以及滚动更新的批次大小。\n",
  ],
  [
    "参考/日志采集.md",
    "# 日志采集\n\n采集代理的缓冲区设置与落盘策略。\n",
  ],
  [
    "参考/权限模型.md",
    "# 权限模型\n\n角色与资源的映射关系，最小权限原则。\n",
  ],
  [
    "参考/缓存策略.md",
    "# 缓存策略\n\n过期时间与穿透保护，热点数据的预热。\n",
  ],
  [
    "参考/消息队列.md",
    "# 消息队列\n\n分区与消费组，重复投递的幂等处理。\n",
  ],
  [
    "参考/数据备份.md",
    "# 数据备份\n\n全量与增量的周期，恢复演练的记录方式。\n",
  ],
  [
    "参考/网络拓扑.md",
    "# 网络拓扑\n\n子网划分与出口带宽，跨机房延迟。\n",
  ],
  [
    "参考/依赖升级.md",
    "# 依赖升级\n\n主版本跳跃的兼容性检查与灰度顺序。\n",
  ],
  [
    "随笔/城市漫步.md",
    "# 城市漫步\n\n周末沿着河岸走了很久，记下几处想再来的地方。\n",
  ],
  [
    "随笔/咖啡豆.md",
    "# 咖啡豆\n\n不同产区的风味差异，手冲的水温与粉水比。\n",
  ],
  [
    "随笔/长跑.md",
    "# 长跑\n\n配速与心率的关系，赛前一周的减量安排。\n",
  ],
  [
    "随笔/摄影.md",
    "# 摄影\n\n光圈与景深，逆光时的曝光补偿。\n",
  ],
  [
    "学习/线性代数.md",
    "# 线性代数\n\n特征值与特征向量的几何含义。\n",
  ],
  [
    "学习/概率论.md",
    "# 概率论\n\n条件概率与贝叶斯公式的常见误用。\n",
  ],
  [
    "学习/编译原理.md",
    "# 编译原理\n\n词法分析与语法分析的分工。\n",
  ],
  [
    "学习/操作系统.md",
    "# 操作系统\n\n进程调度与虚拟内存的页面置换。\n",
  ],
];

/** Question → the note that should answer it. */
const CORPUS: ReadonlyArray<{ question: string; expected: string }> = [
  { question: "回滚入口", expected: "运维/发布回滚.md" },
  { question: "回滚演练 频率", expected: "运维/发布回滚.md" },
  { question: "配置变更 测试环境", expected: "运维/配置变更.md" },
  { question: "线上配置 未开放能力", expected: "运维/配置变更.md" },
  { question: "关键词 降级路径", expected: "工程/桌面检索.md" },
  { question: "语义检索 不可用", expected: "工程/桌面检索.md" },
  { question: "远程 API 确认", expected: "工程/模型后端.md" },
  { question: "终端后端 回退", expected: "工程/模型后端.md" },
  { question: "回填结果 复盘", expected: "团队/复盘节奏.md" },
  { question: "理由 结论 分开保存", expected: "个人/阅读笔记.md" },
];

const indexedVault = async (): Promise<ObsidianSearchService> => {
  const root = await mkdtemp(join(tmpdir(), "retrieval-evaluation-"));
  roots.push(root);
  const vault = join(root, "vault");
  await mkdir(vault);
  for (const [relativePath, content] of VAULT) {
    const absolute = join(vault, ...relativePath.split("/"));
    await mkdir(join(absolute, ".."), { recursive: true });
    await writeFile(absolute, content, "utf8");
  }
  const service = new ObsidianSearchService({
    repository: new ObsidianVaultRepository(vault),
    index: new ObsidianSearchIndex(join(root, "search.sqlite")),
    embedding: flatEmbedding,
    watcherFactory: () => ({ start: () => undefined, close: () => undefined }),
    openExternal: vi.fn(async () => undefined),
    now: () => new Date("2026-09-13T10:00:00.000Z"),
  } as unknown as ConstructorParameters<typeof ObsidianSearchService>[0]);
  services.push(service);
  await service.rebuild();
  return service;
};

describe("retrieval quality", () => {
  it.skipIf(process.env.DECISION_BENCHMARK !== "1")("measures initial keyword retrieval", async () => {
    const start = performance.now();
    const service = await indexedVault();
    const indexReadyMs = performance.now() - start;
    const tick = performance.now();
    const response = await service.search({ query: "配置变更 测试环境", limit: 5 });
    process.stdout.write("RETRIEVAL_BENCHMARK " + JSON.stringify({ indexReadyMs, firstSearchMs: performance.now() - tick, documents: VAULT.length }) + "\n");
    expect(response.results.some((result) => result.relativePath === "运维/配置变更.md")).toBe(true);
  });

  it("finds the answering note for the questions in the corpus", async () => {
    const service = await indexedVault();
    const missed: string[] = [];

    for (const { question, expected } of CORPUS) {
      const response = await service.search({ query: question, limit: 5 });
      const found = response.results.some(
        (result) => result.relativePath === expected,
      );
      if (!found) missed.push(`${question} → ${expected}`);
    }

    const recall = (CORPUS.length - missed.length) / CORPUS.length;
    // Naming the misses is the point: a bare ratio says a number moved, this
    // says which question stopped being answerable.
    expect(missed).toEqual([]);
    expect(recall).toBeGreaterThanOrEqual(RECALL_AT_5_FLOOR);
  });

  it("puts the answering note first, not merely somewhere in the page", async () => {
    const service = await indexedVault();
    const ranks: number[] = [];

    for (const { question, expected } of CORPUS) {
      const response = await service.search({ query: question, limit: 5 });
      const rank = response.results.findIndex(
        (result) => result.relativePath === expected,
      );
      if (rank >= 0) ranks.push(1 / (rank + 1));
    }

    // Mean reciprocal rank: 1.0 when every answer is the first result. Recall
    // alone would stay green while the right note drifted to position five.
    const mrr = ranks.reduce((total, value) => total + value, 0) / CORPUS.length;
    expect(mrr).toBeGreaterThanOrEqual(MRR_FLOOR);
  });

  /*
   * Not graded here: whether an unanswerable question comes back empty. Every
   * chunk carries the same vector, so cosine similarity is 1 for all of them
   * and the semantic path matches the whole vault — that measures the stub,
   * not the product. It needs the real Qwen weights and a similarity floor,
   * which is the opt-in harness's job.
   */
});
