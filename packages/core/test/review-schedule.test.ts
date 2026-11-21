import { describe, expect, it } from "vitest";

import {
  RationaleQueue,
  createDecisionRecord,
  createManualDecisionRecord,
  defaultReviewSchedule,
  reviewScheduleReasons,
} from "../src/index.js";
import type { ManualDecisionInput } from "../src/index.js";
import { captureFixture, questionFixture } from "./fixtures.js";

// Synthetic examples, written for these tests.
const reasons = (question: string, decision = "", expectedOutcome: string | null = null) =>
  reviewScheduleReasons({ texts: [question, decision], expectedOutcome });

describe("reviewScheduleReasons", () => {
  it.each([
    ["数据库用 PostgreSQL 还是 SQLite？", "用 SQLite", "selection"],
    ["Which library should parse the YAML front matter?", "Go with js-yaml instead of a hand-written parser", "selection"],
    ["消息队列选型", "选 Kafka", "selection"],
    ["Redis 还是 Memcached 做缓存？", "Redis", "selection"],
    ["模块边界怎么划？", "把索引拆成独立模块，存储层只读 Markdown", "architecture"],
    ["Should we change the data model for outcomes?", "Store reviews as a separate table", "architecture"],
    ["历史数据要不要迁移到新的存储结构？", "迁移", "architecture"],
    ["今天下午发版吗？", "先灰度 10%，没问题再全量上线", "release"],
    ["When do we deploy the new bridge?", "Ship it after the smoke test passes, roll back if hooks fail", "release"],
  ])("schedules %s as %s", (question, decision, reason) => {
    expect(reasons(question, decision)).toEqual([reason]);
  });

  it("schedules any decision whose expected outcome was written down", () => {
    expect(reasons("这个按钮放左边还是右边？", "右边", "点击率提高")).toEqual(["expected_outcome"]);
    expect(reasons("今天发版吗？", "发", "周五前用户能用上")).toEqual(["expected_outcome", "release"]);
    expect(reasons("按钮放哪？", "右边", "   ")).toEqual([]);
  });

  it.each([
    ["这个变量叫 fooBar 还是 foo_bar？", "fooBar"],
    ["部署脚本里的函数怎么命名？", "deployRelease"],
    ["Should the migration helper be renamed?", "Rename it to applySchemaChange"],
    ["提示文案用「保存」还是「确定」？", "保存"],
    ["测试用例怎么写？", "每个分支一个 it"],
    ["先做导出还是先做导入？", "先做导入"],
    ["这个空指针怎么修？", "加判空"],
    ["Fix the crash in the release notes parser with a guard or a try/catch?", "A guard"],
    ["要不要把 PR 评论发布到平台？", "发布"],
    ["事务失败时回滚吗？", "回滚"],
    ["Use tabs or spaces?", "Spaces"],
    ["Sure, go ahead", "OK"],
  ])("leaves %s unscheduled", (question, decision) => {
    expect(reasons(question, decision)).toEqual([]);
  });
});

