import { mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, join, relative, isAbsolute, sep } from "node:path";
import { reviewNativeFs, type ReviewNativeFs } from "./local-review-filesystem.js";
import { reviewSandboxFingerprintRules, reviewSandboxFingerprintSchema, type ReviewSandboxFingerprint } from "./local-review-sandbox-fingerprint.js";
import type { ManagedChildProcessRunner } from "./model/cli/managed-child-process.js";

/** Attribution requires every secret Mach decision; path shapes grant no authority. */
export class ReviewInstallProcesses {
  readonly fingerprint: ReviewSandboxFingerprint;
  private ready: Promise<void> | undefined;
  constructor(readonly root: string, fingerprint: ReviewSandboxFingerprint, private readonly runner: ManagedChildProcessRunner, private readonly native: ReviewNativeFs = reviewNativeFs(), readonly controlDirectory = join(dirname(root), "install-controls", randomUUID())) {
    this.fingerprint = reviewSandboxFingerprintSchema.parse(fingerprint);
  }
  private list() {
    if (!this.native.sandboxProcesses || !this.native.killSandboxProcess) throw new Error("安装进程归属接口不可用；拒绝启动安装。");
    return this.native.sandboxProcesses(this.fingerprint.names, this.fingerprint.allowed);
  }
  private async probeControls() {
    const r = relative(this.root, this.controlDirectory);
    if (!r || r !== ".." && !r.startsWith(`..${sep}`) && !isAbsolute(r)) throw new Error("指纹配置不能位于安装可读目录。");
    await mkdir(this.controlDirectory, { recursive: true, mode: 0o700 });
    if (await realpath(this.controlDirectory) !== this.controlDirectory) throw new Error("指纹配置目录被重定向。");
    const directory = join(this.controlDirectory, randomUUID()); await mkdir(directory, { mode: 0o700 });
    const runtime = '(allow process-exec)(allow file-read-metadata)(allow file-read* file-map-executable (literal "/") (subpath "/System") (subpath "/usr/lib") (subpath "/bin") (literal "/private/var/select/sh") (literal "/dev/null"))(allow sysctl-read)';
    const profiles = [
      '(version 1)(allow default)',
      '(version 1)(deny default)' + runtime,
      `(version 1)(allow default)(deny file-write-data (literal ${JSON.stringify(dirname(this.root))}))`,
      '(version 1)(deny default)' + runtime + '\n' + reviewSandboxFingerprintRules(this.fingerprint).join('\n'),
    ];
    // ponytail: four fixed controls, a 4s total admission deadline, 8s runner cap.
    const deadline = Date.now() + 4000;
    const controls: Array<{ controller: AbortController; pending: Promise<unknown>; ready: Promise<number>; finished: boolean }> = [];
    try {
      for (const [index, profile] of profiles.entries()) {
        const path = join(directory, `${index}.sb`); await writeFile(path, profile, { mode: 0o600 });
        const controller = new AbortController(); let resolve!: (pid: number) => void, reject!: (error: unknown) => void;
        const ready = new Promise<number>((yes, no) => { resolve = yes; reject = no; });
        const pending = this.runner.run({ provider: "local-review-ownership-probe", executable: "/usr/bin/sandbox-exec", args: ["-f", path, "/bin/sh", "-c", 'printf "READY:%s\\n" "$$"; exec /bin/sleep 5'], environment: { PATH: "/usr/bin:/bin", LANG: "C", OPENSSL_CONF: "/dev/null" }, cwd: this.root, stdin: "", timeoutMs: 8000, maximumStdoutBytes: 1000, maximumStderrBytes: 1000, signal: controller.signal,
          conversation: stdout => { const match = /^READY:(\d+)\n/u.exec(stdout); if (match) resolve(Number(match[1])); return {}; },
        });
        pending.catch(reject); const control = { controller, pending, ready, finished: false };
        pending.then(() => { control.finished = true; }, () => { control.finished = true; }); controls.push(control);
      }
      const timeout = new Promise<never>((_, reject) => { const timer = setTimeout(() => reject(new Error("指纹正反例探测超时。")), Math.max(1, deadline - Date.now())); timer.unref(); });
      const pids = await Promise.race([Promise.all(controls.map(control => control.ready)), timeout]);
      await new Promise(resolve => setImmediate(resolve));
      if (Date.now() >= deadline || controls.some(control => control.finished)) throw new Error("指纹探测控制进程已退出或超时。 ");
      const matches = this.list();
      if (Date.now() >= deadline || controls.some(control => control.finished) || pids.slice(0, 3).some(pid => matches.some(process => process.pid === pid)) || !matches.some(process => process.pid === pids[3])) throw new Error("随机指纹的默认允许/默认拒绝/无关父目录/同指纹探测未全部通过；拒绝安装和回收。");
    } finally {
      // These are directly created fixed probes, never PIDs inferred by attribution.
      for (const control of controls) control.controller.abort();
      await Promise.allSettled(controls.map(control => control.pending));
      await rm(directory, { recursive: true, force: true });
    }
  }
  async assertReady() {
    if (process.platform !== "darwin" || this.root === dirname(this.root) || await realpath(this.root) !== this.root) throw new Error("安装进程回收不支持此平台或目录；拒绝启动安装。");
    this.list(); await (this.ready ??= this.probeControls());
  }
  async observeProbe<T>(work: () => Promise<T>): Promise<T> {
    await this.assertReady();
    let observed = false, fault: unknown;
    const sample = () => { try { observed ||= this.list().length > 0; } catch (error) { fault = error; } };
    const timer = setInterval(sample, 25);
    try {
      const result = await work();
      if (fault) throw fault;
      if (!observed) throw new Error("未能识别实际安装沙箱的随机指纹；拒绝启动安装。");
      return result;
    } finally { clearInterval(timer); }
  }
  async reap() {
    await this.assertReady();
    // ponytail: at most 5 seconds / 200 snapshots, three empty snapshots required.
    // C rechecks all 32 decisions and birth identity twice. The final check/kill
    // PID reuse window is not atomic; no extra mechanism claims to eliminate it.
    const deadline = Date.now() + 5000; let empty = 0, failure: string | undefined;
    for (let scan = 0; scan < 200 && Date.now() < deadline; scan++) {
      const processes = this.list();
      if (!processes.length) { if (++empty === 3) { if (failure) throw new Error(failure); return; } }
      else {
        empty = 0;
        for (const process of processes) {
          try {
            const killed = this.native.killSandboxProcess!(process.pid, process.seconds, process.microseconds, this.fingerprint.names, this.fingerprint.allowed);
            if (!killed) failure ??= "进程指纹或出生身份不再确定；其余候选仍完整复核，本轮不发布依赖。";
          } catch (error) { failure ??= error instanceof Error ? error.message : "进程回收接口失败；本轮不发布依赖。"; }
        }
      }
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    throw new Error(failure ?? "安装后代未能在回收期限内全部退出；不发布依赖。");
  }
}
