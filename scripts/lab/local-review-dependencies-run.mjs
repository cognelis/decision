#!/usr/bin/env node
// Synthetic repositories only. Model clients reuse their existing login; this
// driver never opens credential files and never targets a real Git/PR platform.
import { execFile } from "node:child_process";
import { promisify, parseArgs } from "node:util";
import { createHash, randomUUID } from "node:crypto";
import { access, lstat, mkdir, mkdtemp, readFile, readdir, readlink, realpath, writeFile } from "node:fs/promises";
import { dirname, join, resolve, delimiter } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { isolationEnvironment, startIsolatedApp } from "./isolated-app.mjs";
const exec=promisify(execFile), repoRoot=fileURLToPath(new URL("../../",import.meta.url));
const hash=value=>createHash("sha256").update(value).digest("hex");
const save=(file,value)=>writeFile(file,JSON.stringify(value,null,2)+"\n");
const emit=value=>process.stdout.write(JSON.stringify({at:new Date().toISOString(),...value})+"\n");
const system=()=>Object.fromEntries(["HOME","USER","LOGNAME","PATH","TMPDIR","LANG","LC_ALL","TZ","SHELL"].flatMap(key=>process.env[key]===undefined?[]:[[key,process.env[key]]]));
async function snapshot(root, metadata=false) {
  const entries={};
  async function walk(directory,prefix="") {for(const entry of (await readdir(directory,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))){const file=join(directory,entry.name),name=prefix+entry.name,info=await lstat(file);if(info.isDirectory())await walk(file,name+"/");else entries[name]=metadata?[info.size,info.mtimeMs,info.mode,entry.isSymbolicLink()?await readlink(file):null]:hash(entry.isSymbolicLink()?await readlink(file):await readFile(file));}}
  await walk(root);return entries;
}
const args=parseArgs({options:{root:{type:"string"},app:{type:"string"},bridge:{type:"string"},worker:{type:"string"},preflight:{type:"boolean"}}}).values;
if(!args.app||!args.bridge)throw new Error("Explicit --app and --bridge are required");
if(process.env.MODEL_PROXY_URL!=="http://127.0.0.1:7890")throw new Error("Set MODEL_PROXY_URL=http://127.0.0.1:7890 on the driver only");
const requestedRoot=args.root?resolve(args.root):await mkdtemp(join(process.env.PARASELF_LAB_ROOT??tmpdir(),"lr-deps-live-"));
await mkdir(requestedRoot,{recursive:true});const root=await realpath(requestedRoot);
// A new explicit root is required so prior evidence can never be overwritten.
if(await access(join(root,"result.json")).then(()=>true,()=>false))throw new Error("Use a fresh run root");
const server=await createServer({root:repoRoot,cacheDir:join(root,"vite-cache"),configFile:false,appType:"custom",logLevel:"silent",server:{middlewareMode:true},resolve:{alias:Object.fromEntries(["protocol","core","storage","integrations"].map(name=>[`@cognelis/decision-${name}`,join(repoRoot,`packages/${name}/src/index.ts`)]))}});
const load=file=>server.ssrLoadModule(join(repoRoot,`apps/desktop/src/main/${file}.ts`));
const {LocalReviewGit}=await load("local-review-git"),{LocalReviewService}=await load("local-review-service"),{ReviewCommandSandbox}=await load("local-review-command-sandbox"),{ManagedChildProcessRunner}=await load("model/cli/managed-child-process"),{PrConnections}=await load("pr-connections"),{ProfiledModelGateway}=await load("model/profiled-model-gateway"),{ClaudeCodeCliAdapter}=await load("model/adapters/claude-code-cli-adapter"),{CodexCliAdapter}=await load("model/adapters/codex-cli-adapter");
const find=async name=>{for(const directory of(process.env.PATH??"").split(delimiter)){const file=join(directory,name);if(await access(file).then(()=>true,()=>false))return realpath(file);}throw new Error(`Missing ${name}`)};
const cli={codex:await find("codex"),claude:await find("claude")};
const gitEnv={...system(),GIT_CONFIG_GLOBAL:"/dev/null",GIT_CONFIG_NOSYSTEM:"1",GIT_TERMINAL_PROMPT:"0",GIT_OPTIONAL_LOCKS:"0"};
const git=async(cwd,argv)=>(await exec("/usr/bin/git",["-c","core.hooksPath=/dev/null","-c","core.fsmonitor=false","-c","commit.gpgsign=false",...argv],{cwd,env:gitEnv,encoding:"utf8",timeout:300000})).stdout.trim();
const controlled=new LocalReviewGit("/usr/bin/git",gitEnv,true), calls=[];let app,service;
const original=ManagedChildProcessRunner.prototype.run;
for(const signal of ["SIGINT","SIGTERM"])process.once(signal,()=>{void(async()=>{await service?.close();await app?.stop();await server.close();process.exit(130)})();});
ManagedChildProcessRunner.prototype.run=async function(request){const model=["codex-cli","claude-code-cli"].includes(request.provider)&&(request.args.includes("exec")||request.args.includes("-p")),install=request.provider==="local-review-install",command=request.provider==="local-review-command";if(!model&&!install&&!command)return original.call(this,request);const call={index:calls.length,provider:request.provider,cwd:request.cwd,args:request.args,startedAt:new Date().toISOString()};calls.push(call);emit({event:"call-start",index:call.index,provider:call.provider});try{const result=await original.call(this,request);Object.assign(call,result);await save(join(root,`call-${call.index}.json`),call);return result;}catch(error){call.error={message:error.message,diagnostic:error.diagnosticExcerpt,code:error.code};await save(join(root,`call-${call.index}.json`),call);throw error;}};
let timer;
try {
  app=await startIsolatedApp({root:join(root,"app-shell"),executable:resolve(args.app),useLocalModels:false,showWindow:false,base:system()});
  const appBefore=await snapshot(app.env.PARASELF_USER_DATA),modulesBefore=hash(JSON.stringify(await snapshot(join(repoRoot,"node_modules"),true)));
  const source=join(root,"source");await mkdir(source);await writeFile(join(source,"package.json"),JSON.stringify({name:"synthetic-dependency-review",version:"1.0.0",private:true,type:"module",scripts:{test:"vitest run --maxWorkers=1 --no-file-parallelism"},devDependencies:{vitest:"1.6.1"}}));
  await writeFile(join(source,".gitignore"),"node_modules/\n");await writeFile(join(source,"math.js"),"export function add(a,b){return a-b;}\n");await writeFile(join(source,"math.test.js"),"import {test,expect} from 'vitest';import{add}from './math.js';test('addition',()=>expect(add(2,3)).toBe(5));\n");
  await writeFile(join(source,"README.md"),"# Synthetic dependency fixture\nContract: add(a,b) returns a+b. Run the existing vitest test with npm test before and after fixing; use npm test -- --maxWorkers=1 --no-file-parallelism. Dependencies are prepared by the host, do not install them.\n");
  await git(source,["init","-b","main","--template="]);await git(source,["config","user.name","Synthetic"]);await git(source,["config","user.email","synthetic@example.invalid"]);await git(source,["add","."]);await git(source,["commit","-m","冻结合成工程"]);
  const installRoot=join(root,"lock-run");await mkdir(installRoot);const seed=await controlled.prepare(await controlled.inspect(source),join(installRoot,"copy"));
  const sandbox=new ReviewCommandSandbox({...system(),MODEL_PROXY_URL:process.env.MODEL_PROXY_URL},{root:installRoot,proxy:process.env.MODEL_PROXY_URL});await sandbox.probe(seed);if(!sandbox.available)throw new Error(sandbox.reason);
  const lock=await sandbox.run(["npm","install","--package-lock-only","--ignore-scripts","--registry=https://registry.npmjs.org","--no-audit","--no-fund"]);await save(join(root,"lock-generation.json"),lock);if(lock.exitCode)throw new Error("Public registry lock generation failed");const preinstall=await sandbox.run(["npm","ci"]);await save(join(root,"preflight-install.json"),preinstall);if(preinstall.exitCode)throw new Error("Preflight public npm ci failed");
  const pretest=await sandbox.run(["npm","test"]);await save(join(root,"preflight-test.json"),pretest);if(!pretest.stdout.includes("1 failed")||!pretest.exitCode)throw new Error("Preflight vitest must actually run and fail the original assertion");
  if(args.preflight){await save(join(root,"result.json"),{preflight:true,installExit:preinstall.exitCode,testExit:pretest.exitCode});await app.stop();app=undefined;await server.close();emit({event:"preflight-passed"});process.exit(0);}
  await writeFile(join(source,"package-lock.json"),await readFile(join(seed.tree,"package-lock.json")));await git(source,["add","package-lock.json"]);await git(source,["commit","-m","冻结公共依赖锁文件"]);
  const bare=join(root,"remote.git");await git(root,["init","--bare","--template=",bare]);await git(source,["remote","add","origin",bare]);await git(source,["push","origin","main"]);
  const before=await snapshot(source);await save(join(root,"source-before.json"),before);
  const userData=join(root,"user-data");await mkdir(userData);await writeFile(join(userData,"unrelated-data.txt"),"synthetic unrelated data must remain unchanged\n");const unrelatedBefore=await snapshot(userData);const environment={...isolationEnvironment(root,system()),PARASELF_PROVIDER_CHILD:"1",MODEL_PROXY_URL:process.env.MODEL_PROXY_URL};
  const profiles=[{version:1,profileId:"live-codex",kind:"codex-cli",label:"Synthetic Codex",enabled:true,priority:0,timeoutMs:120000,executablePath:cli.codex,model:"gpt-6-luna"},{version:1,profileId:"live-claude",kind:"claude-code-cli",label:"Synthetic Claude",enabled:true,priority:1,timeoutMs:120000,executablePath:cli.claude,model:"sonnet"}];
  const credentials=new Map(),connections=new PrConnections(join(userData,"connections.json"),{get:async key=>credentials.get(key)??null,set:async(key,value)=>{credentials.set(key,value)},delete:async key=>credentials.delete(key)});
  const traces=[],gateway=new ProfiledModelGateway({profiles:{load:async()=>profiles},providerFactory:profile=>profile.kind==="claude-code-cli"?new ClaudeCodeCliAdapter({profile,environment}):new CodexCliAdapter({profile,environment}),traces:{record:async trace=>{traces.push(trace);return trace}},audit:{fingerprint:async text=>hash(text),record:async()=>undefined,summary:async()=>({})}});
  service=new LocalReviewService(join(userData,"local-review"),controlled,connections,async()=>profiles,environment,undefined,gateway);await service.start();const session=await service.register(source),repositoryId=service.state().repositories[0].id;
  timer=setInterval(()=>emit({event:"progress",jobs:service.state().jobs.map(j=>({worker:j.worker,state:j.state,dependencies:j.dependencies?.summary,groups:j.groups.map(g=>g.state)}))}),15000);
  const jobs=[];
  const run=async(worker,sessionId)=>{await service.annotate({repositoryId,sessionId,path:"math.js",side:"new",startLine:1,endLine:1,body:"add(2,3) 应按合同返回 5，当前返回 -1。请先在沙箱内实际运行现有 vitest 测试 npm test，确认失败；修复后再次运行同一测试确认通过。不要修改测试和 package 文件，不要安装依赖。"});const id=await service.submit(repositoryId,sessionId,worker==="codex"?"live-codex":"live-claude",worker);await service.idle();const job=service.state().jobs.find(j=>j.id===id);jobs.push(job);await save(join(root,`job-${jobs.length}-${worker}.json`),job);return job;};
  for(const worker of args.worker?[args.worker]:["codex","pi","claude-code"]){const next=await run(worker,jobs.length?await service.newSession(repositoryId):session);emit({event:"job-finish",worker,state:next.state,dependencies:next.dependencies?.summary});}
  // A second task for the same repository must use its completed cache.
  const cached=await run(args.worker??"codex",await service.newSession(repositoryId));
  const secondSource=join(root,"second-source");await git(root,["clone","--template=",source,secondSource]);await git(secondSource,["config","user.name","Synthetic"]);await git(secondSource,["config","user.email","synthetic@example.invalid"]);
  const secondSession=await service.register(secondSource),secondId=service.state().repositories.find(r=>r.snapshot.path===secondSource).id;
  const {LocalReviewDependencies}=await load("local-review-dependencies"),secondManager=new LocalReviewDependencies(join(userData,"local-review/dependencies"),controlled,environment);await secondManager.start();
  const second=await secondManager.prepare(secondId,await controlled.inspect(secondSource),service.state().repositories.find(r=>r.id===secondId).settings,directory=>controlled.prepare(service.state().repositories.find(r=>r.id===secondId).snapshot,directory),new AbortController().signal);secondManager.release(secondId);
  const after=await snapshot(source),appAfter=await snapshot(app.env.PARASELF_USER_DATA),modulesAfter=hash(JSON.stringify(await snapshot(join(repoRoot,"node_modules"),true)));
  const result={node:process.version,workers:jobs.map(j=>({worker:j.worker,state:j.state,dependencies:j.dependencies,verification:j.groups.map(g=>g.fix?.verification),groups:j.groups.map(g=>({state:g.state,error:g.error,commit:g.artifact?.commitOid}))})),cacheHit:cached.dependencies?.summary.includes("命中"),secondProject:{id:secondId,first:repositoryId,...second,directoriesSeparate:second.key!==jobs[0].dependencies?.key},sourceUnchanged:JSON.stringify(before)===JSON.stringify(after),modulesUnchanged:modulesBefore===modulesAfter,appShellChanged:JSON.stringify(appBefore)!==JSON.stringify(appAfter),appOtherDataUnchanged:JSON.stringify(unrelatedBefore)===JSON.stringify(Object.fromEntries(Object.entries(await snapshot(userData)).filter(([path])=>!path.startsWith("local-review/")))),calls:calls.length};
  await save(join(root,"source-after.json"),after);await save(join(root,"traces.json"),traces);await save(join(root,"result.json"),result);emit({event:"result",cacheHit:result.cacheHit,secondProjectSeparate:result.secondProject.directoriesSeparate,sourceUnchanged:result.sourceUnchanged,modulesUnchanged:result.modulesUnchanged,appOtherDataUnchanged:result.appOtherDataUnchanged,workers:result.workers.map(({worker,state})=>({worker,state}))});
  if(!result.cacheHit||!second.key||!result.secondProject.directoriesSeparate||!result.sourceUnchanged||!result.modulesUnchanged||!result.appOtherDataUnchanged||jobs.some(j=>j.groups.some(g=>!g.artifact)))process.exitCode=1;
} catch(error){await save(join(root,"failure.json"),{message:error.message,stack:error.stack});emit({event:"failed",message:error.message});process.exitCode=2;}
finally{clearInterval(timer);await service?.close();ManagedChildProcessRunner.prototype.run=original;if(app){await app.stop();await writeFile(join(root,"app.stderr"),app.stderr());}await server.close();}