// RV2: the mechanisms the adversarial round found (R5-SK), each in words of our own.
describe("reviewScheduleReasons, second version", () => {
  const of = (...texts: string[]) => reviewScheduleReasons({ texts, expectedOutcome: null });

  it.each([
    ["本周不上线，先把灰度方案写成文档"],
    ["不部署到生产环境，只给测试同学试用"],
    ["消息队列先不选型，等压测结果"],
    ["框架尚未选择，先做原型"],
    ["Kafka 还是 Pulsar 还没定"],
    ["会上列了 MySQL、MongoDB 两个选项，今天先不定"],
    ["这次调整不涉及选型、架构或发布"],
    ["We will not deploy this to production."],
    ["The database vendor is undecided; no provider is selected yet."],
  ])("(a) leaves a negated or undecided call unscheduled: %s", (text) => {
    expect(of(text)).toEqual([]);
  });

  it.each([
    ["系统架构图里把网关画成橙色"],
    ["架构评审文档改用单栏排版"],
    ["图例里缓存节点改成虚线，系统结构不变"],
    ["Recolor the architecture diagram's database box."],
  ])("(b) does not count a diagram or document as architecture: %s", (text) => {
    expect(of(text)).toEqual([]);
  });

  it("(c) judges a small call clause by clause, not the whole text", () => {
    expect(of("采用 Kafka 做事件总线；另外把 YAML 缩进改成两格")).toEqual(["selection"]);
    expect(of("Adopt MySQL for the reporting store.", "Also fix the naming of the config keys.")).toEqual(["selection"]);
    expect(of("把搜索服务拆成独立进程", "补一个测试用例")).toEqual(["architecture"]);
    // The small call itself stays unscheduled.
    expect(of("把 deployTarget 重命名为 target")).toEqual([]);
  });

  it.each([
    ["Use MongoDB for the audit log.", "selection"],
    ["We will switch to RabbitMQ for background jobs.", "selection"],
    ["Cloudflare will be the CDN vendor.", "selection"],
    ["主库改用 MySQL", "selection"],
    ["对象存储用 S3", "selection"],
    ["把用户表拆成账号表和资料表", "architecture"],
    ["报表计算拆到独立 worker", "architecture"],
    ["把内部接口从 REST 迁到 gRPC", "architecture"],
    ["Move the internal API from GraphQL to REST.", "architecture"],
    ["Split exports into a separate service.", "architecture"],
    ["Migrate audit entries into the new history table.", "architecture"],
    ["日志表按租户分片", "architecture"],
    ["Shard the events table by account.", "architecture"],
    ["We will ship 3.1.0 to production on Monday.", "release"],
    ["Roll out the new sync engine to all users next week.", "release"],
    ["Deploy the hotfix to production tonight.", "release"],
    ["补丁版本周四晚上发版", "release"],
    ["先发 API 再发客户端", "release"],
  ])("(d) covers %s as %s", (text, reason) => {
    expect(of(text)).toContain(reason);
  });

  it("(d) counts a deploy only when it is not to a test or local environment", () => {
    expect(of("Deploy the branch to staging for QA.")).toEqual([]);
    expect(of("部署到本地测试环境")).toEqual([]);
    expect(of("把新版部署到生产")).toEqual(["release"]);
  });
});

