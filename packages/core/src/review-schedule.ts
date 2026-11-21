/**
 * Which new decisions get a review date of their own (IMP-123). A choice whose expected outcome was written
 * down, or one of a library, a framework or a vendor, of the system's shape, or of when and how to release, is
 * reviewed two weeks on; any other is left for the user to schedule. Deterministic, never a model: a review
 * nobody wanted is noise in the inbox, so a call it cannot tell is left unscheduled.
 */
export type ReviewScheduleReason =
  | "expected_outcome"
  | "selection"
  | "architecture"
  | "release";

export const REVIEW_SCHEDULE_DAYS = 14;

export const REVIEW_SCHEDULE_REASON_LABELS: Record<ReviewScheduleReason, string> = {
  expected_outcome: "写了预期结果",
  selection: "选型类决策",
  architecture: "架构类决策",
  release: "发布类决策",
};

// Each clause is judged on its own (RV2): a small call or a "not" in one clause says nothing of the clause beside
// it, as "采用 Kafka；另外把缩进改成两格" is still a choice of Kafka.
const CLAUSE_BREAK = /[。；;！？!?\n]|[，,](?!\d)|\.(?=\s|$)/u;

// What is decided is matched, not only a category's own name (RV3): users choose a primary key, where a piece of
// logic lives or when to ship far more often than they say "数据模型" or "发布时机".

// A category's word naming a thing about it, not the thing: "部署脚本", "发布说明", "rollback flag".
const ARTIFACT = [
  /(?:部署|发布|回滚|迁移|上线|发版|架构|协议)(?:脚本|文档|说明|按钮|开关|配置|工具|页面|助手|日志|图)/gu,
  /\b(?:rollback|deploy\w*|release|migration|schema|protocol|architecture)\s+(?:flags?|helpers?|scripts?|notes|docs?|buttons?|keys?|config|parser|tools?|pages?|files?|diagrams?)\b/giu,
];

// Text, pictures and documents rather than the system: a clause about one is never scheduled.
const PRESENTATION = [
  /架构图|示意图|流程图|指南|教程|手册|变更日志|更新日志|提到|提及|图例|图上|图里|评审文档|文档|说明|排版|配色|颜色|[红橙黄绿蓝紫灰黑白]色|虚线|实线|截图|文案|措辞|用词|拼写|错别字|评论/u,
  /\b(?:diagrams?|slides?|guides?|tutorials?|handbooks?|runbooks?|changelogs?|mention(?:s|ed)?|docs?|documents?|documentation|legend|colou?r\w*|screenshots?|wording|phrasing|spelling|typos?|pages?|wiki|readme)\b/iu,
];

// Said not to be decided, or not yet: "不部署到生产", "尚未选择", "还没定", "not chosen", "no vendor is selected".
// A question ("要不要", "是不是", "用不用") is not a "not"; neither is "未来".
const NEGATED = [
  /(?<![要是能会可该用行])不(?![要是]不|停机(?:迁移|切换))|没有?|(?<!\S)未(?!来)|尚未|暂不|还没|待定|未定/u,
  /n't\b|\b(?:not|no|never|without|deferred|undecided|tbd)\b/iu,
];

// Already done, so nothing to decide now: "We already migrated … last quarter", "the rollout is complete", "灰度已经完成".
// A decision made already is still one ("already decided", "已经决定").
const DONE = [
  /已经(?!决定|定|选|同意|确定)|已(?:完成|结束)|上个?(?:季度|月)|去年/u,
  /\balready\b(?!\s+(?:decided|agreed|chose|chosen|picked|settled))|\blast (?:quarter|month|year|sprint)\b|\b(?:is|was|are|were|(?:has|have) been) (?:complete|completed|done|finished)\b/iu,
];
// What is so, then a new question in the same clause (R7): "已经有 Redis 了还要不要加 Kafka". What follows the turn is judged.
// A "but" alone is no question ("Already enabled for everyone, but this is only the status report", R7-RV2).
const TURN = /现在|接下来|还要不要|要不要|还要|是否|该不该|\b(?:now|should|whether|shall)\b/iu;

// Things one chooses between, named.
const PRODUCTS =
  /\b(?:postgres(?:ql)?|mysql|mariadb|sqlite|turso|mongo(?:db)?|redis|memcached|etcd|zookeeper|kafka|pulsar|nats|rabbitmq|sqs|grpc|graphql|protobuf|fastify|express|nestjs|django|flask|rails|spring|react|vue|svelte|angular|next\.?js|vite|webpack|pnpm|yarn|pino|winston|vitest|jest|aws|gcp|azure|cloudflare|vercel|s3|elasticsearch|opensearch|clickhouse|dynamodb|supabase|firebase|coredns)\b|飞书|钉钉|企业微信|阿里云|腾讯云|华为云/iu;
