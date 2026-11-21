import { afterEach, expect, it, vi } from "vitest";
import { claudeReviewSettings, claudeReviewSettingsSchema, claudeReviewArguments, claudeReviewOutput, validateClaudeToolStage, type ClaudeReviewRuntime } from "../src/main/local-review-claude-runtime.js";
import { validateClaudeNodeReceipt, validateClaudeProbeCalls } from "../src/main/local-review-claude-probe.js";
import { reviewFixJsonSchema } from "../src/main/local-review-worker.js";
import { ClaudeReviewWorker } from "../src/main/local-review-claude-worker.js";
import * as probeModule from "../src/main/local-review-claude-probe.js";
afterEach(()=>vi.restoreAllMocks());
const runtime:ClaudeReviewRuntime={executable:"/runtime/claude",git:"/runtime/git",home:"/user",configs:["/user/.claude","/user/.claude.json"],fingerprint:"fixture",tools:[{name:"node",executable:"/runtime/node/bin/node",prefix:"/runtime/node"},{name:"python3",executable:"/runtime/python/bin/python3",prefix:"/runtime/python"}]};
const copy={directory:"/job",tree:"/job/tree",git:"/job/git"};
const frames=(name="Bash",result:unknown={ok:true})=>[
 {type:"system",subtype:"init",tools:["Read","Glob","Grep","Bash","StructuredOutput"],mcp_servers:[],skills:[],slash_commands:[],plugins:[],permissionMode:"dontAsk",model:"actual-sonnet"},
 {type:"assistant",message:{content:[{type:"tool_use",id:"one",name,input:{command:"fixed"}}]}},
 {type:"user",message:{content:[{type:"tool_result",tool_use_id:"one",content:"DONE",is_error:false}]}},
 {type:"result",subtype:"success",is_error:false,structured_output:result,modelUsage:{"actual-sonnet":{}}},
].map(e=>JSON.stringify(e)).join("\n");
it("generates strict settings with specific system files, staged writes, real authentication HOME and scratch caches",()=>{
 const read=claudeReviewSettings(copy,runtime,"/private/tmp/alias",false,["CUSTOM_AUTH_TOKEN"]),write=claudeReviewSettings(copy,runtime,"/private/tmp/alias",true);
 expect(read.env.HOME).toBeUndefined();expect(read.env.XDG_CACHE_HOME).toBe("/job/scratch/cache");expect(read.env.OPENSSL_CONF).toBe("/dev/null");
 expect(read.sandbox.filesystem.allowRead).toContain("/usr/bin/env");expect(read.sandbox.filesystem.allowRead).not.toContain("/usr/bin");expect(read.sandbox.filesystem.allowRead).not.toContain("/usr/bin/security");
 expect(read.permissions.deny).toContain("Bash(/usr/bin/security:*)");expect(read.permissions.deny).toContain("Edit");expect(read.sandbox.filesystem.denyWrite).toContain(copy.tree);
 expect(write.permissions.deny).not.toContain("Edit");expect(write.sandbox.filesystem.allowWrite).toContain(copy.tree);expect(write.sandbox.filesystem.denyWrite).toContain(copy.git);
 expect(read.sandbox.credentials.envVars).toContainEqual({name:"CUSTOM_AUTH_TOKEN",mode:"deny"});
 const argv=claudeReviewArguments(write,{},"/job/scratch","sonnet");expect(argv).toContain("--safe-mode");expect(argv).toContain("--strict-mcp-config");expect(argv).not.toContain("--dangerously-skip-permissions");
 const businessArgv=claudeReviewArguments(write,reviewFixJsonSchema,"/job/scratch","sonnet");const businessSchema=JSON.parse(businessArgv[businessArgv.indexOf("--json-schema")+1]!);
 expect(businessSchema.$schema).toBeUndefined();expect(businessSchema.properties).toEqual(reviewFixJsonSchema.properties);expect(businessSchema.required).toEqual(reviewFixJsonSchema.required);
});
it("rejects malformed or weakened generated settings rather than letting the CLI ignore them",()=>{
 const settings=claudeReviewSettings(copy,runtime,"/private/tmp/alias",true);
 for(const patch of [{enabled:"invalid-type"},{failIfUnavailable:false},{allowUnsandboxedCommands:true},{excludedCommands:["node"]}])expect(()=>claudeReviewSettingsSchema.parse({...settings,sandbox:{...settings.sandbox,...patch}})).toThrow();
 expect(()=>claudeReviewSettingsSchema.parse({...settings,permissions:{...settings.permissions,deny:[]}})).toThrow();
 expect(()=>claudeReviewSettingsSchema.parse({...settings,sandbox:{...settings.sandbox,filesystem:{...settings.sandbox.filesystem,allowRead:["/usr/bin"]}}})).toThrow();
});
it("parses actual tool events and model identity, while leaving malformed business results for the shared repair loop",()=>{
 const output=claudeReviewOutput(frames());expect(output.model).toBe("actual-sonnet");expect(output.result).toEqual({ok:true});expect(output.calls[0]!.result!.content).toBe("DONE");
 expect(()=>validateClaudeToolStage(output,false)).not.toThrow();expect(()=>validateClaudeToolStage(output,true)).toThrow("分阶段");
 (output.init.tools as string[]).push("Edit","Write");expect(()=>validateClaudeToolStage(output,true)).not.toThrow();expect(()=>validateClaudeToolStage(output,false)).toThrow("分阶段");
 expect(claudeReviewOutput(frames("Bash",{})).result).toEqual({});
 expect(()=>claudeReviewOutput(frames("UnknownTool"))).toThrow("未知");
 const lines=frames().split("\n").map(line=>JSON.parse(line));lines[0].mcp_servers=[{name:"unexpected"}];expect(()=>claudeReviewOutput(lines.map(value=>JSON.stringify(value)).join("\n"))).toThrow("不匹配");
});
it("requires every fixed probe tool, exact protected parameters and true success or denial receipts",()=>{
 const output=claudeReviewOutput(frames()),steps=[{name:"Bash",input:{command:"fixed"},denied:false,contains:"DONE"}];
 expect(()=>validateClaudeProbeCalls(output,steps)).not.toThrow();
 expect(()=>validateClaudeProbeCalls(output,[...steps,{name:"Read",input:{file_path:"/expected"},denied:true}])).toThrow("缺少");
 expect(()=>validateClaudeProbeCalls(output,[{...steps[0]!,input:{command:"changed"}}])).toThrow("不匹配");
 expect(()=>validateClaudeProbeCalls(output,[{...steps[0]!,denied:true}])).toThrow("未通过");
 output.calls[0]!.input.dangerouslyDisableSandbox=true;expect(()=>validateClaudeProbeCalls(output,steps)).toThrow("不匹配");
});
it("validates Node positive/negative controls, phase and bounded scratch instead of trusting model ok",()=>{
 const value={nonce:"n",node:true,outsideReadDenied:true,homeReadDenied:true,symlinkReadDenied:true,outsideWriteDenied:true,gitWriteDenied:true,workspaceWrite:true,scratchWrite:true,credentialsHidden:true,networkDenied:true,tmp:"/scratch/cli"};
 expect(()=>validateClaudeNodeReceipt(value,"n",true,"/scratch")).not.toThrow();
 for(const key of ["node","outsideReadDenied","homeReadDenied","symlinkReadDenied","outsideWriteDenied","gitWriteDenied","scratchWrite","credentialsHidden","networkDenied"])expect(()=>validateClaudeNodeReceipt({...value,[key]:false},"n",true,"/scratch")).toThrow();
 for(const patch of [{nonce:"wrong"},{workspaceWrite:false},{tmp:"/scratch-other"}])expect(()=>validateClaudeNodeReceipt({...value,...patch},"n",true,"/scratch")).toThrow();
});