// RV3: what is decided (a key, a boundary, a protocol, when to release), not only the category's own name (R5-PA B1).
describe("reviewScheduleReasons, third version", () => {
  const of = (...texts: string[]) => reviewScheduleReasons({ texts, expectedOutcome: null });

  it.each([
    ["订单号做主键还是另加自增 ID？", "另加自增 ID"],
    ["标签和文章是一对多还是多对多？", "多对多"],
    ["审计日志存成单独的表吗？", "存成单独表"],
    ["重试状态放在内存还是落到数据库？", "落库"],
    ["这个配置项放在 settings.json 还是环境变量？", "环境变量"],
    ["去重这件事归哪一层管？", "归存储层"],
    ["把 cli 和 sdk 两个包合并成一个？", "合并"],
    ["把导出功能拆出去单独部署？", "拆出去"],
    ["先保持单体，还是现在就拆服务？", "保持单体"],
    ["前端和后端之间用什么协议通信？", "WebSocket"],
    ["Should the event payload carry a version field?", "Yes, version it"],
    ["旧的缓存文件格式要不要迁移？", "要迁"],
    ["Do we migrate the old records to the new layout?", "Yes"],
    ["通知走同步调用还是异步消息？", "异步消息"],
    ["Event sourcing or plain tables for the audit trail?", "Plain tables"],
  ])("schedules an architecture call said by what it decides: %s", (question, answer) => {
    expect(of(question, answer)).toContain("architecture");
  });

  it.each([
    ["这个补丁周五发还是下周一发？", "下周一"],
    ["要不要推迟发布？", "推迟一天"],
    ["新功能先放量到 10% 吗？", "先 10%"],
    ["下个版本号用 3.0 吗？", "用 3.0"],
    ["Feature flag 上线后默认打开吗？", "默认关闭"],
    ["先发 rc 还是直接发正式版？", "先 rc"],
    ["Launch the beta on Thursday?", "Yes"],
    ["Push the fix to production tonight?", "Tomorrow morning"],
    ["Hotfix now or wait for 2.5?", "Wait"],
  ])("schedules a release call said by what it decides: %s", (question, answer) => {
    expect(of(question, answer)).toContain("release");
  });

  it.each([
    ["通知用企业微信还是飞书？", "飞书"],
    ["构建工具换成 Vite？", "换"],
    ["用哪个日志库？", "pino"],
    ["Use Turso or stay on Postgres?", "Stay"],
    ["Locking: Redis or ZooKeeper?", "ZooKeeper"],
  ])("schedules a choice between products: %s", (question, answer) => {
    expect(of(question, answer)).toContain("selection");
  });

  it.each([
    // Two words against each other are not two products.
    ["列名叫 created 还是 createdAt？", "createdAt"],
    ["返回 null 还是空数组？", "空数组"],
    ["Log at debug or info?", "debug"],
    ["PUT 还是 PATCH？这个只在本地脚本里用", "PATCH"],
    // A word of a category that names a file, a document or a thing about it.
    ["schema 文件放在哪个目录？", "放 docs"],
    ["JSON schema 校验失败时用什么提示？", "提示格式错误"],
    ["The protocol notes need a table, add one?", "Yes"],
    ["Should the architecture page get a summary?", "Yes"],
    ["deployment 说明放 README 还是 wiki？", "README"],
    ["办公室迁移到新楼后打印机要不要换？", "换"],
    ["Add a comment above the rollback flag?", "Yes"],
    ["发布脚本里的变量要不要改名？", "改"],
  ])("leaves a small call or a look-alike unscheduled: %s", (question, answer) => {
    expect(of(question, answer)).toEqual([]);
  });

  it("lets a small-call word stand only when nothing in the clause decides a category", () => {
    expect(of("分布式锁用 Redis 还是 etcd？顺带改个注释", "Redis")).toContain("selection");
    expect(of("要不要把注释也写进全文索引（存储结构要变）？", "写进")).toContain("architecture");
    expect(of("Which DNS do we run, CoreDNS or Unbound? Ignore the naming for now.", "CoreDNS")).toContain("selection");
    expect(of("这个变量注释要不要改？", "改")).toEqual([]);
  });
});

