import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ReviewCommandSandbox, reviewCommandPolicy, validateCommandProbe } from "../src/main/local-review-command-sandbox.js";
import { ReviewLaunchdLabels } from "../src/main/local-review-launchd.js";
beforeEach(()=>{vi.spyOn(ReviewLaunchdLabels.prototype,"snapshot").mockResolvedValue(["stable-host"]);});
const roots:string[]=[];afterEach(async()=>{vi.restoreAllMocks();for(const root of roots.splice(0))await rm(root,{recursive:true,force:true});});
const keys=["com.apple.securityd.xpc","com.apple.SecurityServer","com.apple.secd"];
const valid=()=>({nonce:"n",node:true,outsideReadDenied:true,homeReadDenied:true,outsideWriteDenied:true,gitWriteDenied:true,networkDenied:true,credentialsHidden:true,workspaceWrite:true,tmp:"/scratch/inside",keychain:keys.map(service=>({service,status:1100}))});
it("requires every positive and negative assertion, nonce, scratch and zero network hits",()=>{
  expect(()=>validateCommandProbe(valid(),"n",0,"/scratch")).not.toThrow();
  for(const field of ["node","outsideReadDenied","homeReadDenied","outsideWriteDenied","gitWriteDenied","networkDenied","credentialsHidden","workspaceWrite"])expect(()=>validateCommandProbe({...valid(),[field]:false},"n",0,"/scratch")).toThrow();
  for(const patch of [{nonce:"wrong"},{tmp:"/scratch-other"},{keychain:[]},{keychain:keys.map(service=>({service,status:0}))}])expect(()=>validateCommandProbe({...valid(),...patch},"n",0,"/scratch")).toThrow();
  expect(()=>validateCommandProbe(valid(),"n",1,"/scratch")).toThrow();
});
it("generates default-deny with explicit metadata/write/keychain/network boundaries",()=>{
  const policy=reviewCommandPolicy({directory:"/job",tree:"/job/tree",git:"/job/git"},[{name:"node",executable:"/runtime/bin/node",prefix:"/runtime"}]);
  expect(policy).toContain("(deny default)");expect(policy).toContain('(allow file-read* (literal "/"))');expect(policy).not.toContain('(subpath "/")');expect(policy).toContain("(deny network*)");expect(policy).toContain('(deny file-read* process-exec (literal "/bin/launchctl"))');expect(policy).toContain('(subpath "/job/git") (literal "/job/tree/.git")');
  for(const name of keys)expect(policy).toContain(`(global-name "${name}")`);
  expect(policy).not.toContain('(subpath "/Users")');expect(policy).not.toContain('(allow mach-lookup (global-name "com.apple.securityd.xpc"))');
});
describe.skipIf(process.platform!=="darwin")("native command sandbox",()=>{
  it("proves Node, npm and Python execute with all command boundary probes passing",async()=>{
    const root=await realpath(await mkdtemp(join(tmpdir(),"review-command-")));roots.push(root);for(const part of ["tree","git"])await mkdir(join(root,part));
    const copy={directory:root,tree:join(root,"tree"),git:join(root,"git")};await writeFile(join(copy.tree,".git"),"gitdir: ../git\n");
    const sandbox=new ReviewCommandSandbox(process.env);await sandbox.probe(copy);
    expect(sandbox.available, sandbox.reason ?? "probe failed").toBe(true);
    expect(sandbox.reason).toBeNull();
    await writeFile(join(copy.tree,"test.cjs"),"require('node:test').test('works',()=>require('node:assert/strict').equal(2+2,5));");
    const before=await sandbox.run(["node","--test","test.cjs"]);expect(before.exitCode).toBe(1);expect(before.stdout).toContain("# fail 1");
    await writeFile(join(copy.tree,"test.cjs"),"require('node:test').test('works',()=>require('node:assert/strict').equal(2+2,4));");
    const result=await sandbox.run(["node","--test","test.cjs"]);expect(result.exitCode).toBe(0);expect(result.stdout).toContain("# pass 1");
    await writeFile(join(copy.tree,"package.json"), JSON.stringify({scripts:{test:"node --test test.cjs"}}));
    const npm=await sandbox.run(["npm","test"]);expect(npm.exitCode).toBe(0);expect(npm.stdout).toContain("# pass 1");
    const localhost=await sandbox.run(["node","-e","require('node:dns').lookup('localhost',(error,address)=>{if(error)throw error;console.log(address)})"]);expect(localhost.exitCode,localhost.stderr).toBe(0);expect(localhost.stdout).toMatch(/127\.0\.0\.1|::1/);
    const blocked=await sandbox.run(["node","-e","const fs=require('node:fs'),cp=require('node:child_process');for(const action of[()=>fs.readFileSync('/bin/launchctl'),()=>fs.copyFileSync('/bin/launchctl','copy-client')]){try{action();process.exit(9)}catch(error){if(error.code!=='EPERM'&&error.code!=='EACCES')throw error}}const child=cp.spawnSync('/bin/launchctl',[],{stdio:'ignore'});if(child.error?.code!=='EPERM'&&child.error?.code!=='EACCES')process.exit(10);console.log('LAUNCHCTL_FILE_DENIED');"]);expect(blocked.exitCode,blocked.stderr).toBe(0);expect(blocked.stdout).toContain("LAUNCHCTL_FILE_DENIED");
    const python=await sandbox.run(["python3","-c","print('PYTHON_POSITIVE_OK')"]);expect(python.exitCode).toBe(0);expect(python.stdout).toContain("PYTHON_POSITIVE_OK");
    await expect(sandbox.run(["/bin/sh","-c","echo unsafe"])).rejects.toThrow("固定工具链");
    const snapshots=vi.mocked(ReviewLaunchdLabels.prototype.snapshot);snapshots.mockResolvedValueOnce(["stable-host"]).mockResolvedValueOnce(["stable-host","synthetic-new-label"]);
    const anomaly=await sandbox.run(["node","-e","console.log('command completed')"]);expect(anomaly).toMatchObject({abnormal:true});expect(JSON.stringify(anomaly)).not.toContain("synthetic-new-label");expect(sandbox.possibleLaunchdLabels).toEqual(["synthetic-new-label"]);expect(sandbox.available).toBe(false);await expect(sandbox.run(["node","-e","console.log('must not run')"])).rejects.toThrow("可能");

  });
});