it("keeps the primary structured result when a background completion produces another result",()=>{
 const stdout=frames()+"\n"+JSON.stringify({type:"result",subtype:"success",is_error:false,origin:{kind:"task-notification"},result:"background done"});
 expect(claudeReviewOutput(stdout).result).toEqual({ok:true});
});
it("repairs malformed business output once and never retries process failures",async()=>{
 const profile={version:1 as const,profileId:"native",kind:"claude-code-cli" as const,label:"native",enabled:true,priority:0,timeoutMs:1000,executablePath:"/fixture/claude",model:"sonnet"};
 const worker=new ClaudeReviewWorker(profile,{}),hooks=worker as unknown as {ready:()=>Promise<ClaudeReviewRuntime>;raw:(...args:unknown[])=>Promise<ReturnType<typeof claudeReviewOutput>&{stdout:string}>};
 vi.spyOn(hooks,"ready").mockResolvedValue(runtime);
 const annotation={id:"00000000-0000-4000-8000-000000000001",path:"source.js",side:"new" as const,startLine:1,endLine:1,lineText:"before",body:"fix"};
 const valid={changedFiles:["source.js"],outcomes:[{id:annotation.id,outcome:"fixed",summary:"fixed"}],commitTitle:"修复示例",verification:"not run"};
 const raw=vi.spyOn(hooks,"raw").mockResolvedValueOnce({...claudeReviewOutput(frames("Bash",{})),stdout:""}).mockResolvedValueOnce({...claudeReviewOutput(frames("Bash",valid)),stdout:""});
 expect((await worker.fix(copy,[annotation])).actualModel).toBe("actual-sonnet");expect(raw).toHaveBeenCalledTimes(2);
 raw.mockReset().mockResolvedValue({...claudeReviewOutput(frames("Bash",{})),stdout:""});await expect(worker.fix(copy,[annotation])).rejects.toThrow("两次修改");expect(raw).toHaveBeenCalledTimes(2);
 raw.mockReset().mockRejectedValue(new Error("process failed"));await expect(worker.fix(copy,[annotation])).rejects.toThrow("process failed");expect(raw).toHaveBeenCalledTimes(1);
});
it("caches both phase probes by runtime fingerprint and repeats them when it changes",async()=>{
 const worker=new ClaudeReviewWorker({version:1,profileId:"native",kind:"claude-code-cli",label:"native",enabled:true,priority:0,timeoutMs:1000,executablePath:"/fixture/claude"},{});
 const hook=worker as unknown as {runtime:()=>Promise<ClaudeReviewRuntime>};let fingerprint="unit-cache-first";
 vi.spyOn(hook,"runtime").mockImplementation(async()=>({...runtime,fingerprint}));
 const probe=vi.spyOn(probeModule,"probeClaudeReview").mockResolvedValue(undefined);
 await worker.capability(copy);await worker.capability(copy);expect(probe).toHaveBeenCalledTimes(2);
 fingerprint="unit-cache-second";await worker.capability(copy);expect(probe).toHaveBeenCalledTimes(4);
});
