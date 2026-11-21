import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { chmod, copyFile, lstat, mkdtemp, mkdir, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ModelProviderProfile, LocalReviewAction, LocalReviewJob } from "@cognelis/decision-protocol";
import { ReviewViewError, LocalReviewGit, type ReviewCopy, type ReviewRepository, type ReviewNetworkSnapshot } from "../src/main/local-review-git.js";
import { LocalReviewDependencies } from "../src/main/local-review-dependencies.js";
import { LocalReviewService, localReviewNotification, legacyLedgerSchemaV1 } from "../src/main/local-review-service.js";
import * as reviewWorkers from "../src/main/local-review-workers.js";
import { reviewEvaluation, reviewFix, type DiscussionRequest } from "../src/main/local-review-worker.js";
import { PrConnections } from "../src/main/pr-connections.js";

vi.mock("../src/main/login-shell-path.js", () => ({ loginShellPath: async (environment: NodeJS.ProcessEnv) => environment.PATH ?? "" }));

const dispose: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const close of dispose.splice(0).reverse()) await close(); });
async function bytes(root: string) {
  const result: Record<string, string> = {};
  for (const e of await readdir(root, { recursive: true, withFileTypes: true })) if (e.isFile()) result[join(e.parentPath, e.name).slice(root.length)] = (await readFile(join(e.parentPath, e.name))).toString("base64");
  return result;
}
async function fixture(bodies = ["修复 a", "修复 b"], version = "0.166.0", gateway?: import("../src/main/decision-assistant-service.js").AssistantGatewayLike) {
  const root = await mkdtemp(join(tmpdir(), "lr-service-")); dispose.push(() => rm(root, { recursive: true, force: true }));
  const repo = join(root, "repo"), home = join(root, "home"), codex = join(root, "codex");
  for (const p of [repo, home, codex]) await mkdir(p);
  const environment = { HOME: home, CODEX_HOME: codex, PATH: "/usr/bin:/bin", MODEL_PROXY_URL: "http://127.0.0.1:9", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" };
  const git = (...args: string[]) => execFileSync("/usr/bin/git", args, { cwd: repo, env: environment, encoding: "utf8" }).trim();
  git("init", "-b", "main"); git("config", "user.name", "Fixture"); git("config", "user.email", "fixture@example.invalid");
  for (let i = 0; i < bodies.length; i++) await writeFile(join(repo, `file${i}.txt`), `before${i}\n`);
  git("add", "."); git("commit", "-m", "fixture");
  const bare = join(root, "remote.git"); git("init", "--bare", bare); git("remote", "add", "origin", bare); git("push", "origin", "main");
  const pulls: Array<Record<string, any>> = [], posts: Array<Record<string, any>> = [], reads: string[] = [];
  let lostCreate = false;
  // Conversation endpoints of the fake platform: PR detail, issue comments, and switches to make comments fail or lose their reply.
  const comments: Array<{ id: number | string; body: string; created_at: string; user: { login: string } }> = [], platform = { commentStatus: 0, loseCommentReply: false, commentReads: 0 };
  const server = createServer(async (req, res) => {
    const url = (req.url ?? "").replace(/^\/api\/v3/u, "");
    const detail = /^\/repos\/org\/app\/pulls\/(\d+)$/u.exec(url.split("?")[0]!), issueComments = /^\/repos\/org\/app\/issues\/\d+\/comments/u.test(url);
    if (req.method === "GET" && detail) {
      const pr = pulls[Number(detail[1]) - 1]; if (!pr) { res.statusCode = 404; res.end("{}"); return; }
      const sha = (ref: string) => execFileSync("/usr/bin/git", ["--git-dir", bare, "rev-parse", ref], { encoding: "utf8" }).trim();
      res.end(JSON.stringify({ title: "pr", state: "open", merged: false, head: { sha: sha(`refs/heads/${pr.head.ref}`), ref: pr.head.ref, repo: { full_name: "org/app" } }, base: { sha: sha(`refs/heads/${pr.base.ref}`), ref: pr.base.ref, repo: { full_name: "org/app" } } })); return;
    }
    if (req.method === "GET" && issueComments) { platform.commentReads++; res.end(JSON.stringify(comments)); return; }
    if (req.method === "GET" && /^\/repos\/org\/app\/pulls\/\d+\/comments/u.test(url)) { res.end("[]"); return; }
    if (req.method === "POST" && issueComments) {
      let text = ""; for await (const chunk of req) text += chunk;
      if (platform.commentStatus) { res.statusCode = platform.commentStatus; res.end("{}"); return; }
      const comment = { id: comments.length + 1, body: JSON.parse(text).body as string, created_at: new Date().toISOString(), user: { login: "paraself" } };
      comments.push(comment);
      if (platform.loseCommentReply) { platform.loseCommentReply = false; req.socket.destroy(); return; }
      res.end(JSON.stringify({ id: comment.id })); return;
    }
    if (req.method === "POST") {
      let text = ""; for await (const chunk of req) text += chunk;
      const body = JSON.parse(text), pr = { number: pulls.length + 1, head: { ref: body.head, repo: { full_name: "org/app" } }, base: { ref: body.base, repo: { full_name: "org/app" } } };
      posts.push(body); pulls.push(pr);
      if (lostCreate) { lostCreate = false; req.socket.destroy(); return; }
      res.end(JSON.stringify(pr));
    } else { reads.push(req.url ?? ""); res.end(JSON.stringify(pulls)); }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  dispose.push(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const address = server.address(); if (!address || typeof address === "string") throw new Error("missing port");
  const baseUrl = `http://127.0.0.1:${address.port}`, remote = `${baseUrl}/org/app.git`;
  class FixtureGit extends LocalReviewGit {
    pushes = 0; lostPush = false;
    override pushUrl() { return Promise.resolve(remote); }
    override originUrl() { return Promise.resolve(remote); }
    override checkBase(snapshot: ReviewNetworkSnapshot, branch: string, signal?: AbortSignal) { return super.checkBase({ ...snapshot, url: bare }, branch, signal); }
    override branchOid(snapshot: ReviewNetworkSnapshot, branch: string, signal?: AbortSignal) { return super.branchOid({ ...snapshot, url: bare }, branch, signal); }
    override fetchTip(copy: ReviewCopy, snapshot: ReviewNetworkSnapshot, branch: string, expected: string, signal?: AbortSignal) { return super.fetchTip(copy, { ...snapshot, url: bare }, branch, expected, signal); }
    override async push(copy: ReviewCopy, snapshot: ReviewNetworkSnapshot, commit: string, branch: string, signal?: AbortSignal, expected = "") { this.pushes++; await super.push(copy, { ...snapshot, url: bare }, commit, branch, signal, expected); if (this.lostPush) { this.lostPush = false; throw new Error("lost push receipt"); } }
  }
  const runner = new FixtureGit("/usr/bin/git", environment, true), executable = join(root, "fake-codex"), log = join(root, "calls.jsonl");
  await writeFile(join(codex, "models_cache.json"), JSON.stringify({ models: [{ slug: "fixture" }] }));
  const interpreter = join(root, "fixture-node"); await copyFile(process.execPath, interpreter, constants.COPYFILE_FICLONE);
  await writeFile(executable, `#!${interpreter}
const fs=require('node:fs'),path=require('node:path');const args=process.argv.slice(2);
if(args.includes('debug')&&args.includes('models')){console.log(JSON.stringify({models:[{slug:'fixture'}]}));process.exit(0)}
if(args.includes('--version')){console.log(${JSON.stringify("codex-cli ")}+${JSON.stringify(version)});process.exit(0)}
if(args[0]==='sandbox'){fs.appendFileSync(${JSON.stringify(join(root,'quick-checks'))},'1');if(fs.existsSync(${JSON.stringify(join(root, 'reject-config'))})){process.stderr.write('unsupported model_catalog_json');process.exit(2)}if(!fs.existsSync(${JSON.stringify(join(root,'reject-node'))})){const node=path.join(process.cwd(),'../tool-bin/node');if(fs.existsSync(node))process.stdout.write(require('node:child_process').execFileSync(node,['-e',"process.stdout.write('LR_NODE_OK\\\\n')"],{env:{OPENSSL_CONF:'/dev/null'},encoding:'utf8'}));}console.log('workspace-canary\\nprogram-read-canary\\nLR_READ_DENIED\\nLR_PROGRAM_DENIED\\nLR_GIT_DENIED\\nLR_OUTSIDE_DENIED\\n'+(args.some(a=>a.includes('":workspace_roots"="write"'))?'LR_WRITE_ALLOWED':'LR_WRITE_DENIED'));process.exit(0)}
let stdin='';process.stdin.on('data',c=>stdin+=c);process.stdin.on('end',()=>{
 if(stdin.includes('LR_EXEC_SELFCHECK')){
  const probe=JSON.parse(stdin.slice(stdin.lastIndexOf('\\n')+1));fs.appendFileSync(${JSON.stringify(join(root,'selfcheck-cwds'))},process.cwd()+'\\n');if(fs.existsSync(${JSON.stringify(join(root,'mutate-selfcheck'))}))fs.writeFileSync(path.join(process.cwd(),'file0.txt'),'unexpected');fs.appendFileSync(${JSON.stringify(join(root,'self-checks'))},'1\\n');
  if(fs.existsSync(${JSON.stringify(join(root,'fifo-selfcheck'))}))require('node:child_process').execFileSync('/usr/bin/mkfifo',[probe.outputPath]);
  else if(!fs.existsSync(${JSON.stringify(join(root,'missing-selfcheck'))}))fs.writeFileSync(probe.outputPath,JSON.stringify({nonce:fs.existsSync(${JSON.stringify(join(root,'bad-selfcheck'))})?'wrong':probe.nonce,exitCode:1,output:''}));
  console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'{\"ok\":true}'}}));console.log(JSON.stringify({type:'turn.completed'}));return;
 }
 const annotations=JSON.parse(stdin.slice(stdin.lastIndexOf('\\n')+1));const evaluation=stdin.includes('逐条读代码');
 fs.appendFileSync(${JSON.stringify(log)},JSON.stringify({stage:evaluation?'evaluate':'fix',args,ids:annotations.map(a=>a.id)})+'\\n');
 let value;
 if(evaluation&&fs.existsSync(${JSON.stringify(join(root,'fail-evaluate'))}))process.exit(2);
 if(evaluation)value={verdicts:annotations.map(a=>({id:a.id,verdict:'accept',reason:'核实成立'})),groups:annotations.map((a,i)=>({title:'修复 '+i,annotationIds:[a.id],reason:'独立文件与独立根因'}))};
 else {
  const a=annotations[0], fail=path.join(${JSON.stringify(root)},a.id+'.failed');
  if(a.body.includes('FAIL')&&!fs.existsSync(fail)){fs.writeFileSync(fail,'1');process.exit(2)}
  if(a.body.includes('WAIT')){fs.writeFileSync(path.join(${JSON.stringify(root)},'waiting'),'1');setInterval(()=>{},1000);return}
  const target=path.join(process.cwd(),a.body.includes('RISK')?'.github/workflows/ci.yml':a.path);fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,'after\\n');
  if(a.body.includes('DIRECTORY')){fs.unlinkSync(target);fs.mkdirSync(target);fs.writeFileSync(path.join(target,'declared.txt'),'wanted');fs.writeFileSync(path.join(target,'cache.bin'),'unwanted');}
  if(a.body.includes('EXTRA')){const cache=path.join(process.cwd(),'Library/Caches/generated.bin');fs.mkdirSync(path.dirname(cache),{recursive:true});fs.writeFileSync(cache,'cache');}
  value={changedFiles:a.body.includes('DIRECTORY')?[a.path,a.path+'/declared.txt']:[a.body.includes('UNDECLARED')?'unchanged.txt':a.body.includes('RISK')?'.github/workflows/ci.yml':a.path],outcomes:annotations.map(a=>({id:a.id,outcome:'fixed',summary:'已修复'})),commitTitle:'修复示例',verification:'未运行测试：合成工程没有测试命令。'};
 }
 console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:JSON.stringify(value)}}));console.log(JSON.stringify({type:'turn.completed'}));
});`, { mode: 0o755 });
  const credentials = { get: async () => "synthetic-token", set: async () => undefined, delete: async () => true };
  const connections = new PrConnections(join(root, "connections.json"), credentials);
  await connections.save({ label: "fixture", platform: "github", baseUrl, token: "synthetic-token" });
  const profile: ModelProviderProfile = { version: 1, profileId: "fixture", kind: "codex-cli", label: "fixture", enabled: true, priority: 0, timeoutMs: 1000, model: "fixture", executablePath: executable };
  const ledgerRoot = join(root, "local-review");
  const notifications: LocalReviewJob[] = [];
  const createService = () => new LocalReviewService(ledgerRoot, runner, connections, async () => [profile], environment, job => { notifications.push(job); }, gateway);
  const service = createService(); await service.start(); dispose.push(() => service.close());
  const sessionId = await service.register(repo), repositoryId = service.state().repositories[0]!.id;
  for (let i = 0; i < bodies.length; i++) await service.annotate({ repositoryId, sessionId, path: `file${i}.txt`, side: "new", startLine: 1, endLine: 1, body: bodies[i]! });
  const before = await bytes(repo);
  const submit = async () => { const id = await service.submit(repositoryId, sessionId, "fixture"); await service.idle(); return id; };
  const calls = async () => (await readFile(log, "utf8")).split("\n").filter(Boolean).map(line => JSON.parse(line));
  const action = (jobId: string, groupId: string, action: LocalReviewAction["action"]) => service.action({ repositoryId, jobId, groupId, action });
  return { comments, platform, root, repo, bare, git, runner, service, submit, calls, action, posts, pulls, reads, notifications, repositoryId, sessionId, before, environment, profile, createService, setLostCreate: () => { lostCreate = true; } };
}

const noDiscuss = async () => { throw new Error("discuss not used"); };
describe("local review durable worker", () => {
  it.each(["dependencies","command","cancelled-command"] as const)("persists %s launchd warnings and notifies even when the group fails",async source=>{
    const f=await fixture(["one"]), label="synthetic-alert-label";let observed=false;
    const prepare=vi.spyOn(LocalReviewDependencies.prototype,"prepare").mockImplementation(async(_id,_snapshot,_settings,_copy,_signal,onChange)=>{if(source==="dependencies")await onChange?.([label]);return {summary:"synthetic dependencies unavailable",log:""};});
    const factory=vi.spyOn(reviewWorkers,"createLocalReviewWorker").mockImplementation(()=>({
      discuss:noDiscuss,capability:async()=>undefined,
      evaluate:async(_copy,annotations)=>reviewEvaluation({verdicts:annotations.map(a=>({id:a.id,verdict:"accept",reason:"valid"})),groups:[{title:"one",annotationIds:annotations.map(a=>a.id),reason:"same"}]},annotations.map(a=>a.id)),
      get possibleLaunchdLabels(){return observed?[label]:[];},fix:async(_copy,_annotations,signal)=>{observed=source!=="dependencies";if(source==="cancelled-command"){void f.service.action({repositoryId:f.repositoryId,jobId:f.service.state().jobs[0]!.id,action:"cancel"});await new Promise<void>(resolve=>signal?.addEventListener("abort",()=>resolve(),{once:true}));}throw new Error("synthetic failure after command");}
    }));
    try{await f.submit();const job=f.service.state().jobs[0]!;expect(job.possibleLaunchdLabels).toEqual([label]);expect(job.groups[0]!.state).toBe(source==="cancelled-command"?"cancelled":"failed");
      const ledger=JSON.parse(await readFile(join(f.root,"local-review/ledger.json"),"utf8"));expect(ledger.jobs[0].possibleLaunchdLabels).toEqual([label]);
      expect(f.notifications.some(job=>job.possibleLaunchdLabels?.includes(label))).toBe(true);expect(localReviewNotification(job)).toMatchObject({title:expect.stringContaining("可能"),body:expect.stringContaining(label)});
    }finally{factory.mockRestore();prepare.mockRestore();}
  });
  it("keeps the group failure when persisting its launchd warning also fails",async()=>{
    const f=await fixture(["one"]), prepare=vi.spyOn(LocalReviewDependencies.prototype,"prepare").mockResolvedValue({summary:"synthetic",log:""});
    const warning=vi.spyOn(f.service as unknown as {recordLaunchdChange(id:string,labels:readonly string[]):Promise<void>},"recordLaunchdChange").mockRejectedValue(new Error("secondary warning failure"));
    const factory=vi.spyOn(reviewWorkers,"createLocalReviewWorker").mockImplementation(()=>({discuss:noDiscuss,capability:async()=>undefined,
      evaluate:async(_copy,annotations)=>reviewEvaluation({verdicts:annotations.map(a=>({id:a.id,verdict:"accept",reason:"valid"})),groups:[{title:"one",annotationIds:annotations.map(a=>a.id),reason:"same"}]},annotations.map(a=>a.id)),
      possibleLaunchdLabels:["synthetic-label"],fix:async()=>{throw new Error("original group failure");}}));
    try{await f.submit();const job=f.service.state().jobs[0]!;expect(job.state).toBe("finished");expect(job.error).toBeNull();expect(job.groups[0]!.error).toContain("original group failure");expect(warning).toHaveBeenCalled();}
    finally{factory.mockRestore();prepare.mockRestore();warning.mockRestore();}
  });
  it.each([false,true])("preserves dependency verification and checks a clean tree before cloning (cache=%s)", async cached => {
    const f=await fixture(["one"]), prepare=vi.spyOn(LocalReviewDependencies.prototype,"prepare").mockResolvedValue({summary:cached?"依赖缓存命中":"未准备依赖：合成安装失败",log:"synthetic install failure",...(cached?{key:"a".repeat(64)}:{})});
    const capability=vi.fn(async(copy: ReviewCopy)=>{await expect(lstat(join(copy.tree,"node_modules"))).rejects.toThrow();});
    const clone=cached?vi.spyOn(LocalReviewDependencies.prototype,"clone").mockImplementation(async(_id,dep,copy)=>{expect(capability).toHaveBeenCalledTimes(2);await mkdir(join(copy.tree,"node_modules"));return dep.summary;}):undefined;
    const factory=vi.spyOn(reviewWorkers,"createLocalReviewWorker").mockImplementation(()=>({discuss:noDiscuss,capability,evaluate:async(_copy,annotations)=>reviewEvaluation({verdicts:annotations.map(a=>({id:a.id,verdict:"accept",reason:"valid"})),groups:[{title:"one",annotationIds:annotations.map(a=>a.id),reason:"same"}]},annotations.map(a=>a.id)),fix:async(copy,annotations)=>{expect(f.service.state().jobs[0]!.state).toBe("running_groups");await writeFile(join(copy.tree,"file0.txt"),"after\n");return reviewFix({changedFiles:["file0.txt"],outcomes:annotations.map(a=>({id:a.id,outcome:"fixed",summary:"fixed"})),commitTitle:"修复示例",verification:"未运行测试"},annotations.map(a=>a.id));}}));
    try{await f.submit();const job=f.service.state().jobs[0]!;expect(job.state).toBe("finished");expect(job.groups[0]!.state).toBe("pr_opened");expect(job.groups[0]!.fix!.verification).toContain(cached?"依赖缓存命中":"合成安装失败");expect(job.dependencies!.log).toBe("synthetic install failure");}finally{factory.mockRestore();prepare.mockRestore();clone?.mockRestore();}
  });
  it.each(["cancel", "close"] as const)("%s during dependency preparation reaps children and removes temporary copies", async action => {
    const f=await fixture(["one"]);f.environment.PATH=process.env.PATH??"/usr/bin:/bin";
    const code="const fs=require('node:fs');fs.mkdirSync('node_modules');const c=require('node:child_process').spawn(process.execPath,['-e',\"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)\"],{stdio:'inherit'});fs.writeFileSync('install-pid',String(c.pid));setInterval(()=>{},1000);";
    await f.service.saveSettings(f.repositoryId,{...f.service.state().repositories[0]!.settings,dependencies:{mode:"custom",argv:["node","-e",code],files:["file0.txt"],allowScripts:true}});
    const factory=vi.spyOn(reviewWorkers,"createLocalReviewWorker").mockImplementation(()=>({discuss:noDiscuss,capability:async()=>undefined,evaluate:async(_copy,annotations)=>reviewEvaluation({verdicts:annotations.map(a=>({id:a.id,verdict:"accept",reason:"valid"})),groups:[{title:"one",annotationIds:annotations.map(a=>a.id),reason:"same"}]},annotations.map(a=>a.id)),fix:async()=>{throw new Error("must not modify after cancellation");}}));
    try{const id=await f.service.submit(f.repositoryId,f.sessionId,f.profile.profileId);let directory="",pid=0;const runs=join(f.root,"local-review/runs");for(let i=0;i<300;i++){for(const run of await readdir(runs).catch(()=>[])){directory=join(runs,run);pid=Number(await readFile(join(directory,"copy/tree/install-pid"),"utf8").catch(()=>"0"));if(pid)break;}if(pid)break;await new Promise(r=>setTimeout(r,50));}expect(pid).toBeGreaterThan(0);expect(f.service.state().jobs[0]!.state).toBe("preparing_dependencies");if(action==="close")await f.service.close();else await f.service.action({repositoryId:f.repositoryId,jobId:id,action:"cancel"});expect(()=>process.kill(pid,0)).toThrow();await expect(lstat(directory)).rejects.toThrow();expect(f.service.state().jobs[0]!.state).toBe(action==="close"?"interrupted":"cancelled");expect(f.runner.pushes).toBe(0);}finally{factory.mockRestore();}
  },20000);

  it.each(["apple", "openrouter-decisions"] as const)("rejects forged Pi submissions for %s before queueing and preserves drafts", async kind => {
    const f=await fixture(["keep draft"]);Object.assign(f.profile,{kind,model:undefined,executablePath:undefined});
    const before=f.service.state().sessions[0]!.annotations;
    await expect(f.service.submit(f.repositoryId,f.sessionId,f.profile.profileId,"pi")).rejects.toThrow("不支持生成");
    expect(f.service.state().jobs).toEqual([]);expect(f.service.state().sessions[0]!.annotations).toEqual(before);expect(f.runner.pushes).toBe(0);
  });
  it.each(["codex", "claude-code", "pi"] as const)("blocks secret-shaped additions for %s and rejects every publish override", async worker => {
    const f = await fixture(["one"]), secret = "sk-ant-fixture";
    const factory = vi.spyOn(reviewWorkers, "createLocalReviewWorker").mockImplementation(() => ({
      discuss:noDiscuss,capability: async () => undefined,
      evaluate: async (_copy, annotations) => reviewEvaluation({ verdicts: annotations.map(a => ({id:a.id,verdict:"accept",reason:"valid"})), groups:[{title:"one",annotationIds:annotations.map(a=>a.id),reason:"independent"}] }, annotations.map(a=>a.id)),
      fix: async (copy, annotations) => {
        await writeFile(join(copy.tree,"file0.txt"), secret+"\n");
        return reviewFix({changedFiles:["file0.txt"],outcomes:annotations.map(a=>({id:a.id,outcome:"fixed",summary:secret})),commitTitle:"合成令牌测试",verification:secret}, annotations.map(a=>a.id));
      },
    }));
    try {
      const id = await f.service.submit(f.repositoryId,f.sessionId,f.profile.profileId,worker); await f.service.idle();
      const state=f.service.state(), job=state.jobs[0]!, group=job.groups[0]!;
      expect(group.state).toBe("blocked");expect(group.retryable).toBe(false);expect(group.artifact!.secretFindings).toEqual([{path:"file0.txt",line:1}]);
      expect(group.artifact!.diff).toBe("");expect(group.fix).toBeNull();expect(JSON.stringify(state)).not.toContain(secret);expect(f.runner.pushes).toBe(0);expect(f.posts).toEqual([]);
      await expect(f.action(id,group.id,"retry")).rejects.toThrow("只能丢弃");
      await expect(f.service.action({repositoryId:f.repositoryId,jobId:id,groupId:group.id,action:"approve",authorization:{groupId:group.id,commitOid:group.artifact!.commitOid,risks:group.artifact!.risks,pushUrl:job.pushUrl}})).rejects.toThrow("只能丢弃");
      await f.action(id,group.id,"discard");expect(f.service.state().jobs[0]!.groups[0]!.state).toBe("cancelled");expect(f.runner.pushes).toBe(0);
    } finally { factory.mockRestore(); }
  });
  it("runs an explicit Pi worker through the gateway even with a Codex model profile and persists its choice", async () => {
    let f: Awaited<ReturnType<typeof fixture>>, step = 0;
    const gateway: import("../src/main/decision-assistant-service.js").AssistantGatewayLike = { listGenerationProfiles: async () => [f.profile], async generate<T>(request: import("@cognelis/decision-protocol").StructuredGenerationRequest, parse: (value: unknown) => T) {
      const ids = f.service.state().jobs[0]!.annotations.map(a => a.id);
      const value = step++ === 0 ? { actions: [{ action: "submit_result", result: { verdicts: ids.map(id => ({ id, verdict: "accept", reason: "valid" })), groups: [{ title: "one", annotationIds: ids, reason: "one change" }] } }] } : step === 2 ? { actions: [{ action: "edit_file", path: "file0.txt", oldText: "before0", newText: "after" }] } : { actions: [{ action: "submit_result", result: { outcomes: ids.map(id => ({ id, outcome: "fixed", summary: "changed" })), commitTitle: "Pi 修复", verification: "未运行测试" } }] };
      return { requestId: request.requestId, attemptId: randomUUID(), profileId: f.profile.profileId, backend: f.profile.kind, provider: "fixture", model: "actual-pi-model", visibleOutput: "", parsedOutput: parse(value), usage: { source: "provider_reported", inputTokens: 1, outputTokens: 1 }, providerDurationMs: 0 };
    } };
    f = await fixture(["one"], "fixture", gateway);
    await f.service.submit(f.repositoryId, f.sessionId, f.profile.profileId, "pi"); await f.service.idle();
    const job = f.service.state().jobs[0]!;
    expect(job.worker).toBe("pi"); expect(job.profile.kind).toBe("codex-cli"); expect(job.actualModel).toBe("actual-pi-model"); expect(job.groups[0]!.state).toBe("pr_opened");
    expect(job.groups[0]!.fix!.changedFiles).toEqual(["file0.txt"]); expect(f.service.state().repositories[0]!.settings.worker).toBe("pi");
    expect(await readFile(join(f.root, "calls.jsonl"), "utf8").catch(() => null)).toBeNull();
  });
  it.each([false, true])("reports the uncommitted cache after a file becomes a directory, including lost receipt=%s", async lost => {
    const f = await fixture(["DIRECTORY"]);
    if (lost) {
      const commit = f.runner.commit.bind(f.runner);
      vi.spyOn(f.runner, "commit").mockImplementationOnce(async (...args) => { await commit(...args); throw new Error("lost receipt"); });
    }
    const id = await f.submit();
    let group = f.service.state().jobs[0]!.groups[0]!;
    if (lost) { await f.action(id, group.id, "retry"); await f.service.idle(); group = f.service.state().jobs[0]!.groups[0]!; }
    expect(group.state).toBe("pr_opened");
    expect(group.artifact!.changes.map(change => change.path).sort()).toEqual(["file0.txt", "file0.txt/declared.txt"]);
    expect(group.excludedFiles).toEqual(["file0.txt/cache.bin"]);
    expect(f.posts[0]!.body).toContain("未提交的未声明文件\nfile0.txt/cache.bin");
  });

  it.each([false, true])("uses a real Node installation prefix and fails closed if its execution probe fails (%s)", async rejected => {
    const f = await fixture(["one"]), prefix = join(f.environment.HOME, ".volta/tools/image/node/22.22.2"), bin = join(prefix, "bin");
    await mkdir(bin, { recursive: true }); await copyFile(process.execPath, join(bin, "node"), constants.COPYFILE_FICLONE);
    f.environment.PATH = `${bin}:/usr/bin:/bin`;
    if (rejected) await writeFile(join(f.root, "reject-node"), "1");
    if (rejected) { await expect(f.submit()).rejects.toThrow("探测失败"); expect(f.service.state().jobs).toHaveLength(0); expect(f.posts).toHaveLength(0); }
    else {
      await f.submit(); const job = f.service.state().jobs[0]!;
      expect(job.groups[0]!.state).toBe("pr_opened");
      const args = (await f.calls())[0]!.args.join("\n");
      expect(args).toContain(`${JSON.stringify(await realpath(prefix))}=\"read\"`);
      expect(args).not.toContain(`${JSON.stringify(f.environment.HOME)}=\"read\"`);
      expect(args).toContain("tool-bin");
    }
  });

  it.each(["EXTRA", "UNDECLARED"])("records excludedFiles for %s without committing undeclared paths", async body => {
    const f = await fixture([body]); await f.submit();
    const group = f.service.state().jobs[0]!.groups[0]!;
    if (body === "EXTRA") {
      expect(group.state).toBe("pr_opened");
      expect(group.excludedFiles).toEqual(["Library/Caches/generated.bin"]);
      expect(group.artifact!.changes.map(change => change.path)).toEqual(["file0.txt"]);
      expect(f.posts[0]!.body).toContain("未提交的未声明文件"); expect(f.posts[0]!.body).toContain("Library/Caches/generated.bin");
    } else {
      expect(group.state).toBe("no_changes"); expect(group.excludedFiles).toEqual(["file0.txt"]); expect(f.posts).toHaveLength(0);
    }
  });
  it("uses the CLI default without reading a user model cache", async () => {
    const f = await fixture(["one"]); delete f.profile.model;
    await rm(join(f.root, "codex/models_cache.json"));
    await f.submit();
    expect(f.service.state().jobs[0]!.profile.model).toBeUndefined();
    expect((await f.calls()).every(call => !call.args.includes("--model"))).toBe(true);
    expect(f.service.state().jobs[0]!.groups[0]!.state).toBe("pr_opened");
  });
  it("submits with a 0555 program directory without writing the installation", async () => {
    const f = await fixture(["one"]), programs = join(f.root, "readonly-programs");
    await mkdir(programs);
    const interpreter = join(programs, "fixture-node"), executable = join(programs, "codex");
    await copyFile(process.execPath, interpreter, constants.COPYFILE_FICLONE);
    await writeFile(executable, (await readFile(join(f.root, "fake-codex"), "utf8")).replace(/^#!.*\n/u, `#!${interpreter}\n`), { mode: 0o755 });
    f.profile.executablePath = executable;
    const before = await bytes(programs); await chmod(programs, 0o555);
    try {
      await f.submit();
      expect(f.service.state().jobs[0]!.groups[0]!.state).toBe("pr_opened");
      expect(await bytes(programs)).toEqual(before);
      expect((await lstat(programs)).mode & 0o777).toBe(0o555);
    } finally { await chmod(programs, 0o755); }
  });
  it("submits a different CLI version when the behavior probe passes", async () => {
    const f = await fixture(["one"], "99.42.7-custom");
    expect(execFileSync(join(f.root, "fake-codex"), ["--version"], { encoding: "utf8" }).trim()).toBe("codex-cli 99.42.7-custom");
    await f.submit();
    expect(f.service.state().jobs[0]!.groups[0]!.state).toBe("pr_opened");
    expect(f.posts).toHaveLength(1);
  });
  it("persists the managed network snapshot without exposing helper commands to the renderer", async () => {
    const f = await fixture(["one"]), capture = f.runner.captureNetwork.bind(f.runner);
    vi.spyOn(f.runner, "captureNetwork").mockImplementation(async (...args) => ({ ...await capture(...args), credentialHelpers: ["!echo SYNTHETIC_PRIVATE_HELPER"] }));
    await f.submit();
    expect(await readFile(join(f.root, "local-review/ledger.json"), "utf8")).toContain("SYNTHETIC_PRIVATE_HELPER");
    expect(JSON.stringify(f.service.state())).not.toContain("SYNTHETIC_PRIVATE_HELPER");
  });
  it("explains incompatible CLI settings as a failed capability probe and keeps the draft", async () => {
    const f = await fixture(["one"], "another-version");
    await writeFile(join(f.root, "reject-config"), "1");
    await expect(f.service.submit(f.repositoryId, f.sessionId, "fixture")).rejects.toThrow(/配置能力探测失败.*unsupported model_catalog_json/u);
    expect(f.service.state().jobs).toHaveLength(0);
    expect(f.service.state().sessions[0]!.annotations).toHaveLength(1);
    expect(f.runner.pushes).toBe(0);
  });
  it.each(["bad-selfcheck", "missing-selfcheck", "fifo-selfcheck"])("rejects %s despite a successful model answer", async flag => {
    const f = await fixture(["one"]); await writeFile(join(f.root, flag), "1");
    await expect(f.service.submit(f.repositoryId, f.sessionId, "fixture")).rejects.toThrow("能力探测失败");
    expect(f.service.state().jobs).toHaveLength(0); expect(f.runner.pushes).toBe(0);
  });
  it("runs exec self-check in the actual copy and rejects unrelated edits", async () => {
    const f = await fixture(["one"]), id = await f.submit();
    expect((await readFile(join(f.root, "selfcheck-cwds"), "utf8")).trim()).toBe(join(await realpath(f.root), "local-review/jobs", id, "probe/tree"));
    const bad = await fixture(["one"]); await writeFile(join(bad.root, "mutate-selfcheck"), "1");
    await expect(bad.service.submit(bad.repositoryId, bad.sessionId, "fixture")).rejects.toThrow("改动了探针文件之外");
    expect(bad.service.state().jobs).toHaveLength(0); expect(await bytes(bad.repo)).toEqual(bad.before);
  });
  it("launches the fingerprinted interpreter instead of a workspace PATH decoy", async () => {
    const f = await fixture(["one"]), executable = join(f.root, "fake-codex"), marker = join(f.root, "decoy-executed");
    await copyFile(process.execPath, join(f.root, "node"), constants.COPYFILE_FICLONE);
    const code = await readFile(executable, "utf8"); await writeFile(executable, code.replace(/^#!.*\n/u, "#!/usr/bin/env node\n"));
    f.environment.PATH = `.${process.platform === "win32" ? ";" : ":"}${f.root}:${f.environment.PATH}`;
    await writeFile(join(f.repo, "node"), `#!/bin/sh\necho unsafe > '${marker}'\nexit 1\n`, { mode: 0o755 });
    f.git("add", "node"); f.git("commit", "-m", "fixture interpreter decoy");
    const sessionId = await f.service.newSession(f.repositoryId);
    await f.service.annotate({ repositoryId: f.repositoryId, sessionId, path: "file0.txt", side: "new", startLine: 1, endLine: 1, body: "one" });
    await f.service.submit(f.repositoryId, sessionId, "fixture"); await f.service.idle();
    expect(f.service.state().jobs[0]!.groups[0]!.state).toBe("pr_opened");
    expect(await readFile(marker, "utf8").catch(() => null)).toBeNull();
  });
  it("repeats fast probes for model calls and repeats the exec check when the executable changes", async () => {
    const f = await fixture(["one", "FAIL"]), id = await f.submit();
    const selfChecks = () => readFile(join(f.root, "self-checks"), "utf8");
    expect((await selfChecks()).trim().split("\n")).toHaveLength(1);
    const group = f.service.state().jobs[0]!.groups[1]!;
    const quickBefore = (await readFile(join(f.root, "quick-checks"), "utf8")).length;
    await f.action(id, group.id, "retry"); await f.service.idle();
    expect((await readFile(join(f.root, "quick-checks"), "utf8")).length).toBeGreaterThan(quickBefore);
    expect((await selfChecks()).trim().split("\n")).toHaveLength(1);
    const executable = join(f.root, "fake-codex"); await writeFile(executable, `${await readFile(executable, "utf8")}\n`);
    const sessionId = await f.service.newSession(f.repositoryId);
    await f.service.annotate({ repositoryId: f.repositoryId, sessionId, path: "file0.txt", side: "new", startLine: 1, endLine: 1, body: "another" });
    await f.service.submit(f.repositoryId, sessionId, "fixture"); await f.service.idle();
    expect((await selfChecks()).trim().split("\n")).toHaveLength(2);
  });
  it("runs two independent groups through real Git and local HTTP, leaving all source bytes untouched", async () => {
    const f = await fixture(), id = await f.submit(), job = f.service.state().jobs[0]!;
    expect(job.state).toBe("finished"); expect(job.groups.map(g => g.state)).toEqual(["pr_opened", "pr_opened"]);
    expect(f.posts).toHaveLength(2); expect(f.posts.every(p => p.draft === true && p.body.includes("未运行测试"))).toBe(true);
    expect(await bytes(f.repo)).toEqual(f.before);
    for (const group of job.groups) {
      const tree = f.git("--git-dir", f.bare, "show", `${group.branch}:${job.annotations.find(a => a.id === group.annotationIds[0])!.path}`);
      expect(tree).toBe("after");
      // A published group keeps git/ (conversation views and appends use it) but its working tree is gone.
      expect(await readFile(join(f.service.jobsRoot, id, group.id, "git/config"), "utf8").catch(() => null)).not.toBeNull();
      expect(await lstat(join(f.service.jobsRoot, id, group.id, "tree")).then(() => true, () => false)).toBe(false);
    }
    expect((await f.calls()).map(c => c.stage)).toEqual(["evaluate", "fix", "fix"]);
    // Published groups stay owned (git/ retained) until the 14-day expiry.
    expect(JSON.parse(await readFile(join(f.root, "local-review/ledger.json"), "utf8")).owners.map((o: { kind: string; state: string }) => `${o.kind}:${o.state}`)).toEqual(["group:ready", "group:ready"]);
    expect(f.service.state()).not.toHaveProperty("owners");
  });
  it("registers probe ownership before prepare and removes partial copies when prepare fails", async () => {
    const f = await fixture(["one"]);
    vi.spyOn(f.runner, "prepare").mockImplementationOnce(async (_snapshot, directory) => {
      const ledger = JSON.parse(await readFile(join(f.root, "local-review/ledger.json"), "utf8"));
      expect(ledger.owners).toEqual([expect.objectContaining({ name: "probe", kind: "probe", state: "preparing" })]);
      await mkdir(join(directory, "tree")); await writeFile(join(directory, "tree/source.txt"), "partial source");
      throw new Error("synthetic checkout failure");
    });
    await expect(f.service.submit(f.repositoryId, f.sessionId, "fixture")).rejects.toThrow("synthetic checkout failure");
    expect(await readdir(f.service.jobsRoot)).toEqual([]);
    expect(f.service.state().jobs).toEqual([]);
    expect(JSON.parse(await readFile(join(f.root, "local-review/ledger.json"), "utf8")).owners).toEqual([]);
  });
  it("cleans orphan roots and unregistered children on startup without replaying finished work", async () => {
    const f = await fixture(["one"]), id = await f.submit(); await f.service.close();
    const orphan = join(f.service.jobsRoot, randomUUID()), child = join(f.service.jobsRoot, id, "unregistered-copy");
    for (const directory of [orphan, child]) { await mkdir(directory, { recursive: true }); await writeFile(join(directory, "source.txt"), "private copy"); }
    const before = (await f.calls()).length, restarted = f.createService(); await restarted.start(); dispose.push(() => restarted.close());
    for (const directory of [orphan, child]) expect(await readFile(join(directory, "source.txt"), "utf8").catch(() => null)).toBeNull();
    expect((await f.calls()).length).toBe(before); expect(f.posts).toHaveLength(1);
  });
  it("does not follow an orphan symlink outside jobs", async () => {
    const f = await fixture(); await f.service.close();
    const id = randomUUID(); await symlink(f.repo, join(f.service.jobsRoot, id));
    const restarted = f.createService(); await restarted.start(); dispose.push(() => restarted.close());
    expect(await bytes(f.repo)).toEqual(f.before);
    const ledger = JSON.parse(await readFile(join(f.root, "local-review/ledger.json"), "utf8"));
    expect(ledger.owners.find((owner: { jobId: string }) => owner.jobId === id)).toMatchObject({ state: "cleanup_failed" });
  });
  it("removes an expired evaluation copy even when evaluation failed before any groups existed", async () => {
    const f = await fixture(["one"]); await writeFile(join(f.root, "fail-evaluate"), "1");
    const id = await f.submit(); expect(f.service.state().jobs[0]).toMatchObject({ state: "failed", planVersion: 0, groups: [] });
    await f.service.close();
    const path = join(f.root, "local-review/ledger.json"), ledger = JSON.parse(await readFile(path, "utf8")), old = new Date(Date.now() - 15 * 86400_000).toISOString();
    ledger.jobs[0].updatedAt = old; for (const owner of ledger.owners) owner.createdAt = old;
    await writeFile(path, JSON.stringify(ledger));
    const restarted = f.createService(); await restarted.start(); dispose.push(() => restarted.close());
    expect(await readFile(join(f.service.jobsRoot, id, "evaluation/tree/file0.txt"), "utf8").catch(() => null)).toBeNull();
    expect(JSON.parse(await readFile(path, "utf8")).owners).toEqual([]);
  });
  it("retries failed tree-only cleanup on restart without deleting committed Git", async () => {
    const f = await fixture(["one"]), original = f.runner.cleanup.bind(f.runner);
    const spy = vi.spyOn(f.runner, "cleanup").mockImplementation(async (root, id, directory) => {
      if (directory.endsWith("/tree") && f.service.state().jobs[0]?.groups[0]?.artifact) throw new Error("tree busy");
      return original(root, id, directory);
    });
    const id = await f.submit(), group = f.service.state().jobs[0]!.groups[0]!;
    expect(group).toMatchObject({ state: "failed" }); expect(group.artifact).not.toBeNull();
    expect(JSON.parse(await readFile(join(f.root, "local-review/ledger.json"), "utf8")).owners[0]).toMatchObject({ cleanup: "tree", state: "cleanup_failed" });
    spy.mockRestore(); await f.service.close();
    const calls = (await f.calls()).length, restarted = f.createService(); await restarted.start(); dispose.push(() => restarted.close());
    expect(await readFile(join(restarted.jobsRoot, id, group.id, "git/HEAD"), "utf8")).toBeTruthy();
    await restarted.action({ repositoryId: f.repositoryId, jobId: id, groupId: group.id, action: "retry" }); await restarted.idle();
    expect(restarted.state().jobs[0]!.groups[0]!.state).toBe("pr_opened"); expect((await f.calls()).length).toBe(calls);
  });
  it("G1 success, G2 failure, G3 success; retry changes only G2 and preserves the plan", async () => {
    const f = await fixture(["first", "FAIL", "third"]), id = await f.submit(), before = f.service.state().jobs[0]!;
    expect(before.groups.map(g => g.state)).toEqual(["pr_opened", "failed", "pr_opened"]);
    await f.action(id, before.groups[1]!.id, "retry"); await f.service.idle();
    expect(f.service.state().jobs[0]!.groups.map(g => g.id)).toEqual(before.groups.map(g => g.id));
    expect((await f.calls()).filter(c => c.stage === "evaluate")).toHaveLength(1);
    expect((await f.calls()).filter(c => c.stage === "fix")).toHaveLength(4);
    expect(f.posts).toHaveLength(3); expect(f.runner.pushes).toBe(3);
  });
  it("reconciles a successful push whose receipt was lost without another model call or push", async () => {
    const f = await fixture(["one"]); f.runner.lostPush = true;
    const id = await f.submit(), group = f.service.state().jobs[0]!.groups[0]!;
    expect(group.state).toBe("failed"); expect(group.artifact).not.toBeNull();
    const calls = (await f.calls()).length;
    await f.action(id, group.id, "retry"); await f.service.idle();
    expect(f.service.state().jobs[0]!.groups[0]!.state).toBe("pr_opened");
    expect(f.runner.pushes).toBe(1); expect((await f.calls()).length).toBe(calls);
  });
  it("finds a created PR after its response was lost and never posts a second PR", async () => {
    const f = await fixture(["one"]); f.setLostCreate();
    const id = await f.submit(), group = f.service.state().jobs[0]!.groups[0]!;
    expect(group.state).toBe("pushed_no_pr");
    await f.action(id, group.id, "retry"); await f.service.idle();
    expect(f.service.state().jobs[0]!.groups[0]!.state).toBe("pr_opened"); expect(f.posts).toHaveLength(1); expect(f.runner.pushes).toBe(1);
  });
  it.each(["retry", "approve"] as const)("%s of G2 leaves G1 pushed_no_pr untouched and persists the selected scope", async action => {
    const f = await fixture(["one", action === "retry" ? "FAIL" : "RISK"]); f.setLostCreate();
    const id = await f.submit(), job = f.service.state().jobs[0]!, group = job.groups[1]!;
    expect(job.groups[0]!.state).toBe("pushed_no_pr");
    const beforeReads = f.reads.length;
    await f.service.action({ repositoryId: f.repositoryId, jobId: id, groupId: group.id, action, ...(action === "approve" ? { authorization: { groupId: group.id, commitOid: group.artifact!.commitOid, risks: group.artifact!.risks, pushUrl: job.pushUrl } } : {}) });
    await f.service.idle();
    expect(f.service.state().jobs[0]!.groups.map(g => g.state)).toEqual(["pushed_no_pr", "pr_opened"]);
    expect(f.posts).toHaveLength(2);
    expect(f.reads.slice(beforeReads).every(path => new URL(path, "http://fixture.invalid").searchParams.get("head")?.endsWith(group.branch))).toBe(true);
    const ledger = JSON.parse(await readFile(join(f.root, "local-review/ledger.json"), "utf8"));
    expect(ledger.jobs[0].selectedGroupIds).toEqual([group.id]);
  });
  it("cancels an executing group, cancels pending groups and starts no further calls", async () => {
    const f = await fixture(["WAIT", "later"]), id = await f.service.submit(f.repositoryId, f.sessionId, "fixture");
    await vi.waitFor(async () => expect(await readFile(join(f.root, "waiting"), "utf8")).toBe("1"));
    await f.service.action({ repositoryId: f.repositoryId, jobId: id, action: "cancel" });
    expect(f.service.state().jobs[0]!.groups.map(g => g.state)).toEqual(["cancelled", "cancelled"]);
    expect((await f.calls()).filter(c => c.stage === "fix")).toHaveLength(1); expect(f.posts).toHaveLength(0);
  });
  it("cancels a queued task without waiting for an unrelated active task", async () => {
    const f = await fixture(["WAIT"]), activeId = await f.service.submit(f.repositoryId, f.sessionId, "fixture");
    await vi.waitFor(async () => expect(await readFile(join(f.root, "waiting"), "utf8")).toBe("1"));
    try {
      const sessionId = await f.service.newSession(f.repositoryId);
      await f.service.annotate({ repositoryId: f.repositoryId, sessionId, path: "file0.txt", side: "new", startLine: 1, endLine: 1, body: "later" });
      const queuedId = await f.service.submit(f.repositoryId, sessionId, "fixture");
      let cancelled = false;
      const request = f.service.action({ repositoryId: f.repositoryId, jobId: queuedId, action: "cancel" }).then(() => { cancelled = true; });
      await vi.waitFor(() => expect(cancelled).toBe(true), { timeout: 2000 }); await request;
      expect(f.service.state().jobs.find(j => j.id === queuedId)!.state).toBe("cancelled");
      expect(f.service.state().jobs.find(j => j.id === activeId)!.groups[0]!.state).toBe("fixing");
      expect((await f.calls()).filter(call => call.stage === "evaluate")).toHaveLength(1);
    } finally { await f.service.action({ repositoryId: f.repositoryId, jobId: activeId, action: "cancel" }); }
  });
  it("rejects foreign session/job identities before accessing Git or changing the queue", async () => {
    const f = await fixture();
    await expect(f.service.read(randomUUID(), f.sessionId, "file0.txt", "new")).rejects.toThrow();
  });
  it("lets G2 finish while G1 is blocked and binds approval to the immutable artifact and target", async () => {
    const f = await fixture(["RISK", "independent"]), id = await f.submit();
    const job = f.service.state().jobs[0]!, group = job.groups[0]!;
    expect(job.groups.map(g => g.state)).toEqual(["blocked", "pr_opened"]);
    const authorization = { groupId: group.id, commitOid: group.artifact!.commitOid, risks: group.artifact!.risks, pushUrl: job.pushUrl };
    await expect(f.service.action({ repositoryId: f.repositoryId, jobId: id, groupId: group.id, action: "approve", authorization: { ...authorization, pushUrl: "https://elsewhere.invalid/a/b" } })).rejects.toThrow("变化");
    await f.service.action({ repositoryId: f.repositoryId, jobId: id, groupId: group.id, action: "approve", authorization }); await f.service.idle();
    expect(f.service.state().jobs[0]!.groups.map(g => g.state)).toEqual(["pr_opened", "pr_opened"]);
    expect((await f.calls()).filter(c => c.stage === "fix")).toHaveLength(2); expect(f.posts).toHaveLength(2);
  });
  it("keeps a successful PR successful when cleanup fails", async () => {
    const f = await fixture(["one"]), original = f.runner.cleanup.bind(f.runner);
    const spy = vi.spyOn(f.runner, "cleanup").mockImplementation(async (root, id, directory) => {
      if (f.pulls.length && directory.includes(f.service.state().jobs[0]!.groups[0]!.id)) throw new Error("cleanup failed");
      return original(root, id, directory);
    });
    await f.submit();
    expect(f.service.state().jobs[0]!.groups[0]).toMatchObject({ state: "pr_opened", cleanupError: "cleanup failed" });
    spy.mockRestore();
  });
  it("retries a committed then cancelled group from its own Git directory, with no new model call", async () => {
    const f = await fixture(["one", "WAIT"]), id = await f.service.submit(f.repositoryId, f.sessionId, "fixture");
    // Two groups plus bounded tool-library discovery precede this synthetic marker.
    await vi.waitFor(async () => expect(await readFile(join(f.root, "waiting"), "utf8")).toBe("1"), { timeout: 5000 });
    const first = f.service.state().jobs[0]!.groups[0]!;
    expect(first.state).toBe("committed");
    await f.service.action({ repositoryId: f.repositoryId, jobId: id, action: "cancel" });
    const calls = (await f.calls()).length;
    await f.action(id, first.id, "retry"); await f.service.idle();
    expect(f.service.state().jobs[0]!.groups[0]!.state).toBe("pr_opened");
    expect((await f.calls()).length).toBe(calls); expect(f.posts).toHaveLength(1);
  });
  it("recovers a commit completed just before its receipt was lost without running the model again", async () => {
    const f = await fixture(["one"]), original = f.runner.commit.bind(f.runner);
    const spy = vi.spyOn(f.runner, "commit").mockImplementationOnce(async (...args) => { await original(...args); throw new Error("lost commit receipt"); });
    const id = await f.submit(), group = f.service.state().jobs[0]!.groups[0]!;
    expect(group.state).toBe("failed"); expect(group.artifact).not.toBeNull();
    const calls = (await f.calls()).length;
    await f.action(id, group.id, "retry"); await f.service.idle();
    expect(f.service.state().jobs[0]!.groups[0]!.state).toBe("pr_opened"); expect((await f.calls()).length).toBe(calls);
    spy.mockRestore();
  });
  it.each([false, true])("merges cancellation with the commit receipt, including lost response=%s", async lost => {
    const f = await fixture(["one"]), original = f.runner.commit.bind(f.runner);
    let entered!: () => void, release!: () => void;
    const ready = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
    vi.spyOn(f.runner, "commit").mockImplementationOnce(async (...args) => {
      const artifact = await original(...args); entered(); await gate;
      if (lost) throw new Error("commit response lost during cancellation");
      return artifact;
    });
    try {
      const id = await f.service.submit(f.repositoryId, f.sessionId, "fixture"); await ready;
      const cancelling = f.service.action({ repositoryId: f.repositoryId, jobId: id, action: "cancel" });
      await vi.waitFor(() => expect(f.service.state().jobs[0]!.state).toBe("cancelled"));
      release(); await cancelling;
      const group = f.service.state().jobs[0]!.groups[0]!;
      expect(group.state).toBe("cancelled"); expect(group.artifact).not.toBeNull();
      expect(f.git("--git-dir", join(f.service.jobsRoot, id, group.id, "git"), "rev-parse", "HEAD")).toBe(group.artifact!.commitOid);
      expect(await readFile(join(f.service.jobsRoot, id, "artifacts/config"), "utf8").catch(() => null)).toBeNull();
      const calls = (await f.calls()).length;
      await f.action(id, group.id, "retry"); await f.service.idle();
      expect(f.service.state().jobs[0]!.groups[0]!.state).toBe("pr_opened"); expect((await f.calls()).length).toBe(calls);
    } finally { release(); }
  });
  it("expires retained Git after 14 days and refuses retries", async () => {
    const f = await fixture(["RISK"]), id = await f.submit(); await f.service.close();
    const ledger = join(f.root, "local-review/ledger.json"), data = JSON.parse(await readFile(ledger, "utf8"));
    data.jobs[0].updatedAt = new Date(Date.now() - 15 * 86400_000).toISOString(); for (const owner of data.owners ?? []) owner.createdAt = data.jobs[0].updatedAt; await writeFile(ledger, JSON.stringify(data));
    const restarted = f.createService(); await restarted.start(); dispose.push(() => restarted.close());
    const group = restarted.state().jobs[0]!.groups[0]!;
    expect(group).toMatchObject({ state: "failed", retryable: false, error: "产物已过期" });
    expect(await readFile(join(restarted.jobsRoot, id, group.id, "git/HEAD"), "utf8").catch(() => null)).toBeNull();
    await expect(restarted.action({ repositoryId: f.repositoryId, jobId: id, groupId: group.id, action: "retry" })).rejects.toThrow("产物已过期");
  });
  it("retains the complete plan if creating G1 fails after evaluation was persisted", async () => {
    const f = await fixture(), original = f.runner.prepare.bind(f.runner);
    const spy = vi.spyOn(f.runner, "prepare").mockImplementation(async (repository, directory, signal) => {
      if (f.service.state().jobs[0]?.planVersion && f.service.state().jobs[0]!.groups[0]?.id === directory.split("/").at(-1)) { spy.mockImplementation(original); throw new Error("crash before G1 copy"); }
      return original(repository, directory, signal);
    });
    const id = await f.submit(), job = f.service.state().jobs[0]!;
    expect(job.groups.map(g => g.state)).toEqual(["failed", "pr_opened"]);
    await f.action(id, job.groups[0]!.id, "retry"); await f.service.idle();
    expect((await f.calls()).filter(c => c.stage === "evaluate")).toHaveLength(1); expect(f.posts).toHaveLength(2);
  });
  it("on restart only the active G2 becomes interrupted and the persisted plan is reused", async () => {
    const f = await fixture(["one", "FAIL", "three"]), id = await f.submit(); await f.service.close();
    const path = join(f.root, "local-review/ledger.json"), data = JSON.parse(await readFile(path, "utf8"));
    data.jobs[0].state = "running_groups"; data.jobs[0].groups[1].state = "fixing";
    await writeFile(path, JSON.stringify(data));
    const restarted = f.createService(); await restarted.start(); dispose.push(() => restarted.close());
    expect(restarted.state().jobs[0]!.groups.map(g => g.state)).toEqual(["pr_opened", "interrupted", "pr_opened"]);
    await restarted.action({ repositoryId: f.repositoryId, jobId: id, groupId: data.jobs[0].groups[1].id, action: "retry" }); await restarted.idle();
    expect(restarted.state().jobs[0]!.groups.every(g => g.state === "pr_opened")).toBe(true);
    expect((await f.calls()).filter(c => c.stage === "evaluate")).toHaveLength(1); expect(f.posts).toHaveLength(3);
  });
  it("stops before side effects when ledger persistence fails", async () => {
    const f = await fixture(["one"]);
    const ledger = join(f.root, "local-review/ledger.json"); await rm(ledger); await mkdir(ledger);
    await expect(f.service.submit(f.repositoryId, f.sessionId, "fixture")).rejects.toThrow();
    expect(f.posts).toHaveLength(0); expect(f.runner.pushes).toBe(0);
    await rm(ledger, { recursive: true });
    // close correctly reports the original persistence failure; the normal fixture disposer must not mask it.
    vi.spyOn(f.service, "close").mockResolvedValue();
  });
});

// ---------------------------------------------------------------------------------------------------------------- task conversation
type Plan = { target: { kind: "existing"; groupId: string } | { kind: "new"; title: string }; annotationIds: string[]; requirements: string; expectedChanges: string; reason: string };
async function conversation(bodies = ["修复 a"]) {
  const f = await fixture(bodies);
  const script = { answer: (_request: DiscussionRequest): { reply: string; plan: Plan | null } => ({ reply: "已核实。", plan: null }), requests: [] as DiscussionRequest[], views: [] as string[], fixExtras: [] as Array<{ append: boolean; context: string } | undefined>, fixCalls: 0, fixContent: "after\n", appendContent: "after-append\n", verification: "未运行测试：合成工程没有测试命令。", hang: false, hangNew: false, groupFile: null as string | null, discussCopies: [] as string[] };
  const factory = vi.spyOn(reviewWorkers, "createLocalReviewWorker").mockImplementation(() => ({
    capability: async () => undefined,
    evaluate: async (_copy, annotations) => reviewEvaluation({ verdicts: annotations.map(a => ({ id: a.id, verdict: "accept", reason: "valid" })), groups: annotations.map(a => ({ title: "one", annotationIds: [a.id], reason: "same" })) }, annotations.map(a => a.id)),
    fix: async (copy, annotations, signal, extra) => {
      script.fixCalls++; script.fixExtras.push(extra);
      if ((script.hang && extra?.append) || (script.hangNew && extra && !extra.append)) await new Promise<void>((_, reject) => signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
      const target = annotations[0]?.path ?? "file0.txt"; await writeFile(join(copy.tree, target), extra?.append ? script.appendContent : script.fixContent);
      return reviewFix({ changedFiles: [target], outcomes: annotations.map(a => ({ id: a.id, outcome: "fixed", summary: "已修复" })), commitTitle: "追加修复", verification: script.verification }, annotations.map(a => a.id));
    },
    discuss: async (view, request) => {
      script.requests.push(request); script.discussCopies.push(view.tree);
      script.views = (await readdir(view.tree, { recursive: true })).map(String).sort();
      script.groupFile = await readFile(join(view.tree, "group-1/file0.txt"), "utf8").catch(() => null);
      return script.answer(request);
    },
  }));
  dispose.push(async () => factory.mockRestore());
  const id = await f.submit(), job = () => f.service.state().jobs[0]!;
  const ask = async (body: string, references: Array<{ kind: "annotation" | "group"; id: string }> = []) => { const turn = await f.service.sendMessage({ repositoryId: f.repositoryId, jobId: id, body, references }); await f.service.idle(); return turn; };
  const planMessage = () => job().conversation.messages.filter(m => m.plan).at(-1)!;
  const execute = async (messageId = planMessage().id) => { const executionId = await f.service.execute({ repositoryId: f.repositoryId, jobId: id, messageId }); await f.service.idle(); return executionId; };
  const existingPlan = (): Plan => ({ target: { kind: "existing", groupId: job().groups[0]!.id }, annotationIds: [job().annotations[0]!.id], requirements: "补充超时场景", expectedChanges: "追加一个提交", reason: "同一根因" });
  const remoteBranch = () => job().groups[0]!.branch;
  // first-parent history of the PR branch: the fixture base commit, the group commit, then appended commits
  const remoteLog = () => f.git("--git-dir", f.bare, "log", "--first-parent", "--format=%H %P", remoteBranch()).split("\n").map(line => line.split(" "));
  return { f, id, job, script, ask, planMessage, execute, existingPlan, remoteLog, remoteBranch };
}

describe("task conversation", () => {
  it("answers in a read-only view of the fixed commit and every published group, then removes the view", async () => {
    const c = await conversation(); expect(c.job().groups[0]!.state).toBe("pr_opened");
    c.script.answer = () => ({ reply: "这是**回答**", plan: null });
    await c.ask("为什么这样判断？", [{ kind: "annotation", id: c.job().annotations[0]!.id }]);
    const [user, worker] = c.job().conversation.messages;
    expect(user).toMatchObject({ role: "user", seq: 1, body: "为什么这样判断？" }); expect(worker).toMatchObject({ role: "worker", seq: 2, body: "这是**回答**" });
    expect(c.job().turns[0]).toMatchObject({ state: "answered" });
    expect(c.script.views).toEqual(expect.arrayContaining(["base", "base/file0.txt", "group-1", "group-1/file0.txt"]));
    expect((await readFile(join(c.script.discussCopies[0]!, "group-1/file0.txt"), "utf8").catch(() => "gone"))).toBe("gone");
    expect(await readdir(join(c.f.service.jobsRoot, c.id))).not.toEqual(expect.arrayContaining([expect.stringMatching(/^turn-/u)]));
    expect(c.script.requests[0]!.input).toContain("为什么这样判断？"); expect(c.script.requests[0]!.input).not.toContain("credentialHelpers");
    expect(c.script.fixCalls).toBe(1); expect(await bytes(c.f.repo)).toEqual(c.f.before);
  });
  it("reports an unsafe group view and never sends a partial view to the worker", async () => {
    const c = await conversation(), checkout = c.f.runner.checkoutView.bind(c.f.runner);
    vi.spyOn(c.f.runner, "checkoutView").mockImplementation(async (...args) => {
      if (args[2].endsWith("group-1")) throw new ReviewViewError("读视图条目大小写折叠后重名：A / a");
      return checkout(...args);
    });
    await c.ask("看看这个组");
    expect(c.job().turns[0]).toMatchObject({ state: "failed", error: expect.stringContaining("大小写折叠后重名") });
    expect(c.script.requests).toHaveLength(0);
    expect(c.job().conversation.messages.at(-1)!.body).toContain("大小写折叠后重名");
  });
  it("removes a partial group view after an ordinary checkout error before discussion", async () => {
    const c = await conversation(), checkout = c.f.runner.checkoutView.bind(c.f.runner);
    vi.spyOn(c.f.runner, "checkoutView").mockImplementation(async (...args) => {
      if (!args[2].endsWith("group-1")) return checkout(...args);
      await mkdir(args[2], { recursive: true }); await writeFile(join(args[2], "partial.txt"), "INCOMPLETE-VIEW");
      throw Object.assign(new Error("synthetic path too long"), { code: "ENAMETOOLONG" });
    });
    await c.ask("查看已有组");
    expect(c.job().turns[0]!.state).toBe("answered");
    expect(c.script.requests[0]!.viewNotes).toContain("不可用");
    expect(c.script.views.some(path => path === "group-1" || path.startsWith("group-1/"))).toBe(false);
  });
  it("refuses partial-view cleanup outside the current turn and never calls the worker", async () => {
    const c = await conversation(), checkout = c.f.runner.checkoutView.bind(c.f.runner), outside = join(c.f.root, "outside-view");
    await mkdir(outside); await writeFile(join(outside, "file0.txt"), "OUTSIDE-CANARY");
    vi.spyOn(c.f.runner, "checkoutView").mockImplementation(async (...args) => {
      if (!args[2].endsWith("group-1")) return checkout(...args);
      await symlink(outside, args[2]); throw Object.assign(new Error("synthetic checkout failure"), { code: "ENAMETOOLONG" });
    });
    await c.ask("查看已有组");
    expect(c.job().turns[0]).toMatchObject({ state: "failed", error: expect.stringContaining("清理路径") });
    expect(c.script.requests).toHaveLength(0);
    expect(await readFile(join(outside, "file0.txt"), "utf8")).toBe("OUTSIDE-CANARY");
  });
  it("tracks reading by rendered sequence, not by time", async () => {
    const c = await conversation(); await c.ask("问题一");
    await c.f.service.markRead({ repositoryId: c.f.repositoryId, jobId: c.id, seq: 1 });
    expect(c.job().conversation.readSeq).toBe(1);
    await c.f.service.markRead({ repositoryId: c.f.repositoryId, jobId: c.id, seq: 999 });
    expect(c.job().conversation.readSeq).toBe(c.job().conversation.nextSeq - 1);
    await c.f.service.markRead({ repositoryId: c.f.repositoryId, jobId: c.id, seq: 0 });
    expect(c.job().conversation.readSeq).toBe(c.job().conversation.nextSeq - 1);
  });
  it("never executes a plan until it is explicitly executed, and a double click executes once", async () => {
    const c = await conversation(); c.script.answer = () => ({ reply: "建议追加", plan: c.existingPlan() });
    await c.ask("按这个改"); expect(c.planMessage().plan).toMatchObject({ executable: true, planBaseOid: c.job().groups[0]!.artifact!.commitOid });
    expect(c.script.fixCalls).toBe(1); expect(c.job().executions).toEqual([]); expect(c.remoteLog()).toHaveLength(2);
    const [first, second] = await Promise.all([c.f.service.execute({ repositoryId: c.f.repositoryId, jobId: c.id, messageId: c.planMessage().id }), c.f.service.execute({ repositoryId: c.f.repositoryId, jobId: c.id, messageId: c.planMessage().id })]);
    await c.f.service.idle(); expect(second).toBe(first); expect(c.job().executions).toHaveLength(1); expect(c.script.fixCalls).toBe(2);
  });
  it("appends a fast-forward commit with a lease on the recorded OID and posts the verbatim verification as a comment", async () => {
    const c = await conversation(); const before = c.job().groups[0]!.artifact!.commitOid;
    c.script.answer = () => ({ reply: "追加", plan: c.existingPlan() }); c.script.appendContent = "after-2\n"; c.script.verification = "npm test：通过\n含 emoji-free 原话 𝒳";
    await c.ask("请追加"); const executionId = await c.execute();
    const log = c.remoteLog(); expect(log).toHaveLength(3); expect(log[0]![1]).toBe(before);
    const group = c.job().groups[0]!; expect(group.artifact!.commitOid).toBe(log[0]![0]); expect(group.commits.map(x => x.oid)).toEqual([before, log[0]![0]]); expect(group.commits[1]!.executionId).toBe(executionId);
    expect(c.job().executions[0]).toMatchObject({ state: "done", pushed: true, comment: { published: true } });
    expect(c.f.comments).toHaveLength(1); const body = c.f.comments[0]!.body;
    expect(body.split("\n")).toEqual(expect.arrayContaining([`Paraself 执行 ID：${executionId}`, `提交：${log[0]![0]}`])); expect(body).toContain("npm test：通过\n含 emoji-free 原话 𝒳");
    expect(c.script.fixExtras.at(-1)).toMatchObject({ append: true }); expect(c.script.fixExtras.at(-1)!.context).toContain("补充超时场景");
    const last = c.job().conversation.messages.at(-1)!; expect(last).toMatchObject({ role: "system", event: "execution_done", executionId }); expect(last.body).toContain("npm test：通过");
    expect(await readdir(join(c.f.service.jobsRoot, c.id))).not.toEqual(expect.arrayContaining([`exec-${executionId}`]));
    expect(c.f.git("--git-dir", c.f.bare, "show", `${c.remoteBranch()}:file0.txt`)).toBe("after-2");
  });
  it("marks the execution remote_changed and overwrites nothing when the remote branch moved", async () => {
    const c = await conversation(); c.script.answer = () => ({ reply: "追加", plan: c.existingPlan() }); await c.ask("追加");
    const branch = c.remoteBranch(), tree = c.f.git("--git-dir", c.f.bare, "rev-parse", `${branch}^{tree}`), parent = c.f.git("--git-dir", c.f.bare, "rev-parse", branch);
    const moved = c.f.git("--git-dir", c.f.bare, "-c", "user.name=x", "-c", "user.email=x@example.invalid", "commit-tree", tree, "-p", parent, "-m", "someone else"); c.f.git("--git-dir", c.f.bare, "update-ref", `refs/heads/${branch}`, moved);
    await c.execute(); expect(c.f.git("--git-dir", c.f.bare, "rev-parse", branch)).toBe(moved);
    expect(c.job().executions[0]).toMatchObject({ state: "remote_changed", pushed: false }); expect(c.job().groups[0]!.artifact!.commitOid).toBe(parent);
    expect(c.job().conversation.messages.at(-1)!).toMatchObject({ event: "execution_remote_changed" }); expect(c.f.comments).toHaveLength(0);
    await expect(c.f.service.conversationAction({ repositoryId: c.f.repositoryId, jobId: c.id, action: "retry_execution", executionId: c.job().executions[0]!.id })).rejects.toThrow();
  });
  it("recovers a lost push receipt without pushing twice", async () => {
    const c = await conversation(); c.script.answer = () => ({ reply: "追加", plan: c.existingPlan() }); await c.ask("追加"); c.f.runner.lostPush = true; const pushes = c.f.runner.pushes;
    await c.execute(); expect(c.f.runner.pushes).toBe(pushes + 1); expect(c.job().executions[0]).toMatchObject({ state: "done", pushed: true }); expect(c.remoteLog()).toHaveLength(3);
  });
  it("reports a failed comment honestly, keeps the original text, and retries by looking before sending", async () => {
    const c = await conversation(); c.script.answer = () => ({ reply: "追加", plan: c.existingPlan() }); await c.ask("追加");
    c.f.platform.commentStatus = 500; await c.execute(); const execution = c.job().executions[0]!;
    expect(execution).toMatchObject({ state: "done_comment_failed", pushed: true, comment: { published: false } }); expect(execution.comment!.body).toContain(`Paraself 执行 ID：${execution.id}`);
    const message = c.job().conversation.messages.at(-1)!; expect(message.body).toContain("评论没有发布"); expect(message.body).toContain(execution.comment!.body);
    c.f.platform.commentStatus = 0; c.f.platform.loseCommentReply = true;
    await c.f.service.conversationAction({ repositoryId: c.f.repositoryId, jobId: c.id, action: "retry_comment", executionId: execution.id }); await c.f.service.idle();
    expect(c.f.comments).toHaveLength(1); expect(c.job().executions[0]!.state).toBe("done_comment_failed");
    await c.f.service.conversationAction({ repositoryId: c.f.repositoryId, jobId: c.id, action: "retry_comment", executionId: execution.id }); await c.f.service.idle();
    expect(c.f.comments).toHaveLength(1); expect(c.job().executions[0]).toMatchObject({ state: "done", comment: { published: true } });
    expect(c.job().conversation.messages.filter(m => m.executionId === execution.id).map(m => m.event)).toEqual(["execution_started", "execution_done_comment_failed", "execution_done_comment_failed", "execution_done"]);
  });
  it("does not count a comment that quotes an old identifier or other commit as the receipt", async () => {
    const c = await conversation(); c.script.answer = () => ({ reply: "追加", plan: c.existingPlan() }); await c.ask("追加");
    c.f.platform.commentStatus = 500; await c.execute(); const execution = c.job().executions[0]!;
    c.f.comments.push({ id: 99, body: `引用：Paraself 执行 ID：${execution.id} 但是\n提交：${"0".repeat(40)}`, created_at: new Date().toISOString(), user: { login: "x" } });
    c.f.platform.commentStatus = 0;
    await c.f.service.conversationAction({ repositoryId: c.f.repositoryId, jobId: c.id, action: "retry_comment", executionId: execution.id }); await c.f.service.idle();
    expect(c.f.comments).toHaveLength(2); expect(c.job().executions[0]!.state).toBe("done");
  });
  it("never blind-posts when the comment cannot be read", async () => {
    const c = await conversation(); c.script.answer = () => ({ reply: "追加", plan: c.existingPlan() }); await c.ask("追加");
    c.f.platform.commentStatus = 500; await c.execute(); const execution = c.job().executions[0]!; c.f.platform.commentStatus = 0;
    const read = vi.spyOn(PrConnections.prototype, "client").mockImplementation(async () => ({ commentPages: async () => ({ comments: [], more: true }), currentCommits: async () => { throw new Error("must not be reached"); }, publishGeneralComment: async () => { throw new Error("must not post"); } }) as never);
    try { await c.f.service.conversationAction({ repositoryId: c.f.repositoryId, jobId: c.id, action: "retry_comment", executionId: execution.id }); await c.f.service.idle(); } finally { read.mockRestore(); }
    expect(c.job().executions[0]).toMatchObject({ state: "done_comment_failed" }); expect(c.job().executions[0]!.comment!.error).toContain("没有读完"); expect(c.f.comments).toHaveLength(0);
  });
  it("keeps verification verbatim: an over-long comment is not cut, not sent, and stays recoverable", async () => {
    const c = await conversation(); c.script.answer = () => ({ reply: "追加", plan: c.existingPlan() }); c.script.verification = "长".repeat(12000); await c.ask("追加"); await c.execute();
    const execution = c.job().executions[0]!; expect(execution).toMatchObject({ state: "done_comment_failed", pushed: true }); expect(execution.comment!.body).toContain("长".repeat(12000)); expect(c.f.comments).toHaveLength(0);
    expect(c.job().conversation.messages.at(-1)!.body).toContain("长".repeat(12000)); expect(c.remoteLog()).toHaveLength(3);
  });
  it("runs a new group through the normal pipeline, opens its own PR and reports back in the conversation", async () => {
    const c = await conversation(); c.script.answer = () => ({ reply: "新建一组", plan: { target: { kind: "new", title: "补充测试" }, annotationIds: [c.job().annotations[0]!.id], requirements: "只加测试", expectedChanges: "新增测试文件", reason: "独立" } });
    await c.ask("另起一组"); await c.execute();
    const job = c.job(); expect(job.groups).toHaveLength(2); expect(job.groups[1]).toMatchObject({ origin: "conversation", title: "补充测试", requirements: "只加测试", state: "pr_opened", ordinal: 2 });
    expect(job.groups[1]!.branch).toBe(`paraself/review-${c.id}-2`); expect(c.f.pulls).toHaveLength(2); expect(job.state).toBe("finished");
    expect(job.executions[0]).toMatchObject({ kind: "new", state: "done" }); expect(c.script.fixExtras.at(-1)).toMatchObject({ append: false }); expect(c.script.fixExtras.at(-1)!.context).toContain("只加测试");
    expect(job.conversation.messages.at(-1)).toMatchObject({ role: "system", event: "execution_done" });
  });
  it("blocks secret-shaped additions and never repeats the fix text in the conversation or the context", async () => {
    const c = await conversation(); c.script.answer = () => ({ reply: "追加", plan: c.existingPlan() }); c.script.appendContent = "sk-ant-secret-value\n"; c.script.verification = "VERIFY-LEAK sk-ant-secret-value";
    await c.ask("追加"); const tip = c.f.git("--git-dir", c.f.bare, "rev-parse", c.remoteBranch()); await c.execute();
    expect(c.job().executions[0]).toMatchObject({ state: "blocked" }); expect(c.f.git("--git-dir", c.f.bare, "rev-parse", c.remoteBranch())).toBe(tip);
    const visible = JSON.stringify(c.f.service.state().jobs[0]!.conversation) + JSON.stringify(c.f.service.state().jobs[0]!.executions);
    expect(visible).not.toContain("sk-ant-secret-value"); expect(visible).not.toContain("VERIFY-LEAK");
    await expect(c.f.service.conversationAction({ repositoryId: c.f.repositoryId, jobId: c.id, action: "approve_execution", executionId: c.job().executions[0]!.id })).rejects.toThrow();
    await c.f.service.conversationAction({ repositoryId: c.f.repositoryId, jobId: c.id, action: "discard_execution", executionId: c.job().executions[0]!.id });
    expect(c.job().executions[0]).toMatchObject({ state: "cancelled" }); expect(c.job().groups[0]!.state).toBe("pr_opened");
  });
  it("requires its own authorization for risky appended files, bound to the new commit", async () => {
    const c = await conversation(); c.script.answer = () => ({ reply: "追加", plan: c.existingPlan() }); await c.ask("追加");
    const git = c.f.runner as unknown as { commit: LocalReviewGit["commit"] }; const original = git.commit.bind(c.f.runner);
    const spy = vi.spyOn(c.f.runner, "commit").mockImplementation(async (copy, repository, title, files, signal) => { await mkdir(join(copy.tree, ".github/workflows"), { recursive: true }); await writeFile(join(copy.tree, ".github/workflows/ci.yml"), "on: push\n"); return original(copy, repository, title, [...files, ".github/workflows/ci.yml"], signal); });
    try { await c.execute(); } finally { spy.mockRestore(); }
    const execution = c.job().executions[0]!; expect(execution).toMatchObject({ state: "blocked", pushed: false }); expect(c.remoteLog()).toHaveLength(2);
    const authorization = { executionId: execution.id, groupId: execution.groupId, commitOid: execution.newCommitOid!, planBaseOid: execution.planBaseOid!, risks: execution.artifact!.risks, pushUrl: c.job().pushUrl };
    await expect(c.f.service.conversationAction({ repositoryId: c.f.repositoryId, jobId: c.id, action: "approve_execution", executionId: execution.id, authorization: { ...authorization, commitOid: "1".repeat(40) } })).rejects.toThrow("变化");
    await c.f.service.conversationAction({ repositoryId: c.f.repositoryId, jobId: c.id, action: "approve_execution", executionId: execution.id, authorization }); await c.f.service.idle();
    expect(c.job().executions[0]).toMatchObject({ state: "done", pushed: true }); expect(c.remoteLog()).toHaveLength(3);
  });
  it("rejects stale or invalid plans, and the 17th group, before any intent", async () => {
    const c = await conversation(); c.script.answer = () => ({ reply: "追加", plan: { ...c.existingPlan(), annotationIds: [randomUUID()] } });
    await c.ask("坏方案"); expect(c.planMessage().plan).toMatchObject({ executable: false, invalidReason: expect.stringContaining("不存在的意见") });
    await expect(c.execute()).rejects.toThrow("不存在的意见"); expect(c.job().executions).toEqual([]);
    c.script.answer = () => ({ reply: "空", plan: { ...c.existingPlan(), annotationIds: [], requirements: "" } }); await c.ask("空方案"); expect(c.planMessage().plan!.executable).toBe(false);
    c.script.answer = () => ({ reply: "未知组", plan: { ...c.existingPlan(), target: { kind: "existing", groupId: randomUUID() } } }); await c.ask("未知组"); expect(c.planMessage().plan!.invalidReason).toContain("组不存在");
    c.script.answer = () => ({ reply: "好", plan: c.existingPlan() }); await c.ask("好方案"); const stale = c.planMessage().id; await c.execute(stale);
    c.script.answer = () => ({ reply: "又", plan: c.existingPlan() }); await c.ask("再来"); const second = c.planMessage().id;
    await c.f.service.close(); const path = join(c.f.root, "local-review/ledger.json"), ledger = JSON.parse(await readFile(path, "utf8")); ledger.jobs[0].conversation.messages.find((m: { id: string }) => m.id === stale).plan.planBaseOid = "2".repeat(40); await writeFile(path, JSON.stringify(ledger));
    const again = c.f.createService(); await again.start(); dispose.push(() => again.close());
    await expect(again.execute({ repositoryId: c.f.repositoryId, jobId: c.id, messageId: second })).resolves.toBeTruthy();
  });
  it("accepts replies and results past the 400-message soft gate but refuses new user messages", async () => {
    const c = await conversation(); await c.f.service.close(); const path = join(c.f.root, "local-review/ledger.json"), ledger = JSON.parse(await readFile(path, "utf8")), conversation_ = ledger.jobs[0].conversation;
    for (let i = 1; i <= 399; i++) conversation_.messages.push({ id: randomUUID(), seq: i, role: "system", createdAt: new Date().toISOString(), body: `填充 ${i}`, references: [], turnId: null });
    conversation_.nextSeq = 400; conversation_.readSeq = 399; await writeFile(path, JSON.stringify(ledger));
    const service = c.f.createService(); await service.start(); dispose.push(() => service.close());
    const send = (body: string) => service.sendMessage({ repositoryId: c.f.repositoryId, jobId: c.id, body, references: [] });
    c.script.answer = () => ({ reply: "门槛后的回答", plan: c.existingPlan() }); await send("第 400 条"); await service.idle();
    const messages = service.state().jobs[0]!.conversation.messages; expect(messages).toHaveLength(401); expect(messages.at(-1)).toMatchObject({ role: "worker", body: "门槛后的回答" });
    await expect(send("第 402 条")).rejects.toThrow("400");
    const messageId = messages.at(-1)!.id; await service.execute({ repositoryId: c.f.repositoryId, jobId: c.id, messageId }); await service.idle();
    expect(service.state().jobs[0]!.conversation.messages.at(-1)).toMatchObject({ role: "system", event: "execution_done" });
  });
  it("marks interrupted turns and executions on restart and keeps every failure continuable", async () => {
    const c = await conversation(); c.script.answer = () => { throw new Error("模型不可用"); };
    await c.ask("会失败"); expect(c.job().turns[0]).toMatchObject({ state: "failed" }); expect(c.job().conversation.messages.at(-1)).toMatchObject({ role: "system", event: "turn_failed" });
    c.script.answer = () => ({ reply: "重试成功", plan: null });
    await c.f.service.conversationAction({ repositoryId: c.f.repositoryId, jobId: c.id, action: "retry_turn", turnId: c.job().turns[0]!.id }); await c.f.service.idle();
    expect(c.job().turns[0]).toMatchObject({ state: "answered", attempts: 2 }); expect(c.job().conversation.messages.at(-1)).toMatchObject({ role: "worker", body: "重试成功" });
    await c.f.service.close(); const path = join(c.f.root, "local-review/ledger.json"), ledger = JSON.parse(await readFile(path, "utf8"));
    ledger.jobs[0].turns[0].state = "running"; await writeFile(path, JSON.stringify(ledger));
    const service = c.f.createService(); await service.start(); dispose.push(() => service.close());
    expect(service.state().jobs[0]!.turns[0]).toMatchObject({ state: "interrupted" }); expect(service.state().jobs[0]!.conversation.messages.at(-1)).toMatchObject({ event: "turn_interrupted" });
  });
  it("cancels a queued turn and a pending execution", async () => {
    const c = await conversation(); c.script.answer = () => ({ reply: "追加", plan: c.existingPlan() }); await c.ask("追加");
    await c.f.service.close(); const path = join(c.f.root, "local-review/ledger.json"), ledger = JSON.parse(await readFile(path, "utf8")), planned = ledger.jobs[0].conversation.messages.find((m: { plan?: unknown }) => m.plan);
    const turnId = randomUUID(), userId = randomUUID(); ledger.jobs[0].conversation.messages.push({ id: userId, seq: ledger.jobs[0].conversation.nextSeq++, role: "user", createdAt: new Date().toISOString(), body: "排队", references: [], turnId });
    ledger.jobs[0].turns.push({ id: turnId, userMessageId: userId, state: "queued", attemptId: randomUUID(), attempts: 1, error: null, stats: null });
    const executionId = randomUUID(), now = new Date().toISOString(); ledger.jobs[0].executions.push({ id: executionId, messageId: planned.id, turnId: planned.turnId, groupId: planned.plan.target.groupId, kind: "existing", planBaseOid: planned.plan.planBaseOid, annotationIds: planned.plan.annotationIds, requirements: "", expectedChanges: "x", state: "blocked", intent: null, attemptId: randomUUID(), attempts: 0, newCommitOid: null, fix: null, artifact: null, excludedFiles: [], pushed: false, comment: null, authorization: null, error: null, createdAt: now, updatedAt: now });
    await writeFile(path, JSON.stringify(ledger));
    const service = c.f.createService(); dispose.push(() => service.close());
    const calls = c.script.requests.length; await service.start(); await service.idle(); expect(c.script.requests.length).toBe(calls + 1);
    expect(service.state().jobs[0]!.turns.find(t => t.state === "queued")).toBeUndefined();
    await service.conversationAction({ repositoryId: c.f.repositoryId, jobId: c.id, action: "discard_execution", executionId });
    expect(service.state().jobs[0]!.executions[0]).toMatchObject({ state: "cancelled" });
  });
});

describe("task conversation recovery", () => {
  it("keeps a commit whose receipt was lost: the retry recovers it from Git and never calls the model again", async () => {
    const c = await conversation(); c.script.answer = () => ({ reply: "追加", plan: c.existingPlan() }); await c.ask("追加");
    const original = c.f.runner.commit.bind(c.f.runner); let once = true;
    vi.spyOn(c.f.runner, "commit").mockImplementation(async (...args) => { const artifact = await original(...args); if (once) { once = false; throw new Error("lost commit receipt after commit"); } return artifact; });
    const executionId = await c.f.service.execute({ repositoryId: c.f.repositoryId, jobId: c.id, messageId: c.planMessage().id }); await c.f.service.idle();
    expect(c.job().executions[0]).toMatchObject({ state: "failed", newCommitOid: expect.stringMatching(/^[a-f0-9]{40}$/u) }); const calls = c.script.fixCalls;
    await c.f.service.conversationAction({ repositoryId: c.f.repositoryId, jobId: c.id, action: "retry_execution", executionId }); await c.f.service.idle();
    expect(c.job().executions[0]).toMatchObject({ state: "done", pushed: true }); expect(c.script.fixCalls).toBe(calls); expect(c.remoteLog()).toHaveLength(3);
  });
  it("lets the next discussion read each appended commit, twice in a row", async () => {
    const c = await conversation(); c.script.answer = () => ({ reply: "追加", plan: c.existingPlan() });
    await c.ask("第一次"); c.script.appendContent = "v2\n"; await c.execute(); await c.ask("看看"); expect(c.script.groupFile).toBe("v2\n");
    c.script.appendContent = "v3\n"; await c.execute(); await c.ask("再看"); expect(c.script.groupFile).toBe("v3\n");
    expect(c.job().groups[0]!.commits).toHaveLength(3);
  });
  it("refuses group actions while an append is queued for it and does not run a plan whose group changed", async () => {
    const c = await conversation(); c.script.answer = () => ({ reply: "追加", plan: c.existingPlan() }); await c.ask("追加");
    await c.f.service.close(); const path = join(c.f.root, "local-review/ledger.json"), ledger = JSON.parse(await readFile(path, "utf8")), planned = ledger.jobs[0].conversation.messages.find((m: { plan?: unknown }) => m.plan), now = new Date().toISOString();
    const entry = (state: string, planBaseOid: string) => ({ id: randomUUID(), messageId: planned.id, turnId: planned.turnId, groupId: planned.plan.target.groupId, kind: "existing", planBaseOid, annotationIds: planned.plan.annotationIds, requirements: "", expectedChanges: "x", state, intent: null, attemptId: randomUUID(), attempts: 0, newCommitOid: null, fix: null, artifact: null, excludedFiles: [], pushed: false, comment: null, authorization: null, error: null, createdAt: now, updatedAt: now });
    ledger.jobs[0].executions.push(entry("blocked", planned.plan.planBaseOid)); await writeFile(path, JSON.stringify(ledger));
    let service = c.f.createService(); await service.start(); await service.idle();
    for (const action of ["discard", "retry"] as const) await expect(service.action({ repositoryId: c.f.repositoryId, jobId: c.id, groupId: planned.plan.target.groupId, action })).rejects.toThrow("待处理的追加执行");
    await service.close();
    const stale = JSON.parse(await readFile(path, "utf8")); stale.jobs[0].executions = [entry("pending", "9".repeat(40))]; await writeFile(path, JSON.stringify(stale));
    service = c.f.createService(); await service.start(); dispose.push(() => service.close()); await service.idle(); const calls = c.script.fixCalls;
    expect(service.state().jobs[0]!.executions[0]).toMatchObject({ state: "failed", error: "方案已过期" }); expect(c.script.fixCalls).toBe(calls); expect(c.remoteLog()).toHaveLength(2);
  });
  it("cancelling the job cancels its queued append", async () => {
    const c = await conversation(); c.script.answer = () => ({ reply: "追加", plan: c.existingPlan() }); await c.ask("追加");
    await c.f.service.close(); const path = join(c.f.root, "local-review/ledger.json"), ledger = JSON.parse(await readFile(path, "utf8")), planned = ledger.jobs[0].conversation.messages.find((m: { plan?: unknown }) => m.plan), now = new Date().toISOString();
    ledger.jobs[0].state = "queued"; ledger.jobs[0].planVersion = 1; ledger.jobs[0].selectedGroupIds = []; ledger.jobs[0].executions.push({ id: randomUUID(), messageId: planned.id, turnId: planned.turnId, groupId: planned.plan.target.groupId, kind: "existing", planBaseOid: planned.plan.planBaseOid, annotationIds: planned.plan.annotationIds, requirements: "", expectedChanges: "x", state: "pending", intent: null, attemptId: randomUUID(), attempts: 0, newCommitOid: null, fix: null, artifact: null, excludedFiles: [], pushed: false, comment: null, authorization: null, error: null, createdAt: now, updatedAt: now });
    await writeFile(path, JSON.stringify(ledger)); const service = c.f.createService(); dispose.push(() => service.close());
    const first = service.start(); await service.action({ repositoryId: c.f.repositoryId, jobId: c.id, action: "cancel" }).catch(() => undefined); await first; await service.idle();
    expect(["cancelled", "done"]).toContain(service.state().jobs[0]!.executions[0]!.state);
  });
  it("gives an over-long comment a stable outcome: bounded metadata, verbatim verification, no retry loop", async () => {
    const c = await conversation(); c.script.answer = () => ({ reply: "追加", plan: { ...c.existingPlan(), requirements: "要".repeat(4000), expectedChanges: "改".repeat(4000) } }); c.script.verification = "验".repeat(16000);
    await c.ask("追加"); const executionId = await c.execute(); const execution = c.job().executions[0]!;
    expect(execution).toMatchObject({ state: "done_comment_failed", pushed: true }); expect(execution.comment!.body.length).toBeLessThan(40000); expect(execution.comment!.body).toContain("验".repeat(16000)); expect(c.f.comments).toHaveLength(0);
    await expect(c.f.service.conversationAction({ repositoryId: c.f.repositoryId, jobId: c.id, action: "retry_comment", executionId })).rejects.toThrow("不能再重试");
    expect(c.job().conversation.messages.at(-1)!.body).toContain("验".repeat(16000));
  });

  it("cancels a running execution without touching the pushed PR, and keeps it continuable", async () => {
    const c = await conversation(); c.script.answer = () => ({ reply: "追加", plan: c.existingPlan() }); await c.ask("追加"); c.script.hang = true;
    const tip = c.f.git("--git-dir", c.f.bare, "rev-parse", c.remoteBranch());
    const executionId = await c.f.service.execute({ repositoryId: c.f.repositoryId, jobId: c.id, messageId: c.planMessage().id });
    for (let i = 0; i < 200 && c.job().executions[0]!.state !== "fixing"; i++) await new Promise(resolve => setTimeout(resolve, 25));
    expect(c.job().executions[0]!.state).toBe("fixing");
    await c.f.service.conversationAction({ repositoryId: c.f.repositoryId, jobId: c.id, action: "cancel_execution", executionId }); await c.f.service.idle();
    expect(c.job().executions[0]).toMatchObject({ state: "cancelled" }); expect(c.job().conversation.messages.filter(m => m.event === "execution_cancelled")).toHaveLength(1);
    expect(c.f.git("--git-dir", c.f.bare, "rev-parse", c.remoteBranch())).toBe(tip);
    c.script.hang = false; await c.f.service.conversationAction({ repositoryId: c.f.repositoryId, jobId: c.id, action: "retry_execution", executionId }); await c.f.service.idle();
    expect(c.job().executions[0]).toMatchObject({ state: "done", attempts: 1 });
  });
  it("runs an execution that was still pending when the app restarted, exactly once", async () => {
    const c = await conversation(); c.script.answer = () => ({ reply: "追加", plan: c.existingPlan() }); await c.ask("追加");
    await c.f.service.close(); const path = join(c.f.root, "local-review/ledger.json"), ledger = JSON.parse(await readFile(path, "utf8")), planned = ledger.jobs[0].conversation.messages.find((m: { plan?: unknown }) => m.plan), now = new Date().toISOString();
    ledger.jobs[0].executions.push({ id: randomUUID(), messageId: planned.id, turnId: planned.turnId, groupId: planned.plan.target.groupId, kind: "existing", planBaseOid: planned.plan.planBaseOid, annotationIds: planned.plan.annotationIds, requirements: "", expectedChanges: "x", state: "pending", intent: null, attemptId: randomUUID(), attempts: 0, newCommitOid: null, fix: null, artifact: null, excludedFiles: [], pushed: false, comment: null, authorization: null, error: null, createdAt: now, updatedAt: now });
    await writeFile(path, JSON.stringify(ledger));
    const service = c.f.createService(); await service.start(); dispose.push(() => service.close()); await service.idle();
    expect(service.state().jobs[0]!.executions[0]).toMatchObject({ state: "done" }); expect(c.remoteLog()).toHaveLength(3); expect(c.f.comments).toHaveLength(1);
  });
});

describe("task conversation hardening", () => {
  const inject = async (c: Awaited<ReturnType<typeof conversation>>, change: (ledger: any) => void) => {
    await c.f.service.close(); const path = join(c.f.root, "local-review/ledger.json"), ledger = JSON.parse(await readFile(path, "utf8")); change(ledger); await writeFile(path, JSON.stringify(ledger));
    const service = c.f.createService(); await service.start(); dispose.push(() => service.close()); return service;
  };
  const restartedNewGroup = async (c: Awaited<ReturnType<typeof conversation>>, groupState: string, attempts = 0) => {
    c.script.answer = () => ({ reply: "新组方案", plan: { target: { kind: "new", title: "恢复测试" }, annotationIds: [], requirements: "合成要求", expectedChanges: "更新文件", reason: "独立" } });
    await c.ask("新建一组");
    return inject(c, ledger => {
      const j = ledger.jobs[0], planned = j.conversation.messages.findLast((m: any) => m.plan), g = structuredClone(j.groups[0]), now = new Date().toISOString();
      Object.assign(g, { id: randomUUID(), ordinal: 2, branch: `paraself/review-${c.id}-2`, state: groupState, origin: "conversation", requirements: "合成要求", artifact: null, fix: null, pr: null, pushObservedSha: null, commits: [], intent: null, attemptId: randomUUID() });
      j.groups.push(g); j.state = groupState === "failed" ? "finished" : "running_groups"; j.selectedGroupIds = [g.id];
      j.executions.push({ id: randomUUID(), messageId: planned.id, turnId: planned.turnId, groupId: g.id, kind: "new", planBaseOid: null, annotationIds: [], requirements: "合成要求", expectedChanges: "更新文件", state: groupState === "opening_pr" ? "pushing" : groupState, intent: null, attemptId: randomUUID(), attempts, newCommitOid: null, fix: null, artifact: null, excludedFiles: [], pushed: false, comment: null, authorization: null, error: null, createdAt: now, updatedAt: now });
    });
  };
  it.each(["fixing", "committed", "pushing", "opening_pr"])("settles a new-group execution after restart from %s and allows discussion again", async phase => {
    const c = await conversation(), service = await restartedNewGroup(c, phase);
    const job = service.state().jobs[0]!, e = job.executions[0]!;
    expect(job.state).toBe("interrupted"); expect(job.groups[1]!.state).toBe("interrupted"); expect(e.state).toBe("interrupted");
    expect(job.conversation.messages.at(-1)).toMatchObject({ role: "system", executionId: e.id, event: "execution_interrupted" });
    c.script.answer = () => ({ reply: "可以继续讨论", plan: null });
    await service.sendMessage({ repositoryId: c.f.repositoryId, jobId: c.id, body: "现在能继续吗", references: [] }); await service.idle();
    expect(service.state().jobs[0]!.turns.at(-1)!.state).toBe("answered");
  });
  it("counts new-group retries and rejects the 21st through conversation and legacy group actions", async () => {
    const c = await conversation(), service = await restartedNewGroup(c, "failed", 19), e = service.state().jobs[0]!.executions[0]!;
    const prepare = vi.spyOn(c.f.runner, "prepare").mockRejectedValue(new Error("合成准备失败"));
    await service.conversationAction({ repositoryId: c.f.repositoryId, jobId: c.id, action: "retry_execution", executionId: e.id }); await service.idle();
    expect(service.state().jobs[0]!.executions[0]).toMatchObject({ attempts: 20, state: "failed" });
    const calls = prepare.mock.calls.length;
    await expect(service.conversationAction({ repositoryId: c.f.repositoryId, jobId: c.id, action: "retry_execution", executionId: e.id })).rejects.toThrow("不能再重试");
    await expect(service.action({ repositoryId: c.f.repositoryId, jobId: c.id, groupId: e.groupId, action: "retry" })).rejects.toThrow("不能再重试");
    expect(prepare.mock.calls).toHaveLength(calls);
  });
  it("never shows a group that hit the sensitive-shape scan to the model, and says why", async () => {
    const c = await conversation(); const service = await inject(c, ledger => { ledger.jobs[0].groups[0].artifact.secretFindings = [{ path: "file0.txt", line: 1 }]; });
    await service.sendMessage({ repositoryId: c.f.repositoryId, jobId: c.id, body: "看看", references: [] }); await service.idle();
    expect(c.script.views).not.toEqual(expect.arrayContaining(["group-1/file0.txt"])); expect(c.script.requests.at(-1)!.viewNotes).toContain("已隐藏"); expect(c.script.requests.at(-1)!.viewNotes).not.toContain("不可用");
  });
  it("lets a cancel win against a pump that already holds the pending execution, and against a queued turn", async () => {
    const c = await conversation(); c.script.answer = () => ({ reply: "追加", plan: c.existingPlan() }); await c.ask("追加"); c.script.hang = true;
    const tip = c.f.git("--git-dir", c.f.bare, "rev-parse", c.remoteBranch());
    const executionId = await c.f.service.execute({ repositoryId: c.f.repositoryId, jobId: c.id, messageId: c.planMessage().id });
    await c.f.service.conversationAction({ repositoryId: c.f.repositoryId, jobId: c.id, action: "cancel_execution", executionId }); await c.f.service.idle();
    expect(c.job().executions[0]).toMatchObject({ state: "cancelled" }); expect(c.job().conversation.messages.filter(m => m.event === "execution_cancelled")).toHaveLength(1);
    expect(c.f.git("--git-dir", c.f.bare, "rev-parse", c.remoteBranch())).toBe(tip); expect(c.job().executions[0]!.newCommitOid).toBeNull();
    c.script.answer = () => ({ reply: "不该保存", plan: null }); const turnId = await c.f.service.sendMessage({ repositoryId: c.f.repositoryId, jobId: c.id, body: "问", references: [] });
    await c.f.service.conversationAction({ repositoryId: c.f.repositoryId, jobId: c.id, action: "cancel_turn", turnId }); await c.f.service.idle();
    expect(c.job().turns.at(-1)).toMatchObject({ state: "cancelled" }); expect(c.job().conversation.messages.some(m => m.body === "不该保存")).toBe(false); expect(c.job().conversation.messages.filter(m => m.event === "turn_cancelled")).toHaveLength(1);
  });
  it("puts the requirements and expected changes of a conversation group into its PR description", async () => {
    const c = await conversation(); c.script.answer = () => ({ reply: "新组", plan: { target: { kind: "new", title: "仅按要求" }, annotationIds: [], requirements: "REQ-ONLY 只按这条要求改", expectedChanges: "EXPECTED-CHANGES 新增文件", reason: "独立" } });
    await c.ask("新组"); await c.execute(); const body = c.f.posts.at(-1)!.body as string;
    expect(body).toContain("REQ-ONLY 只按这条要求改"); expect(body).toContain("EXPECTED-CHANGES 新增文件"); expect(c.job().groups[1]).toMatchObject({ state: "pr_opened", annotationIds: [] });
  });
  it("cancelling one new-group execution leaves other pending groups, finished groups and the task alone", async () => {
    const c = await conversation(); await c.f.service.close();
    const service = await inject(c, ledger => { const old = structuredClone(ledger.jobs[0].groups[0]); Object.assign(old, { id: randomUUID(), ordinal: 2, title: "旧的待处理组", state: "pending", branch: `paraself/review-${c.id}-2`, artifact: null, fix: null, pr: null, pushObservedSha: null, commits: [], attemptId: randomUUID() }); ledger.jobs[0].groups.push(old); });
    void service; c.script.answer = () => ({ reply: "新组", plan: { target: { kind: "new", title: "新组" }, annotationIds: [c.job().annotations[0]!.id], requirements: "r", expectedChanges: "e", reason: "独立" } });
    // the helper's service is closed; drive the injected one directly
    await service.sendMessage({ repositoryId: c.f.repositoryId, jobId: c.id, body: "新组", references: [] }); await service.idle();
    const message = service.state().jobs[0]!.conversation.messages.filter(m => m.plan).at(-1)!; c.script.hangNew = true;
    const executionId = await service.execute({ repositoryId: c.f.repositoryId, jobId: c.id, messageId: message.id });
    for (let i = 0; i < 200 && service.state().jobs[0]!.groups.find(g => g.title === "新组")!.state !== "fixing"; i++) await new Promise(resolve => setTimeout(resolve, 25));
    await service.conversationAction({ repositoryId: c.f.repositoryId, jobId: c.id, action: "cancel_execution", executionId }); await service.idle();
    const job = service.state().jobs[0]!;
    expect(job.groups.map(g => [g.title, g.state])).toEqual([["one", "pr_opened"], ["旧的待处理组", "pending"], ["新组", "cancelled"]]); expect(job.executions[0]).toMatchObject({ state: "cancelled" }); expect(job.state).toBe("finished");
    expect(c.f.pulls).toHaveLength(1);
  });
  it("never posts when a comment entry could not be parsed, even if it carries the identifier", async () => {
    const c = await conversation(); c.script.answer = () => ({ reply: "追加", plan: c.existingPlan() }); await c.ask("追加");
    c.f.platform.commentStatus = 500; await c.execute(); const execution = c.job().executions[0]!; c.f.platform.commentStatus = 0;
    c.f.comments.push({ id: "not-a-number", body: `Paraself 执行 ID：${execution.id}\n提交：${execution.newCommitOid}`, created_at: new Date().toISOString(), user: { login: "x" } });
    await c.f.service.conversationAction({ repositoryId: c.f.repositoryId, jobId: c.id, action: "retry_comment", executionId: execution.id }); await c.f.service.idle();
    expect(c.f.comments).toHaveLength(1); expect(c.job().executions[0]).toMatchObject({ state: "done_comment_failed" }); expect(c.job().executions[0]!.comment!.error).toContain("无法解析");
  });
});

describe("ledger version 2", () => {
  const legacy = async () => {
    const c = await conversation(); await c.f.service.close(); const path = join(c.f.root, "local-review/ledger.json"), ledger = JSON.parse(await readFile(path, "utf8"));
    ledger.version = 1; for (const job of ledger.jobs) { delete job.conversation; delete job.turns; delete job.executions; for (const group of job.groups) { delete group.origin; delete group.requirements; delete group.commits; } }
    const raw = JSON.stringify(ledger); await writeFile(path, raw); return { c, path, raw, group: ledger.jobs[0].groups[0] };
  };
  it("migrates version 1 with a verbatim backup, fills new fields and keeps every old group", async () => {
    const { c, path, raw, group } = await legacy(); const service = c.f.createService(); await service.start(); dispose.push(() => service.close());
    expect(await readFile(join(c.f.root, "local-review/ledger.v1.bak.json"), "utf8")).toBe(raw);
    const migrated = JSON.parse(await readFile(path, "utf8")); expect(migrated.version).toBe(2);
    expect(service.state().version).toBe(1); const job = service.state().jobs[0]!;
    expect(job.groups[0]).toMatchObject({ id: group.id, origin: "evaluation", requirements: "", commits: [{ oid: group.artifact.commitOid, executionId: null }] });
    expect(job.conversation).toEqual({ messages: [], nextSeq: 1, readSeq: 0 }); expect(job.turns).toEqual([]);
  });
  it("stops without migrating when the backup cannot be made or an unrelated backup exists", async () => {
    const { c, path, raw } = await legacy(); await mkdir(join(c.f.root, "local-review/ledger.v1.bak.json"));
    const service = c.f.createService(); await expect(service.start()).rejects.toThrow("备份失败"); expect(await readFile(path, "utf8")).toBe(raw);
    await rm(join(c.f.root, "local-review/ledger.v1.bak.json"), { recursive: true }); await writeFile(join(c.f.root, "local-review/ledger.v1.bak.json"), "different old content");
    const second = c.f.createService(); await second.start(); dispose.push(() => second.close());
    expect(await readFile(join(c.f.root, "local-review/ledger.v1.bak.json"), "utf8")).toBe("different old content");
    expect(JSON.parse(await readFile(path, "utf8")).version).toBe(2); const extra = (await readdir(join(c.f.root, "local-review"))).filter(n => /^ledger\.v1\..+\.bak\.json$/u.test(n) && n !== "ledger.v1.bak.json");
    expect(extra).toHaveLength(1); expect(await readFile(join(c.f.root, "local-review", extra[0]!), "utf8")).toBe(raw);
  });
  it("rejects unknown fields in version 2 instead of silently stripping them, and an old reader rejects version 2", async () => {
    const c = await conversation(); await c.ask("你好"); await c.f.service.close(); const path = join(c.f.root, "local-review/ledger.json"), text = await readFile(path, "utf8"), ledger = JSON.parse(text);
    expect(legacyLedgerSchemaV1.safeParse(ledger).success).toBe(false);
    for (const mutate of [(l: any) => { l.jobs[0].conversation.messages[0].surprise = 1; }, (l: any) => { l.jobs[0].turns[0].surprise = 1; }, (l: any) => { l.jobs[0].groups[0].surprise = 1; }]) {
      const copy = structuredClone(ledger); mutate(copy); await writeFile(path, JSON.stringify(copy));
      const service = c.f.createService(); await expect(service.start()).rejects.toThrow("无法读取"); expect(JSON.parse(await readFile(path, "utf8"))).toEqual(copy);
    }
  });
});