// RV4: precision. The third adversarial round (R5-SK 排期三), each mechanism in words of our own.
describe("reviewScheduleReasons, fourth version", () => {
  const of = (...texts: string[]) => reviewScheduleReasons({ texts, expectedOutcome: null });

  it.each([
    ["Beta 还是 Stable 这个标签？", "Beta"],
    ["Option One or Option Two?", "Option One"],
    ["Gold or Silver tier?", "Gold"],
    ["方案选 Lite 还是 Pro？", "Pro"],
    ["常量用 SCREAMING_CASE 还是 PascalCase？", "PascalCase"],
    ["时间戳用 ISO 8601 还是 RFC 2822？", "ISO 8601"],
    ["日期写成 DD/MM/YYYY 还是 MM-DD-YYYY？", "MM-DD-YYYY"],
  ])("does not take a capitalised word, a naming style or a format for a product: %s", (question, answer) => {
    expect(of(question, answer)).toEqual([]);
  });

  it.each([
    ["Saga 还是 TCC？", "Saga"],
    ["Use DynamoDB or MongoDB?", "MongoDB"],
    ["gRPC 还是 Thrift？", "gRPC"],
    ["k8s or nomad for the workers?", "k8s"],
  ])("still takes a name with a technical shape for a product: %s", (question, answer) => {
    expect(of(question, answer)).toContain("selection");
  });

  it.each([
    ["这个配置项放在设置页还是详情页？", "设置页"],
    ["错误状态放在卡片上方还是下方？", "上方"],
    ["Where should the sync status live, in the header or the sidebar?", "Header"],
    ["这个字段放在弹窗里还是表单里？", "表单"],
  ])("does not take where something sits on screen for architecture: %s", (question, answer) => {
    expect(of(question, answer)).toEqual([]);
  });

  it("takes where state is stored for architecture", () => {
    expect(of("Should the draft state live in memory or on disk?", "On disk")).toContain("architecture");
    expect(of("会话状态放在 cookie 还是数据库？", "数据库")).toContain("architecture");
  });

  it.each([
    ["产品发布会改到下周二", "改"],
    ["技术分享会推迟发布到月底", "月底"],
    ["The launch party moves to Saturday.", "Saturday"],
    ["Should the launch announcement go out on Monday?", "Monday"],
    ["Rename the hotfix branch to fix/login?", "Yes"],
    ["hotfix 分支叫 hotfix-7 还是 patch-7？", "hotfix-7"],
    ["发布博客定在周四", "周四"],
  ])("does not take an event, a post or a branch's name for a release: %s", (question, answer) => {
    expect(of(question, answer)).toEqual([]);
  });

  it.each([
    ["Launch the new onboarding on Monday?", "Yes"],
    ["Do we launch next week?", "Yes"],
    ["Hotfix 2.3.1 tonight or tomorrow?", "Tonight"],
    ["新版本推迟发布到下周", "推迟"],
  ])("still takes a release with its object or its timing: %s", (question, answer) => {
    expect(of(question, answer)).toContain("release");
  });
});

describe("defaultReviewSchedule", () => {
  it("dates the review fourteen local calendar days after the write", () => {
    // Late on the 31st in local time: the 14th of the next month, whatever UTC says.
    const late = new Date(2026, 9, 31, 23, 30);
    expect(defaultReviewSchedule(["今天发版吗？"], null, late)).toEqual({
      reviewDueDate: "2026-11-14",
      reasons: ["release"],
    });
    expect(defaultReviewSchedule(["按钮放哪？"], null, late)).toBeNull();
  });
});

const manual = (overrides: Partial<ManualDecisionInput> = {}): ManualDecisionInput => ({
  question: "今天下午发版吗？",
  decision: "先灰度再全量",
  project: "decision",
  sourceKind: "app_manual",
  sourceForm: "user_original",
  ...overrides,
});

describe("decision records", () => {
  const now = new Date(2026, 9, 21, 10);

  it("schedule a new decision worth reviewing and say why", () => {
    expect(createManualDecisionRecord(manual(), "m-1", now)).toMatchObject({
      reviewDueDate: "2026-11-04",
      reviewScheduleReasons: ["release"],
    });
  });

  it("keep a review date the writer gave", () => {
    const given = createManualDecisionRecord(manual({ reviewDueDate: "2026-12-01" }), "m-2", now);
    expect(given.reviewDueDate).toBe("2026-12-01");
    expect(given.reviewScheduleReasons).toBeUndefined();
  });

  it("leave an ordinary decision unscheduled", () => {
    const plain = createManualDecisionRecord(manual({ question: "按钮放哪？", decision: "右边" }), "m-3", now);
    expect(plain.reviewDueDate).toBeNull();
    expect(plain.reviewScheduleReasons).toBeUndefined();
  });

  it("schedule a captured decision from its question, options and answer", () => {
    const queue = new RationaleQueue(() => "candidate-1");
    queue.ingest(captureFixture({
      capturedAt: now.toISOString(),
      questions: [questionFixture(0, {
        question: "这个能力先放哪？",
        options: [{ label: "本周五上线" }, { label: "下个版本再发版" }],
        answer: { kind: "preset", values: ["本周五上线"], reply: "本周五上线" },
      })],
    }));
    const candidate = queue.snapshot().current!;
    expect(createDecisionRecord(candidate, { status: "captured", rationale: "赶在月底前" }, "d-1", now))
      .toMatchObject({ reviewDueDate: "2026-11-04", reviewScheduleReasons: ["release"] });
    expect(createDecisionRecord(candidate, { status: "captured", expectedOutcome: "月底前有人用" }, "d-2", now))
      .toMatchObject({ reviewScheduleReasons: ["expected_outcome", "release"] });
  });
});

