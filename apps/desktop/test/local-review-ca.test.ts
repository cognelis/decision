import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { ReviewCommandSandbox } from "../src/main/local-review-command-sandbox.js";
import { ReviewLaunchdLabels } from "../src/main/local-review-launchd.js";
import { reviewToolEnvironment, reviewExtraCAFiles } from "../src/main/local-review-tools.js";
vi.mock("../src/main/login-shell-path.js", () => ({ loginShellPath: async (env: NodeJS.ProcessEnv) => env.PATH ?? "" }));
const roots: string[] = [];
afterEach(async()=>{vi.restoreAllMocks();for(const root of roots.splice(0))await rm(root,{recursive:true,force:true});});
it.skipIf(process.platform!=="darwin")("selects system CA without disabling verification and retains the explicit extra CA path",()=>{
 const copy={directory:"/job",tree:"/job/tree",git:"/job/git"};
 const env=reviewToolEnvironment(copy,[],{NODE_EXTRA_CA_CERTS:"/certs/extra.pem",SSL_CERT_FILE:"/untrusted/override",NODE_TLS_REJECT_UNAUTHORIZED:"0"});
 expect(env.SSL_CERT_FILE).toBe("/etc/ssl/cert.pem");expect(env.NODE_EXTRA_CA_CERTS).toBe("/certs/extra.pem");expect(env).not.toHaveProperty("NODE_TLS_REJECT_UNAUTHORIZED");
});
it.skipIf(process.platform!=="darwin")("loads one extra CA file at Node startup and denies siblings in the same directory",async()=>{
 const root=await realpath(await mkdtemp(join(tmpdir(),"lr-ca-")));roots.push(root);const copy={directory:join(root,"copy"),tree:join(root,"copy/tree"),git:join(root,"copy/git")},certs=join(root,"private-certs");
 for(const path of [copy.tree,copy.git,certs])await mkdir(path,{recursive:true});
 const certificate=join(certs,"roots.pem"),alias=join(certs,"selected.pem"),secret=join(certs,"unrelated.secret");await writeFile(certificate,await readFile("/etc/ssl/cert.pem"));await symlink(certificate,alias);await writeFile(secret,"PRIVATE_CANARY");
 vi.spyOn(ReviewLaunchdLabels.prototype,"snapshot").mockResolvedValue([]);
 const sandbox=new ReviewCommandSandbox({...process.env,PATH:dirname(process.execPath)+":/usr/bin:/bin",NODE_EXTRA_CA_CERTS:alias});await sandbox.probe(copy);expect(sandbox.available,sandbox.reason??"").toBe(true);
 const result=await sandbox.run(["node","-e",`const fs=require('node:fs'),tls=require('node:tls');let denied=false;try{fs.readFileSync(${JSON.stringify(secret)})}catch(error){denied=['EPERM','EACCES'].includes(error.code)}console.log(JSON.stringify({system:process.env.SSL_CERT_FILE,extra:process.env.NODE_EXTRA_CA_CERTS,count:tls.getCACertificates('extra').length,denied}));`]);
 expect(result.exitCode,result.stderr).toBe(0);expect(JSON.parse(result.stdout)).toMatchObject({system:"/etc/ssl/cert.pem",extra:alias,denied:true});expect(JSON.parse(result.stdout).count).toBeGreaterThan(0);
});

it("rejects relative or directory CA settings without granting their contents",async()=>{
 await expect(reviewExtraCAFiles({NODE_EXTRA_CA_CERTS:"relative.pem"})).rejects.toThrow("绝对文件路径");
 const root=await realpath(await mkdtemp(join(tmpdir(),"lr-ca-setting-")));roots.push(root);
 await expect(reviewExtraCAFiles({NODE_EXTRA_CA_CERTS:root})).rejects.toThrow("普通证书文件");
});
