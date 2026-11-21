import { execFileSync, spawn } from "node:child_process";
import { randomUUID, createHash } from "node:crypto";
import { chmod, copyFile, lstat, mkdir, mkdtemp, open, readFile, readdir, realpath, readlink, rm, stat, symlink, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dependencyCacheKey, dependencyProxy, LocalReviewDependencies, REVIEW_DEPENDENCY_LIMITS } from "../src/main/local-review-dependencies.js";
import { LocalReviewGit, type ReviewCopy } from "../src/main/local-review-git.js";
import { ReviewCommandSandbox } from "../src/main/local-review-command-sandbox.js";
vi.mock("../src/main/login-shell-path.js", () => ({ loginShellPath: async (environment: NodeJS.ProcessEnv) => environment.PATH ?? "" }));
import { ReviewLaunchdLabels } from "../src/main/local-review-launchd.js";
beforeEach(()=>{vi.spyOn(ReviewLaunchdLabels.prototype,"snapshot").mockResolvedValue(["stable-host"]);});
const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const settings = { worker: "pi" as const, pushRemote: "origin", baseBranch: "main", reviewers: [] };
async function fixture(ignore = true, attack?: string) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "lr-deps-"))); roots.push(root);
  const repo = join(root, "source"); await mkdir(join(repo, "vendor/demo"), { recursive: true });
  const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
  const git = (...args: string[]) => execFileSync("/usr/bin/git", ["-c", "core.hooksPath=/dev/null", ...args], { cwd: repo, env, encoding: "utf8" }).trim();
  await writeFile(join(repo, "package.json"), JSON.stringify({ name: "fixture", version: "1.0.0", dependencies: { demo: "file:vendor/demo" }, scripts: { postinstall: "node -e \"require('node:fs').writeFileSync('node_modules/postinstall-ran','yes')\"" } }));
  await writeFile(join(repo, ".npmrc"), "install-links=true\naudit=false\nfund=false\n");
  await writeFile(join(repo, "vendor/demo/package.json"), JSON.stringify({ name: "demo", version: "1.0.0" }));
  await writeFile(join(repo, "package-lock.json"), JSON.stringify({ name: "fixture", version: "1.0.0", lockfileVersion: 3, packages: { "": { name: "fixture", version: "1.0.0", dependencies: { demo: "file:vendor/demo" }, hasInstallScript: true }, "node_modules/demo": { version: "1.0.0", resolved: "file:vendor/demo" } } }));
  if (attack) { const pkg=JSON.parse(await readFile(join(repo,"package.json"),"utf8"));pkg.scripts.postinstall="node attack.cjs";await writeFile(join(repo,"package.json"),JSON.stringify(pkg));await writeFile(join(repo,"attack.cjs"),attack); }
  if (ignore) await writeFile(join(repo, ".gitignore"), "node_modules/\n");
  git("init", "-b", "main"); git("config", "user.name", "Fixture"); git("config", "user.email", "fixture@example.invalid"); git("add", "."); git("commit", "-m", "fixture");
  const controlled = new LocalReviewGit("/usr/bin/git", env), snapshot = await controlled.inspect(repo);
  const manager = new LocalReviewDependencies(join(root, "dependencies"), controlled, { ...process.env, NPM_TOKEN: "synthetic-secret", PARASELF_CANARY: "synthetic-secret" }); await manager.start();
  let copies = 0, lastCopy: ReviewCopy | undefined;
  const createCopy = async (directory?: string) => { lastCopy=await controlled.prepare(snapshot, directory ?? join(root, `copy-${copies++}`));return lastCopy; };
  const id = randomUUID(), signal = new AbortController().signal;
  return { root, repo, manager, controlled, snapshot, createCopy, id, signal, git, get lastCopy(){return lastCopy;} };
}
it("keys include project, argv, scripts, content, node and platform, with stable file ordering", () => {
  const key = (id = "a", argv = ["npm", "ci"], scripts = true, files: Array<[string,string]> = [["lock", "h"]], node = "22", platform = "darwin-arm64") => dependencyCacheKey(id, argv, scripts, files, node, platform);
  const original = key();
  for (const other of [key("b"),key("a",["npm","install"]),key("a",["npm","ci"],false),key("a",["npm","ci"],true,[["lock","changed"]]),key("a",["npm","ci"],true,[["lock","h"]],"24"),key("a",["npm","ci"],true,[["lock","h"]],"22","linux-x64")]) expect(other).not.toBe(original);
  expect(key("a",[],true,[["b","2"],["a","1"]])).toBe(key("a",[],true,[["a","1"],["b","2"]]));
  expect(dependencyProxy({ MODEL_PROXY_URL: "http://127.0.0.1:7890" })).toBe("http://127.0.0.1:7890");
  expect(() => dependencyProxy({ MODEL_PROXY_URL: ["http://", "user:password@localhost"].join("") })).toThrow("无账号密码");
});
it("skips off, missing or conflicting lockfiles before creating a copy", async () => {
  const f = await fixture(); let created = 0;
  const create = async () => { created++; return f.createCopy(); };
  expect((await f.manager.prepare(f.id,f.snapshot,{...settings,dependencies:{mode:"off",argv:[],files:[],allowScripts:true}},create,f.signal)).summary).toContain("已关闭");
  expect(created).toBe(0);
  const files=vi.spyOn(f.controlled,"files").mockResolvedValue([]);
  expect((await f.manager.prepare(f.id,f.snapshot,settings,create,f.signal)).summary).toContain("唯一");
  files.mockResolvedValue(["package-lock.json","yarn.lock"].map(path=>({path,mode:path==="yarn.lock"?"100755":"100644",type:"blob",oid:"a".repeat(40)})));
  expect((await f.manager.prepare(f.id,f.snapshot,settings,create,f.signal)).summary).toContain("唯一");expect(created).toBe(0);files.mockRestore();
});
it("invalidates unmarked directories and evicts the oldest keys under the count and byte caps", async () => {
  const f = await fixture(), project = join(f.manager.root, f.id); await mkdir(join(project,"published"),{recursive:true});
  const invalid = join(project,"published","a".repeat(64)); await mkdir(invalid); await writeFile(join(invalid,"unfinished"),"x");
  for (let i=1;i<=4;i++) { const key=String(i).repeat(64), path=join(project,"published",key); await mkdir(join(path,"node_modules"),{recursive:true}); await writeFile(join(path,"complete.json"),JSON.stringify({version:2,key,bytes:0,lastUsed:i})); }
  await f.manager.prune(); expect(await readdir(join(project,"published"))).toEqual([2,3,4].map(i=>String(i).repeat(64)));
  const huge=join(project,"published","4".repeat(64),"node_modules","huge"); await writeFile(huge,""); await truncate(huge,REVIEW_DEPENDENCY_LIMITS.projectBytes+1);
  await f.manager.prune(); expect(await readdir(join(project,"published"))).not.toContain("4".repeat(64));
});
it("evicts by global LRU when aggregate storage exceeds 20 GiB", async () => {
  const f=await fixture();const ids:string[]=[];
  for(let i=0;i<5;i++){const id=randomUUID(),key=String(i+1).repeat(64),path=join(f.manager.root,id,"published",key);ids.push(id);await mkdir(join(path,"node_modules"),{recursive:true});await writeFile(join(path,"complete.json"),JSON.stringify({version:2,key,bytes:0,lastUsed:i}));const file=join(path,"node_modules/large");await writeFile(file,"");await truncate(file,4.5*1024**3);}
  await f.manager.prune();expect(await readdir(join(f.manager.root,ids[0]!,"published"))).toEqual([]);for(let i=1;i<5;i++)expect(await readdir(join(f.manager.root,ids[i]!,"published"))).toHaveLength(1);
});
it("degrades when the sandbox probe is unavailable and never starts an unsandboxed installer", async () => {
  const f=await fixture(),probe=vi.spyOn(ReviewCommandSandbox.prototype,"probe").mockResolvedValue(undefined);
  try{const result=await f.manager.prepare(f.id,f.snapshot,settings,f.createCopy,f.signal);expect(result.key).toBeUndefined();expect(result.summary).toContain("探测失败");}finally{probe.mockRestore();}
});
describe.skipIf(process.platform !== "darwin")("real installation sandbox", () => {
  it.each(["before","after"] as const)("refuses publication when the %s host label snapshot fails",async stage=>{
    const f=await fixture(), snapshots=vi.mocked(ReviewLaunchdLabels.prototype.snapshot);
    if(stage==="after")snapshots.mockResolvedValueOnce(["stable-host"]);
    snapshots.mockRejectedValueOnce(new Error("synthetic list failure"));
    const result=await f.manager.prepare(f.id,f.snapshot,settings,f.createCopy,f.signal);
    expect(result.key).toBeUndefined();expect(result.summary).toContain("launchd");expect(snapshots).toHaveBeenCalledTimes(stage==="before"?1:2);
    expect(await readdir(join(f.manager.root,f.id,"published"))).toEqual([]);
  });
  it("does not read a synthetic login HOME .npmrc or inherited npm userconfig", async () => {
    const f=await fixture(),login=join(f.root,"login-home"),runtime=join(login,".volta/tools/image/node",process.versions.node);await mkdir(dirname(runtime),{recursive:true});
    execFileSync("/bin/cp",["-c","-R",dirname(dirname(process.execPath)),runtime]);
    const config=join(login,".npmrc"),privateLedger=join(runtime,"fingerprint-ledger.json");await writeFile(config,"registry=http://127.0.0.1:1\n");await writeFile(privateLedger,"synthetic-host-secret");
    const root=join(f.manager.root,f.id);await mkdir(root);const sandbox=new ReviewCommandSandbox({...process.env,HOME:login,PATH:join(runtime,"bin")+":/usr/bin:/bin",npm_config_userconfig:config},{root,ledgerPath:privateLedger,controlDirectory:join(runtime,"install-controls")});await sandbox.probe(await f.createCopy());expect(sandbox.available,sandbox.reason??"").toBe(true);
    const result=await sandbox.run(["npm","config","get","registry"]);expect(result.exitCode,result.stderr).toBe(0);expect(result.stdout.trim()).toBe("https://registry.npmjs.org/");
    expect((await sandbox.run(["node","-e",`for(const file of ${JSON.stringify([config,privateLedger])})try{require('node:fs').readFileSync(file);process.exit(9)}catch{}`])).exitCode).toBe(0);
  });

  it("isolates project reads, synthetic HOME, keychain and listen while allowing outbound and sanitized proxy env", async () => {
    const f=await fixture(), copy=await f.createCopy(), a=join(f.manager.root,f.id), other=join(f.manager.root,randomUUID()); await mkdir(a);await mkdir(other);await writeFile(join(other,"canary"),"private");
    const sandbox=new ReviewCommandSandbox({...process.env,NPM_TOKEN:"secret",PARASELF_CANARY:"secret"},{root:a,proxy:"http://127.0.0.1:7890"}); await sandbox.probe(copy);expect(sandbox.available,sandbox.reason??"").toBe(true);
    const result=await sandbox.run(["node","-e",`const fs=require('node:fs');try{fs.readFileSync(${JSON.stringify(join(other,"canary"))});process.exit(9)}catch{};if(Object.keys(process.env).some(k=>/TOKEN|SECRET|KEY|PARASELF_CANARY/.test(k)))process.exit(10);if(process.env.HTTP_PROXY!=='http://127.0.0.1:7890')process.exit(11);console.log(process.env.HOME);`]);
    expect(result.exitCode).toBe(0);expect(result.stdout.trim()).toBe(join(a,"home"));
    await copyFile(resolve(`node_modules/@esbuild/darwin-${process.arch}/bin/esbuild`),join(copy.tree,"esbuild"));
    const go=await sandbox.run(["node","-e","console.log(require('node:child_process').execFileSync('./esbuild',['--version'],{encoding:'utf8'}))"]);expect(go.exitCode,go.stderr).toBe(0);expect(go.stdout).toMatch(/\d+\.\d+\.\d+/);
    const bcopy=await f.createCopy(), reverse=new ReviewCommandSandbox(process.env,{root:other});await reverse.probe(bcopy);expect(reverse.available,reverse.reason??"").toBe(true);await writeFile(join(a,"canary"),"private-a");
    expect((await reverse.run(["node","-e",`try{require('node:fs').readFileSync(${JSON.stringify(join(a,"canary"))});process.exit(9)}catch{}`])).exitCode).toBe(0);
  });
  it("installs once, skips on hit and gives independent writable group copies", async () => {
    const f=await fixture();const dep=await f.manager.prepare(f.id,f.snapshot,settings,f.createCopy,f.signal);expect(dep.key,dep.summary).toBeTruthy();expect(dep.summary).toContain("安装完成");
    const cached=join(f.manager.root,f.id,"published",dep.key!,"node_modules");expect(await readFile(join(cached,"postinstall-ran"),"utf8")).toBe("yes");
    const second=await f.manager.prepare(f.id,f.snapshot,settings,f.createCopy,f.signal);expect(second.summary).toContain("命中");expect(second.key).toBe(dep.key);
    const a=await f.createCopy(),b=await f.createCopy();expect(await f.manager.clone(f.id,dep,a,f.signal)).toContain("安装完成");const realRun=(await import("../src/main/model/cli/managed-child-process.js")).ManagedChildProcessRunner.prototype.run;
    const runner=vi.spyOn((await import("../src/main/model/cli/managed-child-process.js")).ManagedChildProcessRunner.prototype,"run").mockImplementation(function(this: import("../src/main/model/cli/managed-child-process.js").ManagedChildProcessRunner,request){if(request.executable==="/bin/cp")return Promise.reject(new Error("synthetic no clone support"));return realRun.call(this,request);});
    try{await f.manager.clone(f.id,dep,b,f.signal);}finally{runner.mockRestore();}
    expect((await lstat(join(b.tree,"node_modules/demo"))).isDirectory()).toBe(true);
    await writeFile(join(a.tree,"node_modules/postinstall-ran"),"changed");expect(await readFile(join(b.tree,"node_modules/postinstall-ran"),"utf8")).toBe("yes");expect(await readFile(join(cached,"postinstall-ran"),"utf8")).toBe("yes");
    await expect(f.manager.clear(f.id)).rejects.toThrow("正在使用");
    for(let i=0;i<3;i++){const key=String(i+1).repeat(64),path=join(f.manager.root,f.id,"published",key);await mkdir(join(path,"node_modules"),{recursive:true});await writeFile(join(path,"complete.json"),JSON.stringify({version:2,key,bytes:0,lastUsed:i}));}
    await f.manager.prune();expect((await readdir(join(f.manager.root,f.id,"published"))).filter(n=>/^[a-f0-9]{64}$/.test(n))).toHaveLength(4);
    f.manager.release(f.id);await f.manager.prune();expect((await readdir(join(f.manager.root,f.id,"published"))).filter(n=>/^[a-f0-9]{64}$/.test(n))).toHaveLength(3);
await f.manager.clear(f.id);expect(await readdir(f.manager.root)).toEqual([]);
  });
  it.each(["auto","custom"] as const)("invalidates %s cache when only root package.json changes", async mode => {
    const f=await fixture(),config={...settings,dependencies:{mode,argv:["npm","ci"],files:["package-lock.json"],allowScripts:true}};
    const before=await f.manager.prepare(f.id,f.snapshot,config,f.createCopy,f.signal);expect(before.key,before.summary).toBeTruthy();const lock=await readFile(join(f.repo,"package-lock.json"),"utf8");
    const pkg=JSON.parse(await readFile(join(f.repo,"package.json"),"utf8"));pkg.scripts.postinstall="node -e \"require('node:fs').writeFileSync('node_modules/postinstall-ran','new-script')\"";await writeFile(join(f.repo,"package.json"),JSON.stringify(pkg));f.git("add","package.json");f.git("commit","-m","change install script only");
    const snapshot=await f.controlled.inspect(f.repo),after=await f.manager.prepare(f.id,snapshot,config,directory=>f.controlled.prepare(snapshot,directory),f.signal);
    expect(await readFile(join(f.repo,"package-lock.json"),"utf8")).toBe(lock);expect(after.key,after.summary).toBeTruthy();expect(after.key).not.toBe(before.key);expect(after.summary).toContain("安装完成");expect(await readFile(join(f.manager.root,f.id,"published",after.key!,"node_modules/postinstall-ran"),"utf8")).toBe("new-script");
  });
  it("disables postinstall and refuses to clone when node_modules is not ignored", async () => {
    const f=await fixture(false), dep=await f.manager.prepare(f.id,f.snapshot,{...settings,dependencies:{mode:"auto",argv:[],files:[],allowScripts:false}},f.createCopy,f.signal);expect(dep.key,dep.summary).toBeTruthy();
    await expect(lstat(join(f.manager.root,f.id,"published",dep.key!,"node_modules/postinstall-ran"))).rejects.toThrow();
    const copy=await f.createCopy();expect(await f.manager.clone(f.id,dep,copy,f.signal)).toContain(".gitignore 未覆盖");await expect(lstat(join(copy.tree,"node_modules"))).rejects.toThrow();
  });
  it("aborts the install process group and leaves no completed or partial cache", async () => {
    const f=await fixture(), controller=new AbortController();let copy:ReviewCopy|undefined;
    const code="const fs=require('node:fs');fs.mkdirSync('node_modules');const c=require('node:child_process').spawn(process.execPath,['-e',\"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)\"],{stdio:'inherit'});fs.writeFileSync('child-pid',String(c.pid));setInterval(()=>{},1000);";
    const pending=f.manager.prepare(f.id,f.snapshot,{...settings,dependencies:{mode:"custom",argv:["node","-e",code],files:["package-lock.json"],allowScripts:true}},async directory=>{copy=await f.createCopy(directory);return copy},controller.signal);
    let pid=0;for(let i=0;i<200;i++){if(copy)pid=Number(await readFile(join(copy.tree,"child-pid"),"utf8").catch(()=>"0"));if(pid)break;await new Promise(r=>setTimeout(r,50));}expect(pid).toBeGreaterThan(0);controller.abort();await expect(pending).rejects.toThrow();
    expect(()=>process.kill(pid,0)).toThrow();expect(await readdir(f.manager.runsRoot)).toEqual([]);
  },20000);
});

