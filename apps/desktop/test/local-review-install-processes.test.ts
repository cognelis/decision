import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createReviewSandboxFingerprint, reviewSandboxFingerprintRules, type ReviewSandboxFingerprint } from "../src/main/local-review-sandbox-fingerprint.js";
import { reviewNativeFs, type ReviewNativeFs } from "../src/main/local-review-filesystem.js";
import { ReviewInstallProcesses } from "../src/main/local-review-install-processes.js";
import { ManagedChildProcessRunner } from "../src/main/model/cli/managed-child-process.js";

const roots: string[] = [], children: ChildProcess[] = [];
afterEach(async () => { for (const child of children.splice(0)) { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); } for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const runtime = '(allow process-exec)(allow file-read-metadata)(allow file-read* file-map-executable (literal "/") (subpath "/System") (subpath "/usr/lib") (subpath "/bin") (literal "/private/var/select/sh") (literal "/dev/null"))(allow sysctl-read)';
async function fixture() { const root=await realpath(await mkdtemp(join(tmpdir(),"lr-fingerprint-")));roots.push(root);const a=join(root,"runs/a"),b=join(root,"runs/b");await mkdir(a,{recursive:true});await mkdir(b);return {root,a,b}; }
async function launch(root: string, profile: string) {
  const path=join(root,`profile-${children.length}.sb`);await writeFile(path,profile,{mode:0o600});
  const child=spawn("/usr/bin/sandbox-exec",["-f",path,"/bin/sh","-c",'printf READY; exec /bin/sleep 20'],{env:{PATH:"/usr/bin:/bin",LANG:"C"},stdio:["ignore","pipe","pipe"]});children.push(child);
  await new Promise<void>((resolve,reject)=>{let stderr="";child.stderr!.on("data",chunk=>stderr+=chunk);child.stdout!.once("data",()=>resolve());child.once("exit",()=>reject(new Error(stderr||"sandbox exited before READY")));const timer=setTimeout(()=>reject(new Error("sandbox startup timeout")),4000);timer.unref();});return child;
}
const policy=(fingerprint:ReviewSandboxFingerprint)=>'(version 1)(deny default)'+runtime+'\n'+reviewSandboxFingerprintRules(fingerprint).join('\n');
const list=(fingerprint:ReviewSandboxFingerprint)=>reviewNativeFs().sandboxProcesses!(fingerprint.names,fingerprint.allowed);
const alive=(pid:number)=>{try{process.kill(pid,0);return true}catch{return false}};
it("creates 32 unique random names with at least eight of each independent decision",()=>{
  for(let i=0;i<20;i++){const fingerprint=createReviewSandboxFingerprint();expect(fingerprint.names).toHaveLength(32);expect(new Set(fingerprint.names).size).toBe(32);expect(fingerprint.names.every(name=>/^[a-f0-9]{64}$/.test(name))).toBe(true);const count=fingerprint.allowed.filter(Boolean).length;expect(count).toBeGreaterThanOrEqual(8);expect(count).toBeLessThanOrEqual(24);}
});
describe.skipIf(process.platform!=="darwin")("native secret fingerprint attribution",()=>{
  it("unrelated-sandbox-must-not-match and concurrent runs never match each other",async()=>{
    const f=await fixture(),a=createReviewSandboxFingerprint(),b=createReviewSandboxFingerprint();
    const foreign=await launch(f.root,`(version 1)(allow default)(deny file-write-data (literal ${JSON.stringify(dirname(f.a))}))`),allow=await launch(f.root,'(version 1)(allow default)'),deny=await launch(f.root,'(version 1)(deny default)'+runtime),ownA=await launch(f.root,policy(a)),ownB=await launch(f.root,policy(b));
    for(const [fingerprint,own,other]of[[a,ownA,ownB],[b,ownB,ownA]] as const){const matches=list(fingerprint);expect(matches.some(p=>p.pid===own.pid)).toBe(true);for(const child of[foreign,allow,deny,other])expect(matches.some(p=>p.pid===child.pid)).toBe(false);}
    const native=reviewNativeFs(),identity=list(a).find(p=>p.pid===ownA.pid)!;expect(native.killSandboxProcess!(identity.pid,identity.seconds+1,identity.microseconds,a.names,a.allowed)).toBe(false);expect(native.killSandboxProcess!(identity.pid,identity.seconds,identity.microseconds,b.names,b.allowed)).toBe(false);expect(alive(ownA.pid!)).toBe(true);
    await new ReviewInstallProcesses(f.a,a,new ManagedChildProcessRunner()).reap();expect(alive(ownA.pid!)).toBe(false);for(const child of[foreign,allow,deny,ownB])expect(alive(child.pid!)).toBe(true);
    await new ReviewInstallProcesses(f.b,b,new ManagedChildProcessRunner()).reap();expect(alive(ownB.pid!)).toBe(false);for(const child of[foreign,allow,deny])expect(alive(child.pid!)).toBe(true);
  },20000);
  it.each(["false","EIO"])("continues other complete identity checks after one %s result but rejects the round",async failure=>{
    const f=await fixture(),fingerprint=createReviewSandboxFingerprint(),native=reviewNativeFs(),calls:number[]=[];let snapshots=0;
    const injected:ReviewNativeFs={openAt:native.openAt,mkdirAt:native.mkdirAt,unlinkAt:native.unlinkAt,entries:native.entries,machLookup:native.machLookup,sandboxProcesses:()=>snapshots++===0?[{pid:101,seconds:1,microseconds:0},{pid:102,seconds:2,microseconds:0}]:[],killSandboxProcess(pid){calls.push(pid);if(pid===101){if(failure==="EIO")throw new Error("injected EIO");return false;}return true;}};
    class AdmittedGuard extends ReviewInstallProcesses { override async assertReady(){} }
    await expect(new AdmittedGuard(f.a,fingerprint,new ManagedChildProcessRunner(),injected).reap()).rejects.toThrow();expect(calls).toEqual([101,102]);
  });
  it("never signals on interface failure, changed identity or a failed negative probe",async()=>{
    const f=await fixture(),fingerprint=createReviewSandboxFingerprint(),native=reviewNativeFs();let kills=0;
    const broken:ReviewNativeFs={openAt:native.openAt,mkdirAt:native.mkdirAt,unlinkAt:native.unlinkAt,entries:native.entries,machLookup:native.machLookup,sandboxProcesses(){throw new Error("SPI failure")},killSandboxProcess(){kills++;return false}};
    await expect(new ReviewInstallProcesses(f.a,fingerprint,new ManagedChildProcessRunner(),broken).reap()).rejects.toThrow("SPI failure");expect(kills).toBe(0);
    const own=await launch(f.root,policy(fingerprint)),identity=list(fingerprint).find(p=>p.pid===own.pid)!;
    const changing:ReviewNativeFs={...broken,sandboxProcesses:()=>[identity],killSandboxProcess(){kills++;return false}};
    // The startup negative control is itself mandatory, so a fake list that
    // cannot identify the real positive control must stop before any signal.
    await expect(new ReviewInstallProcesses(f.a,fingerprint,new ManagedChildProcessRunner(),changing).reap()).rejects.toThrow("探测");expect(kills).toBe(0);expect(alive(own.pid!)).toBe(true);
    const changed:ReviewNativeFs={...broken,sandboxProcesses:(names,bits)=>native.sandboxProcesses!(names,bits),killSandboxProcess(){kills++;return false}};
    await expect(new ReviewInstallProcesses(f.a,fingerprint,new ManagedChildProcessRunner(),changed).reap()).rejects.toThrow("不再确定");expect(kills).toBeGreaterThanOrEqual(1);expect(alive(own.pid!)).toBe(true);

  },15000);
});
