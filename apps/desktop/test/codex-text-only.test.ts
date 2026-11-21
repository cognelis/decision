import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { ModelProviderProfile } from "@cognelis/decision-protocol";
import { codexTextOnlyArguments, assertCodexTextOnlyEvents } from "../src/main/model/cli/codex-text-only.js";
const roots:string[]=[];afterEach(async()=>{for(const root of roots.splice(0))await rm(root,{recursive:true,force:true});});
it("rewrites only bundled public metadata and removes every advertised execution entry",async()=>{
 const root=await mkdtemp(join(tmpdir(),"codex-text-only-"));roots.push(root);const executable=join(root,"codex");await writeFile(executable,"fixture");
 const run=vi.fn(async()=>({stdout:JSON.stringify({models:[{slug:"fixture",apply_patch_tool_type:"freeform",node_repl_disabled:false,experimental_supported_tools:["edit"],tool_mode:"execution"}]}),stderr:"",exitCode:0,durationMs:0}));
 const profile:ModelProviderProfile={version:1,profileId:"codex",kind:"codex-cli",enabled:true,label:"model",priority:0,timeoutMs:1000,model:"fixture",executablePath:executable};
 const args=await codexTextOnlyArguments({run},profile,root,{});expect(run.mock.calls).toHaveLength(1);expect(args).toContain("features.shell_tool=false");expect(args).toContain("features.code_mode=false");expect(args).toContain("mcp_servers={}");
 const setting=args.find(arg=>arg.startsWith("model_catalog_json="))!;const catalog=JSON.parse(await readFile(JSON.parse(setting.slice("model_catalog_json=".length)),"utf8"));expect(catalog.models[0]).toMatchObject({apply_patch_tool_type:null,node_repl_disabled:true,experimental_supported_tools:[]});expect(catalog.models[0]).not.toHaveProperty("tool_mode");
 await expect(codexTextOnlyArguments({run},{...profile,model:"unknown"},root,{})).rejects.toThrow("内置目录");
});
it("rejects any execution or unknown event instead of treating it as model output",()=>{
 for(const type of ["command_execution","file_change","mcp_tool_call","new_tool"])expect(()=>assertCodexTextOnlyEvents(JSON.stringify({type:"item.completed",item:{type}}))).toThrow("执行工具");
 expect(()=>assertCodexTextOnlyEvents(JSON.stringify({type:"item.completed",item:{type:"agent_message",text:"{}"}}))).not.toThrow();
});