const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const attackPrelude = "const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process'),run=path.dirname(process.env.HOME);";
describe.skipIf(process.platform !== "darwin")("malicious postinstall regression", () => {
  it.each(["success", "failure", "cancel", "stop"] as const)("reaps detached stdio-free descendants after %s, including a second fork", async mode => {
    const attack = attackPrelude + `const daemon="const fs=require('node:fs'),p=require('node:path'),root=process.argv[1];fs.writeFileSync(p.join(root,'daemon.pid'),String(process.pid));const fd=fs.openSync(p.join(root,'heartbeat'),'w');setInterval(()=>fs.writeSync(fd,String(Date.now()),0,'utf8'),30);setTimeout(()=>process.exit(0),30000);";const fork="const cp=require('node:child_process');const c=cp.spawn(process.execPath,['-e',"+JSON.stringify(daemon)+",process.argv[1]],{detached:true,stdio:'ignore',env:{OPENSSL_CONF:'/dev/null'}});c.unref();";const c=cp.spawn(process.execPath,['-e',fork,run],{detached:true,stdio:'ignore',env:{OPENSSL_CONF:'/dev/null'}});c.unref();${mode === "success" || mode === "failure" ? `setTimeout(()=>process.exit(${mode === "success" ? 0 : 1}),800);` : "setInterval(()=>{},1000);"}`;
    const f = await fixture(true, attack), controller = new AbortController(), control = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore" });
    let pid = 0, heartbeat: Awaited<ReturnType<typeof open>> | undefined;
    const pending = f.manager.prepare(f.id, f.snapshot, settings, f.createCopy, controller.signal).then(value => ({ value }), error => ({ error }));
    try {
      for (let i = 0; i < 300; i++) { if (f.lastCopy) pid = Number(await readFile(join(dirname(f.lastCopy.directory), "daemon.pid"), "utf8").catch(() => "0")); if (pid) break; await delay(20); }
      expect(pid).toBeGreaterThan(0);
      const run = dirname(f.lastCopy!.directory); for (let i=0;i<100;i++){try{heartbeat=await open(join(run,"heartbeat"),"r");break;}catch{await delay(10);}}
      expect(heartbeat).toBeDefined();
      if (mode === "cancel") controller.abort();
      if (mode === "stop") (await import("../src/main/model/cli/managed-child-process.js")).stopManagedProcesses();
      const outcome = await pending;
      if (mode === "success") expect("value" in outcome && outcome.value.key, JSON.stringify(outcome)).toBeTruthy();
      else if (mode === "cancel") expect("error" in outcome).toBe(true);
      else expect("value" in outcome && !outcome.value.key).toBe(true);
      const before = Buffer.alloc(32), after = Buffer.alloc(32); await heartbeat!.read(before, 0, before.length, 0); await delay(150); await heartbeat!.read(after, 0, after.length, 0);
      expect(after.equals(before)).toBe(true); expect(alive(pid)).toBe(false); expect(alive(control.pid!)).toBe(true); expect(await readdir(f.manager.runsRoot)).toEqual([]);
    } finally { await heartbeat?.close(); if (pid && alive(pid)) process.kill(pid,"SIGKILL"); control.kill("SIGKILL"); controller.abort(); await pending; }
  }, 20000);

  it("recovers detached double-fork writers after an abrupt host crash using the persisted run ledger", async () => {
    const attack=attackPrelude+`const daemon="const fs=require('node:fs'),p=require('node:path'),run=process.argv[1];fs.writeFileSync(p.join(run,'daemon.pid'),String(process.pid));const fd=fs.openSync(p.join(run,'heartbeat'),'w');setInterval(()=>fs.writeSync(fd,String(Date.now()),0,'utf8'),30);setTimeout(()=>process.exit(0),30000);";const fork="const cp=require('node:child_process');const child=cp.spawn(process.execPath,['-e',"+JSON.stringify(daemon)+",process.argv[1]],{detached:true,stdio:'ignore',env:{OPENSSL_CONF:'/dev/null'}});child.unref();";const child=cp.spawn(process.execPath,['-e',fork,run],{detached:true,stdio:'ignore',env:{OPENSSL_CONF:'/dev/null'}});child.unref();setInterval(()=>{},1000);`;
    const f=await fixture(true,attack),repo=resolve("."),driver=join(f.root,"crashing-host.mjs"),environment=Object.fromEntries(["HOME","PATH","VOLTA_HOME","LANG","TMPDIR"].flatMap(key=>process.env[key]?[[key,process.env[key]!]]:[]));
    const loadPath=(file:string)=>JSON.stringify(join(repo,`apps/desktop/src/main/${file}.ts`));
    await writeFile(driver,`import{createServer}from ${JSON.stringify(pathToFileURL(resolve("node_modules/vite/dist/node/index.js")).href)};import{writeFile}from 'node:fs/promises';const server=await createServer({root:${JSON.stringify(repo)},cacheDir:${JSON.stringify(join(f.root,"child-vite"))},configFile:false,appType:'custom',logLevel:'silent',server:{middlewareMode:true},resolve:{alias:${JSON.stringify(Object.fromEntries(["protocol","core","storage","integrations"].map(name=>[`@cognelis/decision-${name}`,join(repo,`packages/${name}/src/index.ts`)])))}}});const{LocalReviewGit}=await server.ssrLoadModule(${loadPath("local-review-git")});const{LocalReviewDependencies}=await server.ssrLoadModule(${loadPath("local-review-dependencies")});const{isolationEnvironment}=await import(${JSON.stringify(pathToFileURL(join(repo,"scripts/lab/isolated-app.mjs")).href)});const env={...isolationEnvironment(${JSON.stringify(f.root)},process.env),PARASELF_PROVIDER_CHILD:'1'};const git=new LocalReviewGit('/usr/bin/git',env),manager=new LocalReviewDependencies(${JSON.stringify(f.manager.root)},git,env);await manager.start();await manager.prepare(${JSON.stringify(f.id)},${JSON.stringify(f.snapshot)},${JSON.stringify(settings)},directory=>git.prepare(${JSON.stringify(f.snapshot)},directory),new AbortController().signal);await writeFile(${JSON.stringify(join(f.root,"unexpected-exit"))},'finished');await server.close();`);
    const host=spawn(process.execPath,[driver],{cwd:repo,env:{...environment,PARASELF_PROVIDER_CHILD:"1"},stdio:["ignore","ignore","pipe"]});let stderr="";host.stderr.on("data",chunk=>stderr+=chunk);
    let pid=0,run="",heartbeat:Awaited<ReturnType<typeof open>>|undefined;
    try {
      for(let i=0;i<500;i++){for(const id of await readdir(f.manager.runsRoot)){const directory=join(f.manager.runsRoot,id);pid=Number(await readFile(join(directory,"daemon.pid"),"utf8").catch(()=>"0"));if(pid){run=directory;break;}}if(pid)break;if(host.exitCode!==null)throw new Error(stderr);await delay(20);}
      expect(pid,stderr).toBeGreaterThan(0);for(let i=0;i<100;i++){try{heartbeat=await open(join(run,"heartbeat"),"r");break;}catch{await delay(10);}}expect(heartbeat).toBeDefined();
      host.kill("SIGKILL");await new Promise(resolve=>host.once("close",resolve));expect(alive(pid)).toBe(true);
      const {LocalReviewService}=await import("../src/main/local-review-service.js");const service=new LocalReviewService(dirname(f.manager.root),f.controlled,{} as import("../src/main/pr-connections.js").PrConnections,async()=>[],process.env);await service.start();await service.close();
      const a=Buffer.alloc(32),b=Buffer.alloc(32);await heartbeat!.read(a,0,32,0);await delay(150);await heartbeat!.read(b,0,32,0);expect(b.equals(a)).toBe(true);expect(alive(pid)).toBe(false);expect(await readdir(f.manager.runsRoot)).toEqual([]);
    }finally{host.kill("SIGKILL");await heartbeat?.close();if(pid&&alive(pid))process.kill(pid,"SIGKILL");}
  },30000);

  it("cannot read or forge published markers and breaks source hardlink aliases on publication", async () => {
    const attack = attackPrelude + `const input=JSON.parse(fs.readFileSync('attack-input.json'));const receipt={};for(const [name,fn]of Object.entries({read:()=>fs.readFileSync(input.read),write:()=>fs.writeFileSync(input.read,'poison'),state:()=>fs.writeFileSync(path.join(run,'..','..','dependency-state.json'),'poison'),rootMode:()=>fs.chmodSync(run,0),forge:()=>{fs.mkdirSync(path.join(input.forged,'node_modules'),{recursive:true});fs.writeFileSync(path.join(input.forged,'complete.json'),JSON.stringify({version:2,key:input.key,lastUsed:Date.now(),bytes:0}));}})){try{fn();receipt[name]='ALLOWED'}catch(error){receipt[name]=error.code}}fs.writeFileSync(path.join(run,'cache/hard-source'),'original');fs.linkSync(path.join(run,'cache/hard-source'),'node_modules/hard-a');fs.linkSync('node_modules/hard-a','node_modules/hard-b');fs.symlinkSync('hard-a','node_modules/local-link');fs.writeFileSync('node_modules/attack-result.json',JSON.stringify(receipt));setTimeout(()=>{},800);`;
    const f = await fixture(true, attack), published = join(f.manager.root,f.id,"published"), sentinelKey="f".repeat(64), sentinel=join(published,sentinelKey,"node_modules/sentinel");
    await mkdir(dirname(sentinel),{recursive:true});await writeFile(sentinel,"host-original");await writeFile(join(published,sentinelKey,"complete.json"),JSON.stringify({version:2,key:sentinelKey,lastUsed:0,bytes:13}));
    const contents:Array<[string,string]> = [["package-lock.json",digest(await readFile(join(f.repo,"package-lock.json"),"utf8"))],["package.json",digest(await readFile(join(f.repo,"package.json"),"utf8"))]];
    const forgedKey=dependencyCacheKey(f.id,["npm","ci","--ignore-scripts"],false,contents,process.version);
    let source: Awaited<ReturnType<typeof open>> | undefined;
    const pending=f.manager.prepare(f.id,f.snapshot,settings,async directory=>{const copy=await f.createCopy(directory);await writeFile(join(copy.tree,"attack-input.json"),JSON.stringify({read:sentinel,forged:join(published,forgedKey),key:forgedKey}));return copy;},f.signal);
    for(let i=0;i<300;i++){if(f.lastCopy)try{source=await open(join(dirname(f.lastCopy.directory),"cache/hard-source"),"r+");break;}catch{}await delay(20);}
    try {
      const result=await pending;expect(result.key,result.summary).toBeTruthy();expect(source).toBeDefined();const base=join(published,result.key!,"node_modules"),receipt=JSON.parse(await readFile(join(base,"attack-result.json"),"utf8"));
      expect(receipt).toEqual({read:"EPERM",write:"EPERM",state:"EPERM",rootMode:"EPERM",forge:"EPERM"});expect(await readFile(sentinel,"utf8")).toBe("host-original");
      const a=await stat(join(base,"hard-a")),b=await stat(join(base,"hard-b")),old=await source!.stat();expect(a.ino).not.toBe(old.ino);expect(b.ino).not.toBe(old.ino);expect(a.ino).not.toBe(b.ino);
      await source!.write("mutated",0,"utf8");expect(await readFile(join(base,"hard-a"),"utf8")).toBe("original");expect(await readlink(join(base,"local-link"))).toBe("hard-a");
      const disabled=await f.manager.prepare(f.id,f.snapshot,{...settings,dependencies:{mode:"auto",argv:[],files:[],allowScripts:false}},f.createCopy,f.signal);expect(disabled.summary).toContain("安装完成");expect(disabled.key).toBe(forgedKey);await expect(lstat(join(published,forgedKey,"node_modules/attack-result.json"))).rejects.toThrow();
    } finally { await source?.close(); }
  }, 20000);

  it("does not publish installed dependencies when the host may have gained a launchd label",async()=>{
    const f=await fixture(),observed:string[][]=[];vi.mocked(ReviewLaunchdLabels.prototype.snapshot).mockResolvedValueOnce(["stable-host"]).mockResolvedValueOnce(["stable-host","possible-new-job"]);
    const result=await f.manager.prepare(f.id,f.snapshot,settings,f.createCopy,f.signal,labels=>{observed.push(labels);});expect(result.key).toBeUndefined();expect(result.summary).toContain("可能新增");expect(result.possibleLaunchdLabels).toEqual(["possible-new-job"]);expect(observed).toEqual([["possible-new-job"]]);expect(await readdir(join(f.manager.root,f.id,"published"))).toEqual([]);
  });

  it("keeps the fingerprint ledger and active configuration 0600 outside the install read scope", async () => {
    const attack=attackPrelude+`const result={};for(const [name,target]of Object.entries(JSON.parse(fs.readFileSync('secret-targets.json','utf8')))){try{fs.readFileSync(target);result[name]='ALLOWED'}catch(error){result[name]=error.code}}fs.writeFileSync('node_modules/secret-result.json',JSON.stringify(result));`;
    const f=await fixture(true,attack),{ManagedChildProcessRunner}=await import("../src/main/model/cli/managed-child-process.js"),original=ManagedChildProcessRunner.prototype.run;let inspected=false;
    const intercepted=vi.spyOn(ManagedChildProcessRunner.prototype,"run").mockImplementation(async function(this:import("../src/main/model/cli/managed-child-process.js").ManagedChildProcessRunner,request){
      if(request.provider==="local-review-install"&&request.args.includes("ci")){
        const profile=request.args[1]!,ledger=join(dirname(f.manager.root),"dependency-state.json"),state=JSON.parse(await readFile(ledger,"utf8"));
        expect((await stat(profile)).mode&0o777).toBe(0o600);expect((await stat(ledger)).mode&0o777).toBe(0o600);expect(profile.startsWith(dirname(f.lastCopy!.directory)+"/")).toBe(false);
        const current=state.runs.find((run:{repositoryId:string})=>run.repositoryId===f.id);expect(current.fingerprint.names).toHaveLength(32);const text=await readFile(profile,"utf8");for(const name of current.fingerprint.names)expect(text).toContain(name);
        await writeFile(join(request.cwd,"secret-targets.json"),JSON.stringify({profile,ledger}));inspected=true;
      }
      return original.call(this,request);
    });
    try{const result=await f.manager.prepare(f.id,f.snapshot,settings,f.createCopy,f.signal);expect(result.key,result.summary).toBeTruthy();expect(inspected).toBe(true);expect(JSON.parse(await readFile(join(f.manager.root,f.id,"published",result.key!,"node_modules/secret-result.json"),"utf8"))).toEqual({profile:"EPERM",ledger:"EPERM"});}finally{intercepted.mockRestore();}
  },20000);

  it.each(["fifo", "unreadable", "escape", "oversize"] as const)("rejects %s artifacts and restarts the service without manual deletion", async kind => {
    const payload = kind === "fifo" ? "cp.execFileSync('/usr/bin/mkfifo',['node_modules/poison']);" : kind === "unreadable" ? "fs.mkdirSync('node_modules/poison');fs.chmodSync('node_modules/poison',0);" : kind === "escape" ? "fs.symlinkSync('../package.json','node_modules/poison');" : "const fd=fs.openSync('node_modules/poison','w');fs.ftruncateSync(fd,5*1024**3+1);fs.closeSync(fd);";
    const f=await fixture(true,attackPrelude+payload+"cp.execFileSync('/usr/bin/mkfifo',[path.join(run,'cache/also-poison')]);fs.mkdirSync(path.join(run,'cache/locked'));fs.chmodSync(path.join(run,'cache/locked'),0);");
    const result=await f.manager.prepare(f.id,f.snapshot,settings,f.createCopy,f.signal);expect(result.key).toBeUndefined();expect(result.summary).toContain("继续修改");expect(await readdir(f.manager.runsRoot)).toEqual([]);f.manager.release(f.id);
    const {LocalReviewService}=await import("../src/main/local-review-service.js");const service=new LocalReviewService(dirname(f.manager.root),f.controlled,{} as import("../src/main/pr-connections.js").PrConnections,async()=>[],process.env);await expect(service.start()).resolves.toBeUndefined();await service.close();await expect(new LocalReviewDependencies(f.manager.root,f.controlled).start()).resolves.toBeUndefined();
  },20000);

  it("retains an unidentifiable legacy grant without signalling or trusting its published path", async () => {
    const f=await fixture(),project=join(f.manager.root,f.id),fake=join(project,"published","c".repeat(64));await mkdir(join(fake,"node_modules"),{recursive:true});await writeFile(join(fake,"complete.json"),JSON.stringify({version:2,key:"c".repeat(64),lastUsed:1,bytes:6}));await writeFile(join(fake,"node_modules/poison"),"forged");await rm(join(dirname(f.manager.root),"dependency-state.json"));
    const {resolveReviewTools}=await import("../src/main/local-review-tools.js"),{reviewCommandPolicy}=await import("../src/main/local-review-command-sandbox.js"),{ManagedChildProcessRunner}=await import("../src/main/model/cli/managed-child-process.js");
    const environment=Object.fromEntries(["HOME","PATH","VOLTA_HOME"].flatMap(key=>process.env[key]?[[key,process.env[key]!]]:[])),copy=await f.createCopy(),tools=await resolveReviewTools(copy.directory,environment,new ManagedChildProcessRunner(),environment),profile=join(f.root,"legacy.sb");
    await mkdir(join(copy.directory,"scratch"));await writeFile(profile,reviewCommandPolicy(copy,tools,{root:project}));
    const code=`const fs=require('node:fs'),p=require('node:path'),root=process.argv[1];fs.writeFileSync(p.join(root,'daemon.pid'),String(process.pid));setInterval(()=>fs.writeFileSync(p.join(root,'heartbeat'),String(Date.now())),30);setTimeout(()=>process.exit(0),30000);`;
    const child=spawn("/usr/bin/sandbox-exec",["-f",profile,tools.find(tool=>tool.name==="node")!.executable,"-e",code,project],{env:{...environment,OPENSSL_CONF:"/dev/null"},stdio:"ignore",detached:true});
    try{for(let i=0;i<150;i++){if(await lstat(join(project,"heartbeat")).catch(()=>null))break;await delay(20);}expect(await readFile(join(project,"daemon.pid"),"utf8")).toBe(String(child.pid));const restored=new LocalReviewDependencies(f.manager.root,f.controlled,process.env);await restored.start();expect(alive(child.pid!)).toBe(true);expect(await readFile(join(fake,"node_modules/poison"),"utf8")).toBe("forged");const rejected=await restored.prepare(f.id,f.snapshot,settings,f.createCopy,f.signal);expect(rejected.key).toBeUndefined();expect(rejected.summary).toContain("回收尚未完成");}finally{child.kill("SIGKILL");}
  },20000);

  it.each(["obsolete","run"] as const)("clear removes no-fingerprint %s data and records without any signal",async kind=>{
    const f=await fixture(),id=randomUUID(),statePath=join(dirname(f.manager.root),"dependency-state.json"),state=JSON.parse(await readFile(statePath,"utf8")),directory=kind==="run"?join(f.manager.runsRoot,id):join(f.manager.root,f.id);
    await mkdir(directory,{recursive:true});await writeFile(join(directory,"old-data"),"synthetic");if(kind==="run")state.runs.push({id,repositoryId:f.id});else state.obsolete.push(f.id);await writeFile(statePath,JSON.stringify(state),{mode:0o600});
    const restored=new LocalReviewDependencies(f.manager.root,f.controlled),{ReviewInstallProcesses}=await import("../src/main/local-review-install-processes.js");await restored.start();
    const reap=vi.spyOn(ReviewInstallProcesses.prototype,"reap"),log=vi.spyOn(console,"info").mockImplementation(()=>{});
    try{await expect(restored.clear(f.id)).resolves.toBeUndefined();expect(reap).not.toHaveBeenCalled();await expect(lstat(directory)).rejects.toThrow();const after=JSON.parse(await readFile(statePath,"utf8"));expect(after.runs).toEqual([]);expect(after.obsolete).toEqual([]);expect(log).toHaveBeenCalled();}finally{reap.mockRestore();log.mockRestore();}
  });

  it("refuses a redirected no-fingerprint run during explicit cleanup and retains its record",async()=>{
    const f=await fixture(),id=randomUUID(),statePath=join(dirname(f.manager.root),"dependency-state.json"),state=JSON.parse(await readFile(statePath,"utf8"));
    state.runs.push({id,repositoryId:f.id});await writeFile(statePath,JSON.stringify(state),{mode:0o600});
    const restored=new LocalReviewDependencies(f.manager.root,f.controlled);await restored.start();
    const target=join(f.root,"unrelated"),directory=join(restored.runsRoot,id);await mkdir(target);await writeFile(join(target,"canary"),"preserved");await symlink(target,directory);
    await expect(restored.clear(f.id)).rejects.toThrow("重定向");expect(await readFile(join(target,"canary"),"utf8")).toBe("preserved");
    expect(JSON.parse(await readFile(statePath,"utf8")).runs).toEqual([{id,repositoryId:f.id}]);expect((await lstat(directory)).isSymbolicLink()).toBe(true);
  });

  it("isolates malformed published cache from other projects and recovers when the private API becomes available", async () => {
    const f=await fixture(),bad=join(f.manager.root,f.id,"published","a".repeat(64)),goodId=randomUUID(),goodKey="b".repeat(64),good=join(f.manager.root,goodId,"published",goodKey);
    for(const path of [bad,good])await mkdir(join(path,"node_modules"),{recursive:true});await writeFile(join(good,"node_modules/ok"),"preserved");await writeFile(join(good,"complete.json"),JSON.stringify({version:2,key:goodKey,lastUsed:1,bytes:9}));execFileSync('/usr/bin/mkfifo',[join(bad,'complete.json')]);await chmod(join(bad,'node_modules'),0);
    const restored=new LocalReviewDependencies(f.manager.root,f.controlled);await expect(restored.start()).resolves.toBeUndefined();expect(await readFile(join(good,"node_modules/ok"),"utf8")).toBe("preserved");await expect(lstat(bad)).rejects.toThrow();
    const {ReviewInstallProcesses}=await import("../src/main/local-review-install-processes.js"),unavailable=vi.spyOn(ReviewInstallProcesses.prototype,"assertReady").mockRejectedValue(new Error("synthetic private API failure"));
    try{const failed=await f.manager.prepare(f.id,f.snapshot,settings,f.createCopy,f.signal);expect(failed.key).toBeUndefined();expect(failed.summary).toContain("private API failure");expect(await readdir(f.manager.runsRoot)).toHaveLength(1);}finally{unavailable.mockRestore();}
    await expect(new LocalReviewDependencies(f.manager.root,f.controlled).start()).resolves.toBeUndefined();expect(await readdir(f.manager.runsRoot)).toEqual([]);
  },20000);
});
