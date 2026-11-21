import { randomUUID } from "node:crypto";
import { z } from "zod";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ModelProviderProfile, StructuredGenerationRequest } from "@cognelis/decision-protocol";
import type { AssistantGatewayLike } from "../src/main/decision-assistant-service.js";
import { PiReviewWorker, piReviewActions } from "../src/main/local-review-pi-worker.js";
import { ReviewLaunchdLabels } from "../src/main/local-review-launchd.js";
import { ReviewCommandSandbox } from "../src/main/local-review-command-sandbox.js";
import { createLocalReviewWorker } from "../src/main/local-review-workers.js";
const roots:string[]=[];
beforeEach(()=>{vi.spyOn(ReviewCommandSandbox.prototype,"probe").mockImplementation(async function(this:ReviewCommandSandbox){this.reason="synthetic probe failed; no command tool";});});
afterEach(async()=>{vi.restoreAllMocks();for(const root of roots.splice(0))await rm(root,{recursive:true,force:true});});
const profile:ModelProviderProfile={version:1,profileId:"claude",kind:"claude-code-cli",label:"Claude model",enabled:true,priority:0,timeoutMs:1000,model:"sonnet",executablePath:"/synthetic/claude"};
async function fixture(values:unknown[]){const root=await mkdtemp(join(tmpdir(),"pi-review-"));roots.push(root);for(const name of ["tree","git"])await mkdir(join(root,name));await writeFile(join(root,"tree/source.js"),"before\n");await writeFile(join(root,"tree/cache.bin"),"command output");
 const requests:StructuredGenerationRequest[]=[];const gateway:AssistantGatewayLike={listGenerationProfiles:async()=>[profile],async generate<T>(request:StructuredGenerationRequest,parse:(value:unknown)=>T){requests.push(request);if(!values.length)throw new Error("No model fixture left");return {requestId:request.requestId,attemptId:randomUUID(),profileId:profile.profileId,backend:profile.kind,provider:"synthetic",model:"actual-sonnet",visibleOutput:"",parsedOutput:parse(values.shift()),usage:{source:"provider_reported",inputTokens:1,outputTokens:1,totalTokens:2},providerDurationMs:0};}};
 return {root,requests,gateway,copy:{directory:root,tree:join(root,"tree"),git:join(root,"git")}};}
const annotation={id:randomUUID(),path:"source.js",side:"new" as const,startLine:1,endLine:1,lineText:"before",body:"fix"};
const fixed={outcomes:[{id:annotation.id,outcome:"fixed",summary:"fixed"}],commitTitle:"修复示例",verification:"model claimed tests"};
it("selects explicit workers independently of the model profile and allows only a matching Claude native profile",async()=>{
 const f=await fixture([]);expect(createLocalReviewWorker("pi",profile,{},f.gateway)).toBeInstanceOf(PiReviewWorker);
 expect(()=>createLocalReviewWorker("codex",profile,{})).toThrow("不匹配");expect(createLocalReviewWorker("claude-code",profile,{},f.gateway).constructor.name).toBe("ClaudeReviewWorker");
 expect(()=>createLocalReviewWorker("pi",profile,{})).toThrow("gateway");expect(createLocalReviewWorker("codex",{...profile,kind:"codex-cli"},{}).constructor.name).toBe("LocalReviewAgent");
});
it("uses the Agent/gateway loop, host-edits and only auto-declares files written by tools",async()=>{
 const f=await fixture([{actions:[{action:"read_file",path:"source.js"}]},{actions:[{action:"edit_file",path:"source.js",oldText:"before",newText:"after"}]},{actions:[{action:"submit_result",result:{...fixed,changedFiles:["cache.bin"]}}]}]);
 const result=await new PiReviewWorker(profile,f.gateway).fix(f.copy,[annotation]);
 expect(await readFile(join(f.copy.tree,"source.js"),"utf8")).toBe("after\n");expect(result.changedFiles).toEqual(["source.js"]);expect(result.verification).toContain("未执行命令测试");
 expect(f.requests).toHaveLength(3);expect(f.requests.every(request=>request.purpose==="local-review")).toBe(true);expect(JSON.stringify(f.requests[0]!.outputSchema)).not.toContain('"const":"run_command"');
});
it("evaluates read-only and preserves shared verdict/group validation",async()=>{
 const f=await fixture([{actions:[{action:"read_file",path:"source.js"}]},{actions:[{action:"submit_result",result:{verdicts:[{id:annotation.id,verdict:"accept",reason:"valid"}],groups:[]}}]}]);
 const result=await new PiReviewWorker(profile,f.gateway).evaluate(f.copy,[annotation]);expect(result.fallback).toBe("invalid_group_partition");expect(result.actualModel).toBe("actual-sonnet");expect(await readFile(join(f.copy.tree,"source.js"),"utf8")).toBe("before\n");
 expect(()=>piReviewActions(false,true).parse({actions:[{action:"write_file",path:"source.js",content:"bad"}]})).toThrow();
});
it("allows one invalid submit_result correction and fails on a second invalid conclusion",async()=>{
 let f=await fixture([{actions:[{action:"submit_result",result:{}}]},{actions:[{action:"submit_result",result:fixed}]}]);
 expect((await new PiReviewWorker(profile,f.gateway).fix(f.copy,[annotation])).outcomes[0]!.outcome).toBe("fixed");
 f=await fixture([{actions:[{action:"submit_result",result:{}}]},{actions:[{action:"submit_result",result:{}}]}]);await expect(new PiReviewWorker(profile,f.gateway).fix(f.copy,[annotation])).rejects.toThrow("两次");expect(f.requests).toHaveLength(2);
});
it("never executes actions after an accepted result in the same batch",async()=>{
 const f=await fixture([{actions:[{action:"submit_result",result:fixed},{action:"write_file",path:"source.js",content:"late mutation"}]}]);
 await new PiReviewWorker(profile,f.gateway).fix(f.copy,[annotation]);expect(await readFile(join(f.copy.tree,"source.js"),"utf8")).toBe("before\n");
});
it("rejects unknown actions and command requests when the command probe failed",()=>{
 expect(()=>piReviewActions(true,false).parse({actions:[{action:"run_command",argv:["node","--test"]}]})).toThrow();
 expect(()=>piReviewActions(true,true).parse({actions:[{action:"Bash",command:"free shell"}]})).toThrow();
});