// R6-RV: recall. The C set's misses (mechanisms only), each in words of our own; no new over-scheduling.
describe("reviewScheduleReasons, fifth version", () => {
  const of = (...texts: string[]) => reviewScheduleReasons({ texts, expectedOutcome: null });

  it.each([
    ["支付接 Stripe 还是 Paddle？", "Paddle"],
    ["短信通道用 Twilio 还是 Vonage？", "Twilio"],
    ["鉴权方案用 Keycloak 还是 Authelia？", "Keycloak"],
    ["Auth: Clerk or Lucia?", "Clerk"],
    ["Stripe 还是 Paddle 做收款？", "Stripe"],
  ])("takes two plain names set against each other where a service is chosen: %s", (question, answer) => {
    expect(of(question, answer)).toContain("selection");
  });

  it.each([
    ["支付页的按钮用 Primary 还是 Secondary？", "Primary"],
    ["鉴权配置选 Basic 还是 Advanced？", "Basic"],
    ["告警级别选 High 还是 Medium？", "High"],
    ["短信模板用 Draft 还是 Final？", "Draft"],
    ["鉴权失败时 retry 还是 abort？", "retry"],
    ["登录页的提示叫 Welcome 还是 Hello？", "Welcome"],
    ["监控图表用 Daily 还是 Weekly 粒度？", "Daily"],
    ["埋点事件用 Click 还是 Tap？", "Click"],
    ["Auth flow: Redirect or Popup?", "Redirect"],
    ["Billing cycle: Monthly or Yearly?", "Monthly"],
  ])("does not take plain words, levels or a screen near a service for a selection: %s", (question, answer) => {
    expect(of(question, answer)).toEqual([]);
  });

  it.each([
    ["One service or two?", "Two"],
    ["Should billing and auth be a single service or two services?", "Two services"],
    ["单服务还是双服务？", "双服务"],
    ["做成一个进程还是两个进程？", "两个进程"],
    ["索引和采集放一个包还是两个包？", "两个包"],
  ])("takes how many services or processes there are for architecture: %s", (question, answer) => {
    expect(of(question, answer)).toContain("architecture");
  });

  it.each([
    ["One test or two?", "Two"],
    ["一个按钮还是两个按钮？", "一个"],
    ["开一个 worker 还是两个 worker？", "两个"],
    ["这一节写一页还是两页？", "一页"],
    ["One commit or two?", "Two"],
    ["no downtime is expected for the lint change", "ok"],
  ])("does not take a count of other things for architecture: %s", (question, answer) => {
    expect(of(question, answer)).toEqual([]);
  });

  it.each([
    ["迁移期间用双写还是停机？", "双写"],
    ["不停机迁移还是停机迁移？", "不停机迁移"],
    ["Dual-write during the cutover, or take downtime?", "Dual-write"],
    ["Zero-downtime or a maintenance window?", "Zero-downtime"],
  ])("takes how a migration is carried out for architecture: %s", (question, answer) => {
    expect(of(question, answer)).toContain("architecture");
  });
});

