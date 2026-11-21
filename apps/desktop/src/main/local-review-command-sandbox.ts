import { randomUUID } from "node:crypto";
import { copyFile, mkdir, open, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { createConnection, createServer } from "node:net";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { ManagedChildProcessRunner, ManagedProcessError } from "./model/cli/managed-child-process.js";
import type { ReviewCopy } from "./local-review-git.js";
import { reviewNativeModulePath } from "./local-review-filesystem.js";
import { resolveReviewTools, reviewToolEnvironment, reviewToolReadDirectories, reviewToolReadFiles, reviewExtraCAFiles, REVIEW_SYSTEM_CA_FILES, type ReviewTool } from "./local-review-tools.js";
import { createReviewSandboxFingerprint, reviewSandboxFingerprintRules, type ReviewSandboxFingerprint } from "./local-review-sandbox-fingerprint.js";
import { ReviewLaunchdLabels, addedReviewLaunchdLabels, REVIEW_LAUNCHD_WARNING } from "./local-review-launchd.js";
import { ReviewInstallProcesses } from "./local-review-install-processes.js";

const SYSTEM_READ = ["/System", "/usr/lib", "/usr/bin", "/bin", "/Library/Developer/CommandLineTools"];
const KEYCHAIN_SERVICES = ["com.apple.securityd.xpc", "com.apple.SecurityServer", "com.apple.secd"];
const quote = (value: string) => JSON.stringify(value);
export interface ReviewInstallSandbox { root: string; proxy?: string | undefined; fingerprint?: ReviewSandboxFingerprint; controlDirectory?: string; ledgerPath?: string }
export function reviewCommandPolicy(copy: ReviewCopy, tools: readonly ReviewTool[], install?: ReviewInstallSandbox, extraCAFiles: readonly string[] = []): string {
  const directories = [...SYSTEM_READ, copy.tree, join(copy.directory, "scratch"), copy.git, join(copy.directory, "tool-bin"), ...(install ? [install.root, "/etc/ssl", "/private/etc/ssl", "/private/etc/resolv.conf", "/private/var/run/resolv.conf"] : []), ...reviewToolReadDirectories(tools)];
  const files = ["/private/var/select/sh", "/private/etc/hosts", "/etc/hosts", ...reviewToolReadFiles(tools), ...REVIEW_SYSTEM_CA_FILES, ...extraCAFiles];
  const parents = new Set<string>();
  for (const path of [...directories, ...files]) for (let parent = dirname(path);; parent = dirname(parent)) { parents.add(parent); if (dirname(parent) === parent) break; }
  const scopes = [...new Set(directories)].map(path => `(subpath ${quote(path)})`).concat([...new Set(files)].map(path => `(literal ${quote(path)})`));
  return ["(version 1)", "(deny default)", "(allow process-exec)", "(allow process-fork)", "(allow signal (target same-sandbox))", "(allow process-info* (target same-sandbox))",
    // dyld needs the root vnode itself; subpath "/" would expose every file.
    // Matches Codex's minimal Seatbelt runtime rule; confirmed by deny logs.
    '(allow file-read* (literal "/"))',
    `(allow file-read* file-map-executable ${scopes.join(" ")})`, `(allow file-read-metadata ${[...parents].map(path => `(literal ${quote(path)})`).join(" ")})`,
    `(allow file-read* (literal "/dev/null") (literal "/dev/random") (literal "/dev/urandom"))`, `(allow file-write* (literal "/dev/null") (subpath ${quote(copy.tree)}) (subpath ${quote(join(copy.directory, "scratch"))}) ${install ? `(subpath ${quote(install.root)})` : ""})`,
    `(deny file-write* (subpath ${quote(copy.git)}) (literal ${quote(join(copy.tree, ".git"))}))`,
    '(deny file-read* process-exec (literal "/bin/launchctl"))',
    ...(install?.controlDirectory ? [`(deny file-read* file-map-executable (subpath ${quote(install.controlDirectory)}))`] : []),
    ...(install?.ledgerPath ? [`(deny file-read* file-map-executable (literal ${quote(install.ledgerPath)}))`] : []),
    // Keep the lifecycle directory stable for filesystem cleanup. It is not an
    // attribution criterion; only the full secret Mach fingerprint is one.
    ...(install ? [`(deny file-write-unlink file-write-mode file-write-owner file-write-flags (literal ${quote(install.root)}))`] : []),
    // Go uses the numeric HW_PAGESIZE MIB, exposed as hw.pagesize_compat on macOS.
    // The exact name is also listed in Apple's airlock.sb runtime profile.
    `(allow sysctl-read ${["hw.machine", "hw.pagesize", "hw.pagesize_compat", "kern.hostname", "hw.activecpu", "hw.ncpu", "hw.physicalcpu", "hw.logicalcpu", "hw.memsize", "hw.byteorder", "kern.osrelease", "kern.ostype", "kern.version", "kern.argmax"].map(name => `(sysctl-name ${quote(name)})`).join(" ")})`,
    '(allow mach-lookup (global-name "com.apple.system.logger") (global-name "com.apple.system.opendirectoryd.libinfo"))',
    `(deny mach-lookup ${KEYCHAIN_SERVICES.map(name => `(global-name ${quote(name)})`).join(" ")})`, "(deny network*)", ...(install ? ['(allow network-outbound)', '(allow mach-lookup (global-name "com.apple.mDNSResponder"))'] : []), ...(install?.fingerprint ? reviewSandboxFingerprintRules(install.fingerprint) : [])].join("\n");
}
const beneath = (root: string, path: string) => { const value = relative(root, path); return !value || value !== ".." && !value.startsWith(`..${sep}`) && !isAbsolute(value); };
export function validateCommandProbe(value: unknown, nonce: string, hits: number, scratch: string, install = false) {
  const r = value as Record<string, unknown> | null;
  if (!r || r.nonce !== nonce || r.node !== true || r.outsideReadDenied !== true || r.homeReadDenied !== true || r.outsideWriteDenied !== true || r.gitWriteDenied !== true || r.networkDenied !== !install || r.credentialsHidden !== true || r.workspaceWrite !== true || (install && r.listenDenied !== true) || typeof r.tmp !== "string" || !beneath(scratch, r.tmp) || !Array.isArray(r.keychain) || r.keychain.length !== KEYCHAIN_SERVICES.length || r.keychain.some((entry, index) => entry.service !== KEYCHAIN_SERVICES[index] || !Number.isInteger(entry.status) || entry.status === 0) || (install ? hits < 1 : hits !== 0)) throw new Error("固定命令的正向或反向沙箱断言未全部通过。");
}
export class ReviewCommandSandbox {
  // Tools have no model credentials. Only installation receives a sanitized proxy.
  private readonly runner = new ManagedChildProcessRunner();
  private readonly launchd = new ReviewLaunchdLabels(this.runner);
  private observedLabels: string[] = [];
  get possibleLaunchdLabels() { return [...this.observedLabels]; }
  private tools: ReviewTool[] = [];
  private readonly unavailableTools = new Map<string, string>();
  private policy = "";
  private extraCAFiles: string[] = [];
  private copy: ReviewCopy | undefined;
  private ownership: ReviewInstallProcesses | undefined;
  reason: string | null = "尚未探测命令沙箱。";
  readonly records: Array<{ argv: string[]; exitCode: number }> = [];
  constructor(private readonly environment: NodeJS.ProcessEnv = process.env, private readonly install?: ReviewInstallSandbox, private readonly onLaunchdChange?: (labels: string[]) => Promise<void> | void) {
    if (install) this.install = { ...install, fingerprint: install.fingerprint ?? createReviewSandboxFingerprint(), controlDirectory: install.controlDirectory ?? join(dirname(install.root), "install-controls", randomUUID()) };
  }
  get available() { return this.copy !== undefined && this.reason === null; }
  private toolEnvironment(copy: ReviewCopy): NodeJS.ProcessEnv {
    const base = { ...reviewToolEnvironment(copy, this.tools.map(tool => dirname(tool.executable)), this.environment), PARASELF_PROVIDER_CHILD: "1" };
    if (!this.install) return base;
    const root = this.install.root;
    return { ...base, HOME: join(root, "home"), TMPDIR: join(root, "tmp"), XDG_CACHE_HOME: join(root, "cache"), XDG_CONFIG_HOME: join(root, "home", "config"), XDG_DATA_HOME: join(root, "home", "data"), XDG_STATE_HOME: join(root, "home", "state"), npm_config_cache: join(root, "cache", "npm"), npm_config_userconfig: join(root, "home", ".npmrc"), npm_config_globalconfig: join(root, "home", "global-npmrc"), npm_config_store_dir: join(root, "cache", "pnpm"), PNPM_HOME: join(root, "home", "pnpm"), YARN_CACHE_FOLDER: join(root, "cache", "yarn"), YARN_GLOBAL_FOLDER: join(root, "cache", "yarn-global"), YARN_ENABLE_GLOBAL_CACHE: "false", ...(this.install.proxy ? { HTTP_PROXY: this.install.proxy, HTTPS_PROXY: this.install.proxy } : {}) };
  }
  get nodeVersion() { return this.version; }
  private version = "";
  private async execute(copy: ReviewCopy, executable: string, argv: string[], signal?: AbortSignal, timeoutMs = 10 * 60_000, ownershipProbe = false) {
    if (await realpath(copy.tree) !== copy.tree) throw new Error("命令工作区不再是原规范路径。");
    const parent = this.install?.controlDirectory ?? copy.directory; await mkdir(parent, { recursive: true, mode: 0o700 });
    const control = join(parent, `command-control-${randomUUID()}`); await mkdir(control, { mode: 0o700 });
    try {
      const profile = join(control, "command.sb"); await writeFile(profile, this.policy, { mode: 0o600 });
      if (this.install) { this.ownership ??= new ReviewInstallProcesses(this.install.root, this.install.fingerprint!, this.runner, undefined, this.install.controlDirectory); await this.ownership.assertReady(); }
      const run = () => this.runner.run({ provider: this.install ? "local-review-install" : "local-review-command", model: "sandbox", executable: "/usr/bin/sandbox-exec", args: ["-f", profile, executable, ...argv], stdin: "", cwd: copy.tree, timeoutMs, acceptNonzeroExit: true, maximumStdoutBytes: 2 * 1024 * 1024, maximumStderrBytes: this.install ? 2 * 1024 * 1024 : 128 * 1024, ...(this.install ? { maximumOutputBytes: 2 * 1024 * 1024, cleanup: () => this.ownership!.reap() } : {}), environment: this.toolEnvironment(copy), ...(signal ? { signal } : {}) });
      return await (ownershipProbe && this.ownership ? this.ownership.observeProbe(run) : run());
    } finally { await rm(control, { recursive: true, force: true }); }
  }
  async probe(input: ReviewCopy, signal?: AbortSignal) {
    this.records.length = 0; this.observedLabels = [];
    this.reason = "当前平台不支持 sandbox-exec；未提供命令工具。"; this.copy = undefined;
    if (process.platform !== "darwin") return;
    const copy = { directory: await realpath(input.directory), tree: await realpath(input.tree), git: await realpath(input.git) };
    const scratch = join(copy.directory, "scratch"); await mkdir(scratch, { recursive: true, mode: 0o700 });
    if (this.install) for (const part of ["home", "tmp", "cache"]) await mkdir(join(this.install.root, part), { recursive: true, mode: 0o700 });
    const privateRoot = this.install ? dirname(this.install.root) : copy.directory;
    const privateHome = join(privateRoot, `command-home-${randomUUID()}`), homeCanary = join(privateHome, ".npmrc");
    const outside = join(privateRoot, `command-private-${randomUUID()}`), deniedWrite = outside + "-write", gitProbe = join(copy.git, `command-probe-${randomUUID()}`), workspaceProbe = join(copy.tree, `.command-probe-${randomUUID()}`), receipt = join(scratch, `probe-${randomUUID()}.json`), native = join(scratch, `probe-${randomUUID()}.node`);
    const server = createServer(socket => { hits++; socket.end(); }); let hits = 0;
    try {
      this.extraCAFiles = await reviewExtraCAFiles(this.environment);
      this.unavailableTools.clear();
      this.tools = await resolveReviewTools(copy.directory, this.environment, this.runner, Object.fromEntries(["HOME", "PATH", "VOLTA_HOME"].flatMap(name => this.environment[name] ? [[name, this.environment[name]!]] : [])), signal, (name, reason) => { this.unavailableTools.set(name, reason); });
      const node = this.tools.find(tool => tool.name === "node"); if (!node) throw new Error(`Node 工具不可用：${this.unavailableTools.get("node") ?? "未发现可执行文件。"}`);
      this.policy = reviewCommandPolicy(copy, this.tools, this.install, this.extraCAFiles);
      await mkdir(privateHome, { mode: 0o700 }); await writeFile(homeCanary, randomUUID());
      await writeFile(outside, randomUUID()); await writeFile(gitProbe, "unchanged"); await copyFile(reviewNativeModulePath(), native);
      await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
      const address = server.address(); if (!address || typeof address === "string") throw new Error("网络金丝雀未就绪。");
      // A client's connect event can precede the server's connection callback.
      // Wait for both before resetting hits, including under a busy test runner.
      await new Promise<void>((resolve, reject) => {
        let connected = false, accepted = false;
        const finish = (error?: Error) => {
          if (!error && (!connected || !accepted)) return;
          clearTimeout(timer); server.off("connection", onAccepted); connection.destroy();
          if (error) reject(error); else resolve();
        };
        const onAccepted = () => { accepted = true; finish(); };
        server.once("connection", onAccepted);
        const connection = createConnection({ host: "127.0.0.1", port: address.port }, () => { connected = true; finish(); });
        const timer = setTimeout(() => finish(new Error("网络金丝雀正向控制超时。")), 2000);
        connection.once("error", finish);
      });
      if (!hits) throw new Error("网络金丝雀正向控制失败。"); hits = 0;
      const nonce = randomUUID();
      const script = `// LR_PI_COMMAND_PROBE
const fs=require('node:fs'),net=require('node:net'),os=require('node:os');
const install=${!!this.install},denied=fn=>{try{fn();return false}catch{return true}};
const native=require(${JSON.stringify(native)});
const result={nonce:${JSON.stringify(nonce)},node:true,version:process.version,
  homeReadDenied:denied(()=>fs.readFileSync(${JSON.stringify(homeCanary)})),
  outsideReadDenied:denied(()=>fs.readFileSync(${JSON.stringify(outside)})),
  outsideWriteDenied:denied(()=>fs.writeFileSync(${JSON.stringify(deniedWrite)},'bad')),
  gitWriteDenied:denied(()=>fs.appendFileSync(${JSON.stringify(gitProbe)},'bad')),
  workspaceWrite:false,
  credentialsHidden:!Object.keys(process.env).some(key=>/key|token|credential|password|secret/i.test(key)||(!install&&/proxy/i.test(key))||(/^PARASELF_|^DECISION_/i.test(key)&&key!=='PARASELF_PROVIDER_CHILD')),
  tmp:fs.realpathSync(os.tmpdir()),keychain:${JSON.stringify(KEYCHAIN_SERVICES)}.map(service=>({service,status:native.machLookup(service)}))};
fs.writeFileSync(${JSON.stringify(workspaceProbe)},'allowed');result.workspaceWrite=true;
const outbound=new Promise(resolve=>{const socket=net.connect({host:'127.0.0.1',port:${address.port}});let done=false;
  const timer=setTimeout(()=>finish(true),2000);
  const finish=denied=>{if(done)return;done=true;clearTimeout(timer);socket.destroy();resolve(denied)};
  socket.once('connect',()=>finish(false));socket.once('error',()=>finish(true));});
const listening=install?new Promise(resolve=>{const server=net.createServer();server.once('error',()=>resolve(true));server.listen(0,'127.0.0.1',()=>server.close(()=>resolve(false)));}):Promise.resolve(true);
Promise.all([outbound,listening]).then(async([networkDenied,listenDenied])=>{if(install)await new Promise(resolve=>setTimeout(resolve,250));result.networkDenied=networkDenied;result.listenDenied=listenDenied;fs.writeFileSync(${JSON.stringify(receipt)},JSON.stringify(result));process.stdout.write('LR_PI_COMMAND_PROBE_DONE\\n')});`;
      const probeResult = await this.execute(copy, node.executable, ["-e", script], signal, 30_000, !!this.install);
      if (probeResult.exitCode !== 0) throw new Error(`命令沙箱探测退出 ${probeResult.exitCode}：${probeResult.stderr.slice(0, 1200)}`);
      const handle = await open(receipt, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); let value: unknown;
      try { const stat = await handle.stat(); if (!stat.isFile() || stat.size > 16000) throw new Error("命令探测回执无效。"); value = JSON.parse(await handle.readFile("utf8")); } finally { await handle.close(); }
      await new Promise(resolve => setImmediate(resolve)); validateCommandProbe(value, nonce, hits, this.install ? await realpath(join(this.install.root, "tmp")) : await realpath(scratch), !!this.install);
      this.version = (value as { version?: string }).version ?? "";
      if (await realpath(copy.tree) !== copy.tree || await realpath(copy.git) !== copy.git || await readFile(gitProbe, "utf8") !== "unchanged") throw new Error("命令探测改变了边界目录或 Git 元数据。");
      this.copy = copy; this.reason = null;
    } catch (error) { signal?.throwIfAborted(); this.reason = error instanceof ManagedProcessError ? (error.diagnosticExcerpt || `${error.message} (${error.code}, exit=${error.processExitCode ?? "signal"})`).slice(0, 1200) : error instanceof Error ? error.message.slice(0, 1200) : "命令沙箱探测失败。"; }
    finally { await new Promise<void>(resolve => server.close(() => resolve())); await Promise.all([outside, deniedWrite, gitProbe, workspaceProbe, receipt, native].map(path => rm(path, { force: true }))); await rm(privateHome, { recursive: true, force: true }); }
  }
  async run(argv: string[], signal?: AbortSignal) {
    if (!this.available || !this.copy) throw new Error(this.reason ?? "未提供命令工具。");
    if (!argv.length || argv.length > 200 || argv.some(value => !value || value.includes("\0") || value.length > 8192) || Buffer.byteLength(JSON.stringify(argv)) > 64000) throw new Error("命令 argv 无效或超限。");
    const tool = argv[0] === "git" || argv[0] === "/usr/bin/git" ? { executable: "/usr/bin/git" } : this.tools.find(tool => tool.name === argv[0] || tool.executable === argv[0]); if (!tool) throw new Error(this.unavailableTools.has(argv[0]!) ? `工具 ${argv[0]} 不可用：${this.unavailableTools.get(argv[0]!)}` : "只能执行已发现的固定工具链程序，不支持 shell 命令字符串。");
    // ponytail: label-set comparison is host-wide, post-hoc detection, not
    // isolation. Normal host changes can cause false positives; never remove jobs.
    let before: string[];
    try { before = await this.launchd.snapshot(); }
    catch { this.reason = "无法取得宿主 launchd 标签；未执行命令，本组后续命令已停止。"; throw new Error(this.reason); }
    let result: { exitCode: number; stdout: string; stderr: string; durationMs: number } | undefined, failure: unknown;
    try { result = await this.execute(this.copy, tool.executable, argv.slice(1), signal, this.install ? 20 * 60_000 : 10 * 60_000); this.records.push({ argv: [...argv], exitCode: result.exitCode }); }
    catch (error) {
      const exitCode = error instanceof ManagedProcessError ? error.processExitCode : undefined; this.records.push({ argv: [...argv], exitCode: exitCode ?? -1 });
      if (exitCode !== undefined && error instanceof ManagedProcessError) result = { exitCode, stdout: error.diagnosticExcerpt, stderr: "", durationMs: 0 }; else failure = error;
    }
    let after: string[];
    // Capture even on cancellation/timeout, without inheriting the aborted signal.
    try { after = await this.launchd.snapshot(); }
    catch { this.reason = "未能完成宿主 launchd 标签对照；本组后续命令已停止，依赖不发布。"; throw new Error(this.reason); }
    const added = addedReviewLaunchdLabels(before, after);
    if (added.length) {
      this.observedLabels = [...new Set([...this.observedLabels, ...added])]; this.reason = REVIEW_LAUNCHD_WARNING;
      await this.onLaunchdChange?.(added);
      // Actual labels stay in host-only metadata, never in the model's tool data.
      return { ...(result ?? { exitCode: -1, stdout: "", stderr: "", durationMs: 0 }), abnormal: true, warning: REVIEW_LAUNCHD_WARNING };
    }
    if (failure) throw failure;
    return result!;
  }
}