it.skipIf(process.platform!=="darwin")("stops later Pi commands in the same batch after a label change and keeps labels out of model history",async()=>{
 vi.mocked(ReviewCommandSandbox.prototype.probe).mockRestore();
 vi.spyOn(ReviewLaunchdLabels.prototype,"snapshot").mockResolvedValueOnce(["stable"]).mockResolvedValueOnce(["stable","synthetic-private-label"]);
 const f=await fixture([{actions:[{action:"run_command",argv:["node","-e","require('node:fs').writeFileSync('first-ran','yes')"]},{action:"run_command",argv:["node","-e","require('node:fs').writeFileSync('second-ran','no')"]}]},{actions:[{action:"submit_result",result:fixed}]}]);
 const worker=new PiReviewWorker(profile,f.gateway), result=await worker.fix(f.copy,[annotation]);
 expect(await readFile(join(f.copy.tree,"first-ran"),"utf8")).toBe("yes");await expect(readFile(join(f.copy.tree,"second-ran"))).rejects.toThrow();
 expect(result.possibleLaunchdLabels).toEqual(["synthetic-private-label"]);expect(worker.possibleLaunchdLabels).toEqual(["synthetic-private-label"]);
 expect(result.verification).toContain("可能");expect(result.verification).toContain("exit=0");expect(JSON.stringify(f.requests)).not.toContain("synthetic-private-label");expect(f.requests[1]!.userPrompt).toContain("abnormal");
});

it("accepts the natural trailing slash on list/search prefixes in the production action schema but never an escape",()=>{
 const batch=piReviewActions(false,false);
 for(const prefix of ["base/","base/src/","base"])expect(batch.safeParse({actions:[{action:"list_files",prefix}]}).success,prefix).toBe(true);
 expect(batch.safeParse({actions:[{action:"search_code",query:"x",prefix:"base/"}]}).success).toBe(true);
 // The action schemas are also sent to the model as JSON Schema; a transform here would make that conversion throw.
 expect(()=>z.toJSONSchema(batch)).not.toThrow();expect(()=>z.toJSONSchema(piReviewActions(true,true))).not.toThrow();
 for(const prefix of ["/","../","base//","../outside/",".git/","/tmp/","a\\b/",""])expect(batch.safeParse({actions:[{action:"list_files",prefix}]}).success,prefix).toBe(false);
});
it("a discussion that lists base/ with a trailing slash completes instead of failing as invalid output",async()=>{
 const f=await fixture([{actions:[{action:"list_files",prefix:"base/"}]},{actions:[{action:"read_file",path:"base/source.js"}]},{actions:[{action:"submit_result",result:{reply:"好的",plan:null}}]}]);
 await mkdir(join(f.copy.tree,"base"),{recursive:true});await writeFile(join(f.copy.tree,"base/source.js"),"before\n");
 const answer=await new PiReviewWorker(profile,f.gateway).discuss(f.copy,{system:"SYS",input:"INPUT",viewNotes:"NOTES"});
 expect(answer).toMatchObject({reply:"好的",plan:null});expect(f.requests).toHaveLength(3);
});