// R6-RV2: precision. The R6 adversarial rounds (R6-SK 排期), each mechanism in words of our own.
describe("reviewScheduleReasons, sixth version", () => {
  const of = (...texts: string[]) => reviewScheduleReasons({ texts, expectedOutcome: null });

  it.each([
    ["Billing provider: Quarterly or Annual?", "Annual"],
    ["For notifications service: Silent or Loud?", "Silent"],
    ["Auth service: Inline or Hosted?", "Hosted"],
    ["告警通道用 Instant 还是 Digest？", "Digest"],
    ["支付通道用 Online 还是 Offline？", "Online"],
  ])("does not take two plain words in a service's slot for a selection: %s", (question, answer) => {
    expect(of(question, answer)).toEqual([]);
  });

  it.each([
    ["邮件服务接 Mailgun 还是 Resend？", "Resend"],
    ["监控平台用 Grafana 还是 New Relic？", "New Relic"],
    ["For error tracking: Rollbar or Sentry?", "Sentry"],
    ["Pick Bugsnag or Rollbar for crash reporting.", "Bugsnag"],
    ["Use Mixpanel or Amplitude for analytics?", "Mixpanel"],
  ])("takes a named vendor in a service's slot: %s", (question, answer) => {
    expect(of(question, answer)).toContain("selection");
  });

  it("judges the screen and naming of each clause, not of the whole decision", () => {
    expect(of("短信服务用 Plivo 还是 Sinch？", "标签放在右边。")).toContain("selection");
    expect(of("For payments: Braintree or Adyen?", "The field is named providerId.")).toContain("selection");
    expect(of("给短信服务命名：Plivo 还是 Sinch？", "Plivo")).toEqual([]);
  });

  it.each([
    ["The rollout guide should explain dual-write and blue-green.", "OK"],
    ["迁移指南里写清双写和停机迁移两种做法", "写清"],
    ["The changelog mentions a canary rollout.", "Fine"],
  ])("does not take a guide or a text that mentions a way to migrate or release: %s", (question, answer) => {
    expect(of(question, answer)).toEqual([]);
  });

  it.each([
    ["We already moved the orders table to the new database last month; nothing to decide.", "OK"],
    ["灰度已经完成，这里只记一下。", "好"],
    ["The migration of the notes is complete.", "Good"],
  ])("does not take what was already done for a decision: %s", (question, answer) => {
    expect(of(question, answer)).toEqual([]);
  });

  it("does not take a plain word that merely contains a category's letters", () => {
    expect(of("邮件服务用 Formal 还是 Casual？", "Formal")).toEqual([]);
  });

  it("still takes a decision made already", () => {
    expect(of("We already decided to migrate the sessions table to Postgres.", "Yes")).not.toEqual([]);
  });
});