// Words that only look like names when set against each other: values, levels, verbs, formats, standards, styles.
const NOT_PRODUCT =
  /^(?:id|uuid|true|false|null|none|nil|yes|no|ok|cancel|get|post|put|patch|delete|warn|warning|info|debug|error|trace|json|yaml|toml|csv|xml|todo|api|ui|url|left|right|on|off|basic|advanced|standard|premium|primary|secondary|default|custom|simple|full|lite|pro|draft|final|high|medium|low|critical|major|minor|domestic|international|global|regional|local|public|private|internal|external|online|offline|daily|weekly|monthly|yearly|annual|quarterly|iso|rfc|utc|utf-?8|ascii|readme|camelcase|pascalcase|snake_case|kebab-case|screaming_case)$/iu;
// A product named, or a name with a technical shape: capitals beyond the first (MySQL, CoreDNS, gRPC, TCC) or a
// digit, dot or dash among its letters (k8s, S3-compatible, next.js). A capital first letter alone is any word in
// English ("Draft 还是 Final", "Plan A or Plan B"), one capital inside is an identifier (createdAt), and a date
// pattern is a format (RV4).
const productLike = (word: string): boolean =>
  PRODUCTS.test(word) ||
  (!NOT_PRODUCT.test(word) &&
    !/^[YMDHhms]+(?:[-/:.][YMDHhms]+)*$/u.test(word) &&
    (/^[A-Z][\w.+#-]*[A-Z]|[A-Z]{2}/u.test(word) || /[a-z][\d.-]|[\d.-][a-z]/iu.test(word)));
// Vendors and services named as their makers write them (RV2), many of them plain words ("Stripe", "Temporal",
// "Render"), so only this spelling counts, and only in a service's slot.
const VENDOR_NAMES = [
  "Stripe", "Paddle", "Adyen", "Braintree", "Checkout.com", "Lemon Squeezy", "Twilio", "Vonage", "Sinch", "Plivo",
  "MessageBird", "Postmark", "Resend", "Mailgun", "SendGrid", "Mailchimp", "Keycloak", "Authentik", "Authelia", "Okta",
  "Clerk", "Lucia", "Zitadel", "Cognito", "Firebase Auth", "Datadog", "New Relic", "Grafana", "Prometheus", "Kibana",
  "Sentry", "Bugsnag", "Rollbar", "Honeycomb", "PagerDuty", "Opsgenie", "Amplitude", "Mixpanel", "Segment", "Pinecone",
  "Weaviate", "Qdrant", "Milvus", "Chroma", "Heroku", "Netlify", "Render", "Railway", "Fastly", "Akamai", "Kong",
  "Envoy", "Traefik", "Nginx", "Caddy", "Temporal", "Restate", "Redpanda", "OpenAI", "Anthropic", "Claude", "Gemini",
  "Mapbox", "Algolia", "Meilisearch", "Typesense", "Intercom", "Zendesk", "DeepL", "LaunchDarkly", "Statsig", "PostHog",
  "Cloudinary", "Upstash", "Ably", "Pusher", "Stytch", "Descope", "Razorpay", "Mollie", "Klarna", "Chargebee", "Recurly",
];
const VENDORS = new Set(VENDOR_NAMES);
// A name of several words is matched whole ("New Relic"), before any one word.
const NAME = String.raw`(${VENDOR_NAMES.filter((name) => name.includes(" ")).join("|")}|[A-Za-z][\w.+#-]*)`;
// "Redis 还是 Memcached", "继续 webpack", "Redis or ZooKeeper": one side at least must look like a product.
// On a screen a word in capitals is a label ("状态标签显示 PENDING 还是 QUEUED"), as it is in a service's slot (R7).
const productPair = (clause: string, onScreen: boolean): boolean =>
  [...clause.matchAll(/([A-Za-z][\w.+#-]*)\s*(?:还是|\bor\b|\bvs\.?|\bversus\b)\s*(?:用|继续用?|保持|留在|换成|stay on |keep )?\s*([A-Za-z][\w.+#-]*)/giu)]
    .some((match) => [match[1]!, match[2]!].some((word) =>
      productLike(word) && !(onScreen && /^[A-Z][A-Z\d_]*$/u.test(word) && !PRODUCTS.test(word))));

// Two names chosen for a service's slot (R6): "支付接 Stripe 还是 Paddle", "Stripe 还是 Paddle 做收款", "Auth: Clerk or
// Lucia". The pair must be the whole of what fills the slot ("监控图表用 Daily 还是 Weekly 粒度" is not), and a plain
// word fills a slot too ("Billing service: Monthly or Yearly", "For payments: Success or Failure"), so one side at
// least must be a vendor or look like a product (RV2).
const SERVICE_CN = "支付|收款|短信|发信|邮件服务|推送|鉴权|认证|授权|单点登录|登录方案|身份认证|监控|告警|可观测|链路追踪|错误追踪|埋点|托管|网关|大模型|模型服务|向量库";
const SERVICE_EN = String.raw`payments?|billing|checkout|sms|e-?mail|push notifications?|auth\w*|identity|sso|idp|monitoring|observability|alerting|tracing|error tracking|crash reporting|policy evaluation|analytics|telemetry|hosting|cdn|gateway|llm|vector (?:db|store|database)`;
const SLOT_CN = "(?:服务|通道|渠道|方案|平台|供应商|服务商|提供商|厂商|系统)?";
const SLOT_EN = String.raw`(?:\s+(?:providers?|services?|vendors?|platforms?|backends?|layers?))?`;
const PAIR_END = String.raw`(?=\s*(?:$|[？?。.!！,，；;:：]|比较|好|呢|吧|更|合适))`;
const EN_CHOOSE = String.raw`(?:use|choose|pick|adopt|go with|standardi[sz]e on)`;
const SERVICE_PAIR = [
  new RegExp(String.raw`(?:${SERVICE_CN})${SLOT_CN}\s*(?:要|该|应该|打算|准备|就)?(?:用|接|选|走|接入|采用|换成|[:：])\s*${NAME}\s*(?:还是|或者?)\s*(?:用|接)?\s*${NAME}${PAIR_END}`, "gu"),
  new RegExp(String.raw`${NAME}\s*还是\s*${NAME}\s*(?:来做|做|当|作为)\s*(?:${SERVICE_CN})${SLOT_CN}${PAIR_END}`, "gu"),
  new RegExp(String.raw`(?:^|\bfor (?:the )?)(?:${SERVICE_EN})${SLOT_EN}\s*[:,]\s*${NAME}\s+(?:or|vs\.?|versus)\s+${NAME}${PAIR_END}`, "giu"),
  // "Choose Sentry or Bugsnag for crash reporting."
  new RegExp(String.raw`${EN_CHOOSE}\s+${NAME}\s+(?:or|vs\.?|versus)\s+${NAME}\s+for (?:the )?(?:new )?(?:${SERVICE_EN})${SLOT_EN}${PAIR_END}`, "giu"),
];
const plainName = (word: string): boolean => productLike(word) || (/^[A-Z]/u.test(word) && !NOT_PRODUCT.test(word));
const named = (word: string): boolean => VENDORS.has(word) || productLike(word);
const namedPair = ([, a, b]: RegExpMatchArray): boolean => plainName(a!) && plainName(b!) && (named(a!) || named(b!));
const servicePair = (clause: string): boolean =>
  SERVICE_PAIR.some((pattern) => [...clause.trim().matchAll(pattern)].some(namedPair));
// Two names beside a word for what is chosen ("Our SMS vendor — Twilio or Vonage", R7), and two values of a thing
// chosen already ("短信供应商用 Domestic 还是 International" picks a setting of the vendor, not one).
const PAIR = new RegExp(String.raw`${NAME}\s*(?:还是|或者?|\bor\b|\bvs\.?|\bversus\b)\s*${NAME}`, "giu");
// The pair is what is asked, ending the clause ("供应商 Twilio 或 Vonage 的发票都到了" is not, R7-RV3).
const ASKED_PAIR = new RegExp(PAIR.source + PAIR_END, "giu");
const subjectPair = (clause: string): boolean => [...clause.trim().matchAll(ASKED_PAIR)].some(namedPair);
const valuePair = (clause: string): boolean =>
  [...clause.matchAll(PAIR)].some(([, a, b]) => NOT_PRODUCT.test(a!) && NOT_PRODUCT.test(b!));
// A vendor taken, as its maker writes it (R7): "adopt Resend", "migrate the workflow to Restate", "改用 Paddle". Not
// one in use ("uses Stripe") or a vendor's word as a verb ("Render the page").
const VENDOR_TAKEN = [
  // Said as a choice, not of what is in use ("We use Stripe for payments", "picked Stripe back in 2023", R7-RV3).
  new RegExp(String.raw`(?:^\s*|\b(?:should|to|will|'ll|let's|let’s|let us|must|shall|but|so|then|now)\s+)(?:use|choose|pick|adopt|switch to|go with|(?:move|migrate) (?:[\w-]+ ){0,3}to|replace (?:[\w-]+ ){0,3}with)\s+${NAME}`, "giu"),
  new RegExp(String.raw`(?:采用|改用|换成|换用|切换到|迁到|迁移到|选|接入|引入)\s*${NAME}`, "gu"),
];
// Names that are plain English words are a vendor only with what they serve right after them ("Switch to Resend for
// email delivery", "改用 Paddle 做收款"; not "Switch to Resend when the editor should send the email again", R7-RV3) or
// set against another vendor ("use Temporal or Restate"); a letter after one is a label ("Segment B", R7-RV2).
const PLAIN_WORD_VENDORS = new Set(["Stripe", "Paddle", "Segment", "Render", "Resend", "Temporal", "Restate", "Railway",
  "Chroma", "Envoy", "Kong", "Caddy", "Clerk", "Sentry", "Claude", "Gemini", "Postmark", "Pusher", "Intercom", "Fastly",
  "Honeycomb", "Prometheus"]);
const SERVES = new RegExp(String.raw`^\s+for (?:the )?(?:[\w-]+ ){0,2}(?:${SERVICE_EN}|workflows?|orchestration|mail|queues?|message broker)\b|^\s*(?:来做|做|作为|当)\s*(?:${SERVICE_CN})`, "iu");
const vendorTaken = (clause: string): boolean =>
  VENDOR_TAKEN.some((pattern) => [...clause.matchAll(pattern)].some((match) =>
    VENDORS.has(match[1]!) &&
    !/^\s+[A-Z\d]\b/u.test(clause.slice(match.index! + match[0].length)) &&
    (!PLAIN_WORD_VENDORS.has(match[1]!) || SERVES.test(clause.slice(match.index! + match[0].length)) ||
      VENDORS.has(clause.slice(match.index! + match[0].length).match(new RegExp(String.raw`^\s*(?:or|还是)\s*${NAME}`, "u"))?.[1] ?? ""))));

const SELECTION = [
  /选型|技术栈|技术方案/u,
  /\btech(?:nology)? stack\b/iu,
];
const SELECTION_CHOICE = [
  // "选项" names the options; it does not pick one.
  /选(?!项)|采用|改用|换成|换用|使用|引入|切换到|迁到|还是|哪个|用\s*(?=[A-Za-z])|(?:要不要|是否|该不该|需不需要)\S{0,2}(?:加|上|接)/u,
  /\bshould we (?:add|bring in|introduce)\b|\b(?:which|choose|chose|chosen|pick(?:ed)?|use[sd]?|using|adopt\w*|switch\w* to|go with|went with|migrat\w* to|instead of|rather than|replac\w*|will (?:be|handle|power|serve|back))\b/iu,
];
const SELECTION_SUBJECT = [
  PRODUCTS,
  /数据库|主库|框架|中间件|服务商|供应商|厂商|云服务|(?<![A-Za-z])(?:SDK|ORM)(?![A-Za-z])|消息队列|缓存|搜索引擎|对象存储|包管理器|构建工具|打包工具|日志库|测试框架|分布式锁|第三方(?:库|服务)|依赖库|开源库|组件库|哪个库|什么库/iu,
  /\b(?:librar(?:y|ies)|frameworks?|databases?|vendors?|providers?|sdks?|orms?|message (?:queue|broker)s?|messaging|caches?|caching layer|search engines?|hosting|cdn|dns|object storage|primary store|package manager|bundler|dependency|dependencies|third[- ]party (?:services?|librar(?:y|ies)))\b/iu,
];

const API_STYLES = String.raw`(?:REST|HTTP|gRPC|GraphQL|SOAP|WebSocket|RPC)`;
const ARCHITECTURE = [
  // The category named.
  /架构|模块边界|模块划分|系统拆分|(?:服务|模块|系统)拆分|微服务|单体|分层|数据模型|领域模型|表结构|存储结构|存储格式|存储方案|存储方式|接口(?:设计|契约|协议|格式|定义)|通信协议|协议(?:设计|格式|版本)|用什么协议|分库|分表|分片|主表|事件表/iu,
  /\b(?:architecture|architectural|module boundar(?:y|ies)|data model|domain model|api (?:design|contract)|interface contract|storage (?:layout|structure|format)|shard(?:s|ed|ing)?|partition(?:ed|ing) (?:by|on)|microservices?|monolith|monorepo|polyrepo|multi-repo|(?:data|database|schema|storage) migration|event[- ]sourc\w*|cqrs|crud)\b/iu,
  // A data model: keys, relations, where a record or a field is stored.
  /主键|外键|自增\s*ID|一对多|多对多|一对一|中间表|关联表|单独(?:的)?表|JSON\s*列|宽表|冗余字段|分区键|落库|(?:存成|存到|落到)\S{0,8}(?:表|列|库|数据库|文件)/iu,
  // Module and service boundaries.
  /哪一层|哪个模块|哪一端|归(?:谁|哪)|(?:包|模块|服务|进程)\S{0,8}(?:合并|拆)|合并成一个|拆出去|单独(?:发包|部署|进程|服务)|单独起\S{0,3}(?:进程|服务|worker)|依赖方向/iu,
  /拆(?:成|为|到|出|分)?.{0,12}(?:表|模块|服务|worker|进程|系统)/iu,
  /\bsplit\b.{0,30}\b(?:services?|modules?|workers?|tables?|process(?:es)?)\b|\binto (?:the )?(?:a |an )?(?:dedicated|separate|standalone|new) (?:\w+ )?(?:worker|service|process|table)s?\b/iu,
  // How many services or processes, set against another count (R6): "one service or two", "单服务还是双服务".
  /(?:一个|单个|单一?|两个|二个|三个|多个|双|多)\s*(?:(?!还是)\S){0,6}?\s*(?:服务|进程|包|仓库|应用)\S{0,6}还是\S{0,4}(?:一个|单个|单|两个|二个|三个|多个|双|多|拆)/u,
  /\b(?:one|a single|single|two|three|multiple|separate)\s+(?:[\w-]+\s+){0,2}(?:services?|process(?:es)?|packages?|repos?|repositories|apps?|daemons?|binar(?:y|ies)|deployables?)\b.{0,30}\b(?:or|vs\.?|versus)\s+(?:\w+\s+)?(?:one|a single|single|two|three|multiple|separate|split)\b/iu,
  // Interfaces and protocols.
  /(?:之间|通信)\S{0,10}协议|协议\s*(?:用|选|改)|(?:接口|协议|API).{0,16}(?:迁|改|换)(?:到|成|为|至)/iu,
  /\b(?:payload|api|events?|messages?|schemas?|protocol)\b.{0,30}\bversion(?:ed|ing|s)?\b|\bversion(?:ed|ing)?\b.{0,20}\b(?:payloads?|api|events?|schemas?|protocol)\b|\b(?:which|what|use|choose|switch\w*|wire|transport)\b.{0,20}\bprotocol\b|\bprotocol (?:between|for)\b/iu,
  new RegExp(String.raw`\bfrom ${API_STYLES} to ${API_STYLES}\b|${API_STYLES}\s*(?:迁|改|换)(?:到|成|为)\s*${API_STYLES}|从\s*${API_STYLES}\s*(?:迁|改|换)(?:到|成|为)\s*${API_STYLES}`, "iu"),
  /schema\s*(?:设计|变更|迁移|演进|版本)|(?:改|设计|迁移|拆)\S{0,6}schema|\bschema (?:change|design|migration|version)\w*|\b(?:change|design|migrat|version)\w* (?:the )?schemas?\b/iu,
  // Storage layout and how writes are kept straight.
  /按天分文件|分文件还是|还是一个库|单独文件|期间的写入|并发写|写入冲突/u,
  // Migrating stored data, not moving offices; and how it is carried out (R6).
  /双写|停机(?:迁移|切换|方案)|在线迁移|灰度迁移|影子写|迁移\S{0,6}停机/u,
  /\bdual[- ]?writ\w*|\bshadow writ\w*|\bzero[- ]downtime\b|\bdowntime\b.{0,30}\b(?:migrat\w*|cutover)\b|\b(?:migrat\w*|cutover)\b.{0,30}\bdowntime\b|\b(?:gradual|phased|incremental|big[- ]bang) (?:cutover|migration)\b|\bblue[- ]green\b|\bexpand[- ]and[- ]contract\b/iu,
  /(?:格式|数据|表|库|笔记|记录|配置|spool|schema|索引)\S{0,8}迁移|迁移\S{0,6}(?:格式|数据|表|库|笔记|记录)|(?:数据库|存储|系统|服务)\S{0,4}迁移|迁移?(?:到|至).{0,10}(?:表|库|服务)|迁移(?:方案|计划)/iu,
  /\bmigrat\w*\b.{0,40}\b(?:notes?|records?|data|database|storage|schemas?|format|layout|tables?|spool|files?|users?)\b/iu,
  // How parts talk and keep state.
  /同步(?:调用)?还是异步|异步还是同步|异步消息|消息异步|事件驱动|状态管理|全局\s*store/iu,
  /\b(?:sync(?:hronous)?|async(?:hronous)?) or (?:sync(?:hronous)?|async(?:hronous)?)\b/iu,
  new RegExp(String.raw`(?:${API_STYLES})\s*(?:还是|\bor\b|\bvs\.?)\s*(?:${API_STYLES})`, "iu"),
];

// R7 rules, said only of a decision, not in a description, a condition or a report (R7-RV3): "The core service owns the
// event schema", "depending on the subscription tier", "由许可证自动决定", "基准报告比较…".
const DESCRIBING = /由\S{0,16}决定|报告|基准|当前|目前|\b(?:depending on|depends on|reports?|benchmarks?|at runtime|currently)\b/iu;
// The narrowest of them (R7-RV2, from C6) need a decision said in the clause too.
const DECIDING = /还是|要不要|是否|决定|选|\b(?:or|which|who|should|whether)\b/iu;
const ARCHITECTURE_R7 = [
  // Who holds a piece of data or a contract (R7): "会话数据由谁持有", "Who owns the event contract". Not who fixes a bug.
  /(?:由|归)?\s*(?:谁|哪个\S{0,4}|哪一?[个方端层侧]\S{0,4})\s*来?(?:持有|拥有)/iu,
  // Old data converted bit by bit or all at once (R7): "Convert the old notes lazily on read or in one batch". Not images.
  /^(?=.*\b(?:convert|migrat|rewrit|upgrad|backfill|transform)\w*\b)(?=.*\b(?:lazy|lazily|on read|on demand|gradual\w*|incremental\w*)\b)(?=.*\b(?:bulk|in (?:one|a single) (?:batch|go|pass)|all at once|big[- ]bang|up ?front)\b)/iu,
];
const ARCHITECTURE_DECIDING = [
  /(?=.*还是)(?:由|归).{0,24}(?:持有|拥有)/u,
  /\b(?:services?|modules?|packages?|layers?|components?)\s+(?:should\s+)?owns?\b.{0,30}\b(?:contracts?|schemas?|events?|data|state|apis?|tables?|topics?|queues?|records?|sessions?|models?)\b|\bwhich (?:service|module|package|side|process|component)\b.{0,20}\bowns?\b.{0,30}\b(?:contracts?|schemas?|events?|data|state|apis?|tables?|topics?|queues?|records?|sessions?|models?)\b|\bownership\b.{0,30}\b(?:contracts?|schemas?|events?|data|state|apis?|tables?|topics?|queues?|records?|sessions?|models?)\b|\b(?:contracts?|schemas?|events?|data|state|apis?|tables?|topics?|queues?|records?|sessions?|models?)\b.{0,20}\b(?:owner(?:ship)?|owned by)\b/iu,
  // "旧文件用渐进转换还是批量转换", "边读边转还是一次性批量转换".
  /(?:(?:渐进|逐步|增量|分批|懒|按需)\S{0,6}?(?:转换|迁移|搬|升级|转写)|边读边[转迁改]|读时(?:转换|迁移)).{0,12}还是.{0,8}(?:批量|一次性|全量|集中)|(?:批量|一次性|全量)\S{0,6}?(?:转换|迁移|搬|升级|转写).{0,12}还是.{0,8}(?:渐进|逐步|增量|分批|按需|边读边|读时)/u,
];
const RELEASE_R7 = [
  // Putting a build in users' hands (R7): in batches, into a store, to production users, delivery before download.
  /(?:分批|逐步|分阶段|分区域|按批)\S{0,6}(?:开放|放开|推送|上架|交付)|(?:什么时候|何时|哪天|先|再|一次)\S{0,10}(?:开放|放开)|开放下载|(?:提交|上架|发)\S{0,3}(?:应用)?(?:商店|市场)|(?:进|上)(?:应用)?商店|(?:交付|开放|上架)\S{0,12}(?:先后|顺序)/u,
  // Opened to users only as a decision or of a feature or version ("Should we enable the feature for all users", not
  // "records are opened to all users", R7-RV2).
  /^(?=.*\b(?:should|shall|when|whether|do we)\b).*\b(?:turn(?:ing)? on|switch(?:ing)? on|enabl\w*|flip\w*|expos\w*|open\w*(?: up)?|mak\w* (?:it )?available)\b.{0,40}\b(?:for|to) (?:all |every |our |the )?(?:production|prod|live|paying|enterprise)\s(?:users|customers|tenants|accounts)\b/iu,
  /\b(?:submit\w*|push\w*|ship\w*|upload\w*|publish\w*|get\w*)\b.{0,30}\b(?:app store|play store|microsoft store|testflight)\b|\b(?:open|release|ship|enable|expose|deliver)\w*\b.{0,40}\bin (?:batches|waves|stages|phases)\b|\bdeliver\w*\b.{0,40}\b(?:before|after)\b.{0,30}\b(?:download|release|launch|availability)\b|\b(?:public|general) (?:download|availability)\b/iu,
];
const RELEASE_DECIDING = [
  // How far it is opened: all customers or some (R7-RV2), said with opening it.
  /^(?=.*(?:开放|放开|上线|推送|打开|可见)).*(?:(?:所有|全部|全体)(?:客户|用户).{0,12}还是.{0,12}(?:部分|一部分|少数|指定|白名单)|(?:部分|一部分|少数|指定|白名单)(?:客户|用户).{0,12}还是.{0,12}(?:所有|全部|全体))/u,
  /^(?=.*\b(?:open\w*|enabl\w*|roll\w* out|turn\w* on|expos\w*)\b).*\ball (?:customers|users|tenants)\b.{0,20}\bor\b.{0,20}\b(?:some|a subset|selected|a few|a cohort|beta)\b/iu,
];
const r7 = (patterns: RegExp[], deciding: RegExp[], clause: string): boolean =>
  !DESCRIBING.test(clause) && (any(patterns, clause) || (DECIDING.test(clause) && any(deciding, clause)));

// Where a piece of logic, a field or some state is kept: architecture, unless the decision is about where it sits on
// screen ("字段放在设置页还是详情页", "the status lives in the header or the sidebar").
const PLACEMENT = [
  /(?:逻辑|字段|数据|状态|索引|配置|缓存|记录)\S{0,8}(?:放|存)(?:在|到)?[^，,。；;？?]{0,20}还是/u,
  /\bwhere should\b.{0,40}\blive\b|\b(?:state|session|data|records?|cache|logic)\b.{0,20}\blive (?:in|on)\b/iu,
];
const ON_SCREEN =
  /页面|设置页|详情页|\S页(?![码数])|按钮|标签|左边|右边|左侧|右侧|上方|下方|弹窗|菜单|卡片|布局|侧边栏|表单|输入框|界面|\b(?:ui|tabs?|pages?|buttons?|labels?|modals?|dialogs?|menus?|cards?|layout|sidebar|header|footer|toolbar|above|beside|below|left|right)\b/iu;

const RELEASE = [
  /发版|上线|灰度|回滚|发布(?:版本|时机|时间|节奏|流程|计划|窗口|先后|顺序|到(?:生产|线上|正式|商店))|(?:正式|版本|灰度|线上|新版本?|分批|生产)发布|发布\s*v?\d|先发.{0,12}(?:再|后)发/u,
  // When and how far: "周五发还是下周发", "推迟发布", "放量", "版本号", "热修".
  /(?:今天|明天|今晚|现在|马上|下周[一二三四五六日]?|周[一二三四五六日]|月底|本周|下个版本)\S{0,3}发(?![现生送信言给周日邮])|发还是|再发(?![一送消邮])|(?:现在|推迟|延期|提前|暂缓|延后)\S{0,4}发布|发布\S{0,4}(?:推迟|延期|延后)|要不要(?:现在)?发布|版本号|全量|放量|正式版|热修|先发\s*(?:beta|rc|测试版|预览版)|直接(?:发)?正式/iu,
  /\b(?:release (?:it|this|now|today|tomorrow|date|timing|window|plan|branch|candidate|train|order|v?\d[\w.]*)|releas(?:e|ing) (?:the )?(?:new )?(?:version|build)|ship\w* (?:it|this|now|today|the)\b|ship\w* .{0,40}\bto (?:production|prod|users|customers)|roll(?:ing)? ?(?:out|back)|rollout|rollback|canary|go(?:ing)?[- ]live)\b/iu,
  /\brelease\b.{0,20}\b(?:next|this|today|tonight|tomorrow|now|week|sprint|on (?:mon|tues|wednes|thurs|fri|satur|sun)day)\b|\blaunch(?:es|ed|ing)?\b|\bhotfix\w*\b|\b(?:ship|push|promote|deploy|release|roll)\w*\b.{0,40}\bto (?:prod|production)\b|\bcut (?:a |the )?release\b|\bfeature flags?\b.{0,30}(?:默认|\bdefault|\bon\b|\boff\b|开|关)|feature flag/iu,
];
// A release word for an event or a post about it ("发布会", "launch party").
const EVENT = [
  /发布会|分享会|会议|例会|活动|公告|博客|直播|讲座|演讲/u,
  /\b(?:meetings?|events?|webinars?|conferences?|announcements?|blog|posts?|talks?|keynotes?|party)\b/iu,
];
// Naming something ("hotfix 分支怎么命名", "named retryWorks or retrySucceeds"): two names are not two products, and a
// release word in a name is not a release. A name server is not a name.
const NAMING =
  /命名|改名|取名|起名|叫\s*\S+\s*还是|名字|变量名|函数名|字段名|列名|分支名|\b(?:renam\w*|nam(?:e|es|ed|ing))\b(?! servers?)/iu;
// A deploy is a release only when it goes where people use it: to staging, QA or a machine of one's own it is not.
const DEPLOY = /部署|\bdeploy(?:s|ed|ing|ments?)?\b/iu;
// A transaction's rollback, said anywhere in the decision (the question, while the answer is just "回滚"): no release.
const TRANSACTION = /事务|\btransactions?\b/iu;
const ROLLBACK = /回滚|\broll(?:ing)? ?back\b|\brollback\b/giu;
// A build sent to a store or a sandbox to test the pipe, not to users (R7-RV2).
const TEST_RUN = /夹具|沙盒|沙箱|假包|校验|\b(?:fixtures?|sandbox|dummy|mock\w*|checksums?|ci|nightly|integration tests?|validat\w*)\b/iu;
const NOT_PRODUCTION =
  /本地|测试环境|测试同学|预发|内部|\b(?:qa|staging|local\w*|preview|internal|dev|sandbox|test(?:ing)? env\w*)\b/iu;

const any = (patterns: RegExp[], text: string): boolean =>
  patterns.some((pattern) => pattern.test(text));

interface Context { transactional: boolean; onScreen: boolean; naming: boolean }

const clauseReasons = (raw: string, { transactional, onScreen, naming }: Context): ReviewScheduleReason[] => {
  // Naming, comments, formatting, how a test is written or a bug fixed: no category, so nothing to schedule. They
  // used to veto the clause outright, and with it "注释要不要进索引（存储结构要变）" (RV3).
  if (any(PRESENTATION, raw) || any(NEGATED, raw)) return [];
  const done = DONE.map((pattern) => raw.match(pattern)).find((match) => match);
  if (done) {
    const after = raw.slice(done.index! + done[0].length);
    const turn = after.match(TURN);
    return turn ? clauseReasons(after.slice(turn.index!), { transactional, onScreen, naming }) : [];
  }
  const clause = ARTIFACT.reduce((text, pattern) => text.replace(pattern, " "), raw);
  const reasons: ReviewScheduleReason[] = [];
  if (
    any(SELECTION, clause) ||
    (!naming && productPair(clause, ON_SCREEN.test(raw))) ||
    (!NAMING.test(raw) && !ON_SCREEN.test(raw) && (servicePair(clause) || vendorTaken(clause))) ||
    (any(SELECTION_SUBJECT, clause) && !valuePair(clause) && (any(SELECTION_CHOICE, clause) || subjectPair(clause)))
  ) {
    reasons.push("selection");
  }
  if (any(ARCHITECTURE, clause) || r7(ARCHITECTURE_R7, ARCHITECTURE_DECIDING, clause) || (!onScreen && any(PLACEMENT, clause))) {
    reasons.push("architecture");
  }
  const releaseText = transactional ? clause.replace(ROLLBACK, "") : clause;
  if (
    !naming && !any(EVENT, clause) &&
    (any(RELEASE, releaseText) || (!TEST_RUN.test(clause) && r7(RELEASE_R7, RELEASE_DECIDING, releaseText)) || (DEPLOY.test(clause) && !NOT_PRODUCTION.test(clause)))
  ) {
    reasons.push("release");
  }
  return reasons;
};

// What is quoted as a piece of text is not the decision: a status value, a literal, a ticket's title (R7-RV2). What was
// decided, agreed or approved in quotes still is (R7-RV3).
const TEXT_SAID =
  /\b(?:strings?|values?|literals?|titles?|banners?|status|labels?|prints?|reads?|says?|text|asks?|contains?|includes?)\b|文案|字样|状态值|标题|写着|显示|提示/iu;
const AGREED = /\b(?:decided|agreed|approved)\b|决定|同意|批准/iu;
const unquoteText = (text: string): string =>
  text.replace(/“[^”]*”|"[^"]*"|`[^`]*`/gu, (quoted, at: number) => {
    const before = text.slice(Math.max(0, at - 24), at);
    const after = text.slice(at + quoted.length, at + quoted.length + 24);
    return !AGREED.test(before) && TEXT_SAID.test(`${before} ${after}`) ? " " : quoted;
  });

const ORDER: ReviewScheduleReason[] = ["expected_outcome", "selection", "architecture", "release"];

/** `texts`: what was asked and what was chosen. Options not taken are left out: they say what was not decided. */
export const reviewScheduleReasons = (input: {
  texts: string[];
  expectedOutcome: string | null | undefined;
}): ReviewScheduleReason[] => {
  const reasons = new Set<ReviewScheduleReason>();
  if ((input.expectedOutcome ?? "").trim().length > 0) reasons.add("expected_outcome");
  const texts = input.texts.map((text) => unquoteText(text.normalize("NFKC")));
  const transactional = texts.some((text) => TRANSACTION.test(text));
  // Said in the question, it holds for the answer and the clause after a comma too.
  const context: Context = {
    transactional,
    onScreen: texts.some((text) => ON_SCREEN.test(text)),
    naming: texts.some((text) => NAMING.test(text)),
  };
  for (const text of texts) {
    for (const clause of text.split(CLAUSE_BREAK)) {
      for (const reason of clauseReasons(clause, context)) reasons.add(reason);
    }
  }
  return ORDER.filter((reason) => reasons.has(reason));
};

const pad = (value: number): string => String(value).padStart(2, "0");

/** Fourteen calendar days on in the writer's own time zone, or null when the decision is not worth one. */
export const defaultReviewSchedule = (
  texts: string[],
  expectedOutcome: string | null | undefined,
  now: Date,
): { reviewDueDate: string; reasons: ReviewScheduleReason[] } | null => {
  const reasons = reviewScheduleReasons({ texts, expectedOutcome });
  if (reasons.length === 0) return null;
  const due = new Date(now.getFullYear(), now.getMonth(), now.getDate() + REVIEW_SCHEDULE_DAYS);
  return {
    reviewDueDate: `${due.getFullYear()}-${pad(due.getMonth() + 1)}-${pad(due.getDate())}`,
    reasons,
  };
};