// R7-RV: recall of the C6 mechanisms (R6-HO-C3, mechanisms only) and the RV2 whitebox "already" misses, in words
// of our own, with traps beside each.
describe("reviewScheduleReasons, seventh version", () => {
  const of = (...texts: string[]) => reviewScheduleReasons({ texts, expectedOutcome: null });

  it.each([
    ["新功能分批开放给客户，还是一次全开？", "分批开放"],
    ["桌面端补丁什么时候提交到应用商店？", "周四提交"],
    ["先给企业客户交付，还是先开放下载？", "先交付企业客户"],
    ["企业客户交付和开放下载的先后怎么排？", "交付在前"],
    ["When should we turn on the new importer for production users?", "Next Monday"],
    ["Should we enable the sync engine for paying customers this week?", "Yes"],
    ["Submit the patch to the App Store this week?", "Yes"],
  ])("takes a way of putting a build in users' hands for a release: %s", (question, answer) => {
    expect(of(question, answer)).toContain("release");
  });

  it.each([
    ["这个设置要不要开放给用户修改？", "开放"],
    ["Enable dark mode in the settings page for users?", "Yes"],
    ["应用商店截图用哪一张？", "第二张"],
    ["Turn on verbose logging for local runs?", "Yes"],
  ])("does not take a setting or a screen for a release: %s", (question, answer) => {
    expect(of(question, answer)).toEqual([]);
  });

  it.each([
    ["一个独立服务还是两个服务？", "一个"],
    ["两个后台进程还是合成一个？", "合成一个"],
    ["One shared backend service or two separate ones?", "Two"],
    ["旧文件用渐进转换还是批量转换？", "渐进转换"],
    ["Convert the old notes lazily on read or in one batch?", "In one batch"],
    ["模块之间的会话数据由谁持有？", "由 core 持有"],
    ["这份事件契约归哪个服务负责维护？", "bridge"],
    ["Which service owns the event contract between bridge and app?", "The bridge"],
    ["Ownership of the order events: core or the app?", "core"],
  ])("takes ownership, a count with a modifier and a gradual or bulk conversion for architecture: %s", (question, answer) => {
    expect(of(question, answer)).toContain("architecture");
  });

  it.each([
    ["这个 bug 谁负责修？", "我"],
    ["Who owns the release notes?", "Docs team"],
    ["图片批量压缩还是逐张压缩？", "批量"],
    ["One button or two?", "One"],
  ])("does not take who fixes a bug, a document's owner or a batch of images for architecture: %s", (question, answer) => {
    expect(of(question, answer)).toEqual([]);
  });

  it.each([
    ["Our SMS vendor — Twilio or Vonage, given the EU traffic?", "Twilio"],
    ["Email provider for receipts: Postmark or Mailgun, whichever is cheaper?", "Postmark"],
    ["鉴权方案：Clerk 还是 Lucia？", "Lucia"],
    ["鉴权要选 Keycloak 还是 Authelia？", "Keycloak"],
    ["We decided to adopt Resend for email delivery.", "Yes"],
    ["Temporal is running, so switch to Restate for workflows.", "OK"],
  ])("takes a vendor named with a provider word or a verb of choosing: %s", (question, answer) => {
    expect(of(question, answer)).toContain("selection");
  });

  it.each([
    ["The payment service currently uses Stripe.", "OK"],
    ["Render the billing page after the invoice arrives.", "OK"],
    ["Our SMS vendor dashboard: Daily or Weekly?", "Daily"],
    ["短信供应商用 Domestic 还是 International？", "Domestic"],
  ])("does not take a vendor in use, a vendor's word as a verb or two plain words: %s", (question, answer) => {
    expect(of(question, answer)).toEqual([]);
  });

  it.each([
    ["状态标签显示 PENDING 还是 QUEUED？", "PENDING"],
    ["The badge on the card: NEW or BETA?", "NEW"],
    ["按钮上写 OK 还是 DONE？", "DONE"],
  ])("does not take two capitalised words on a screen for products: %s", (question, answer) => {
    expect(of(question, answer)).toEqual([]);
  });

  it("still takes a product on a screen's clause", () => {
    expect(of("设置页的存储用 Redis 还是 SQLite？", "SQLite")).toContain("selection");
  });

  it.each([
    ["已经有 Redis 了还要不要加 Kafka？", "加"],
    ["We already run Postgres but should we add Redis for sessions?", "Yes"],
    ["灰度已经完成了，现在要不要全量？", "全量"],
  ])("takes a new question after what is already so in one clause: %s", (question, answer) => {
    expect(of(question, answer)).not.toEqual([]);
  });

  it.each([
    ["灰度已经完成了，结果不错。", "好"],
    ["We already moved to Postgres and it works.", "OK"],
  ])("still does not take what is only already done: %s", (question, answer) => {
    expect(of(question, answer)).toEqual([]);
  });
});

// R7-RV2: precision. The R7 adversarial whitebox (R7-SK RV2), each mechanism in words of our own.
describe("reviewScheduleReasons, seventh version, precision", () => {
  const of = (...texts: string[]) => reviewScheduleReasons({ texts, expectedOutcome: null });

  it.each([
    ["Switch to Render when the preview should be drawn again.", "OK"],
    ["Use Segment C for the second half of the parser input.", "OK"],
    ["Adopt Stripe as the name of the striped table style.", "OK"],
  ])("does not take a vendor's name that is a plain word without what it serves: %s", (question, answer) => {
    expect(of(question, answer)).toEqual([]);
  });

  it.each([
    ["Adopt Render for hosting the preview apps.", "OK"],
    ["改用 Paddle 做收款", "好"],
    ["Switch to Algolia now.", "OK"],
  ])("still takes a vendor with what it serves, or one that is no plain word: %s", (question, answer) => {
    expect(of(question, answer)).toContain("selection");
  });

  it.each([
    ["The fixture keeps the literal `ship it to production users today`.", "OK"],
    ["Already merged, but the banner reads “should we switch to Paddle for payments?”", "OK"],
    ["工单标题写着“下周分批开放给客户”。", "好"],
  ])("does not take quoted text for a decision: %s", (question, answer) => {
    expect(of(question, answer)).toEqual([]);
  });

  it.each([
    ["The CI job uploads a mock build to TestFlight to check signing.", "OK"],
    ["沙盒里提交一个假包到应用商店做校验", "好"],
    ["Archived notes are opened to all users read-only.", "OK"],
    ["Already turned on for everyone, but this is just the status page summary.", "OK"],
    ["Enable the sync engine for all customers now, or wait a week?", "Wait"],
    ["We use Stripe for payments and it works.", "OK"],
    ["持有者字段用什么名字？", "holder"],
    ["供应商 Twilio 或 Vonage 的发票都到了", "好"],
  ])("does not take a test upload, a description, a vendor in use or a bare 'but': %s", (question, answer) => {
    expect(of(question, answer)).toEqual([]);
  });
});

describe("reviewScheduleReasons, seventh version, C6 mechanisms", () => {
  const of = (...texts: string[]) => reviewScheduleReasons({ texts, expectedOutcome: null });

  it.each([
    ["We should use Temporal or Restate for this job.", "Temporal", "selection"],
    ["旧笔记边读边转还是一次性批量转换？", "边读边转", "architecture"],
    ["会话数据由 core 模块还是 bridge 模块持有？", "core", "architecture"],
    ["Should the search service own the index data?", "Yes", "architecture"],
    ["新功能开放给所有客户还是部分客户？", "部分客户", "release"],
  ])("takes %s", (question, answer, reason) => {
    expect(of(question, answer)).toContain(reason);
  });

  it.each([
    ["导出所有客户还是部分客户的数据？", "部分"],
    ["图片边读边压缩还是先压缩？", "先压缩"],
  ])("does not take %s", (question, answer) => {
    expect(of(question, answer)).toEqual([]);
  });
});

// R7-RV3: narrowing only (R7-SK RV3), each mechanism in words of our own.
describe("reviewScheduleReasons, seventh version, narrowed", () => {
  const of = (...texts: string[]) => reviewScheduleReasons({ texts, expectedOutcome: null });

  it.each([
    ["The billing service owns the invoice records and replays them on boot.", "OK"],
    ["Open to all users or a pilot group depending on the plan.", "OK"],
    ["目前开放给所有用户还是部分用户由套餐自动决定。", "好"],
    ["基准报告对比边读边转还是一次性批量转换。", "好"],
    ["The access report says the feature is enabled for all users in Europe.", "OK"],
  ])("does not take ownership, an opening or a conversion said in a description, a condition or a report: %s", (question, answer) => {
    expect(of(question, answer)).toEqual([]);
  });

  it.each([
    ["Use Render to draw this analytics chart again.", "OK"],
    ["Switch to Resend when the user should get the email again.", "OK"],
  ])("does not take a plain-word vendor whose service word is not what it serves: %s", (question, answer) => {
    expect(of(question, answer)).toEqual([]);
  });

  it.each([
    ["We decided: “Switch to Render for hosting the API.”", "OK", "selection"],
    ["Approved: \"We will ship it to production users next week.\"", "OK", "release"],
  ])("still takes what was decided in quotes: %s", (question, answer, reason) => {
    expect(of(question, answer)).toContain(reason);
  });

  it("still strips a quoted status value", () => {
    expect(of("The status value reads “enable this for all users next week”.", "OK")).toEqual([]);
  });
});
