import { closeSync, constants, fstatSync, mkdirSync, renameSync, symlinkSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ReviewFileTree, reviewNativeFs, REVIEW_FILE_BYTES, type ReviewNativeFs } from "../src/main/local-review-filesystem.js";
const roots: string[] = [], trees: ReviewFileTree[] = [];
afterEach(async () => { for (const tree of trees.splice(0)) tree.close(); for (const root of roots.splice(0)) await rm(root,{recursive:true,force:true}); });
async function fixture() {
  const root=await mkdtemp(join(tmpdir(),"review-fs-"));roots.push(root);const work=join(root,"tree"),outside=join(root,"outside");await mkdir(work);await mkdir(outside);await writeFile(join(outside,"secret"),"PRIVATE");return {root,work,outside};
}
const openTree=(root:string,native?:ReviewNativeFs)=>{const tree=new ReviewFileTree(root,native);trees.push(tree);return tree;};
describe.skipIf(!["darwin","linux"].includes(process.platform))("descriptor anchored review files",()=>{
  it("records only host writes, requires a unique edit and handles create/delete",async()=>{
    const f=await fixture();await writeFile(join(f.work,"source"),"aaa\nold\nold");const tree=openTree(f.work);
    expect(()=>tree.edit("source","old","new")).toThrow("恰好");expect(()=>tree.edit("source","aa","new")).toThrow("恰好");
    tree.edit("source","aaa","header");tree.write("nested/new","created");expect(tree.read("nested/new")).toBe("created");tree.delete("nested/new");
    await writeFile(join(f.work,"command-output"),"not declared");expect([...tree.changedFiles].sort()).toEqual(["nested/new","source"]);
  });
  it.each(["../outside/secret","/tmp/secret",".git/config","a/.GiT/config","a//b","a/../b","a\\b"])("refuses escape path %s",async path=>{
    const f=await fixture(),tree=openTree(f.work);expect(()=>tree.read(path)).toThrow();expect(()=>tree.write(path,"bad")).toThrow();expect(()=>tree.delete(path)).toThrow();expect(tree.changedFiles.size).toBe(0);
  });
  it("never follows leaf or parent symlinks and omits them from inventory",async()=>{
    const f=await fixture();await symlink(join(f.outside,"secret"),join(f.work,"link"));await symlink(f.outside,join(f.work,"dir"));const tree=openTree(f.work);
    expect(()=>tree.read("link")).toThrow();expect(()=>tree.write("link","bad")).toThrow();expect(()=>tree.write("dir/new","bad")).toThrow();expect(()=>tree.delete("link")).toThrow();expect(()=>tree.list("dir")).toThrow();
    expect(tree.list().files).toEqual([]);expect(tree.list().skipped.sort()).toEqual(["dir","link"]);expect(await readFile(join(f.outside,"secret"),"utf8")).toBe("PRIVATE");
  });
  it("refuses a parent replaced after it was opened, without writing through the new symlink",async()=>{
    const f=await fixture();await mkdir(join(f.work,"nested"));await writeFile(join(f.work,"nested/secret"),"inside");const native=reviewNativeFs();let swapped=false;
    const ops:ReviewNativeFs={entries:native.entries,mkdirAt:native.mkdirAt,unlinkAt:native.unlinkAt,machLookup:native.machLookup,openAt:(fd,name,flags,mode)=>{const opened=native.openAt(fd,name,flags,mode);if(name==="nested"&&!swapped){swapped=true;renameSync(join(f.work,"nested"),join(f.work,"retired"));symlinkSync(f.outside,join(f.work,"nested"));}return opened;}};
    const tree=openTree(f.work,ops);expect(()=>tree.write("nested/secret","bad")).toThrow();expect(await readFile(join(f.outside,"secret"),"utf8")).toBe("PRIVATE");expect(await readFile(join(f.work,"retired/secret"),"utf8")).toBe("inside");
  });
  it("anchors creation to the open parent even if its pathname changes immediately before openAt",async()=>{
    const f=await fixture();await mkdir(join(f.work,"nested"));const native=reviewNativeFs();let swapped=false;
    const ops:ReviewNativeFs={entries:native.entries,mkdirAt:native.mkdirAt,unlinkAt:native.unlinkAt,machLookup:native.machLookup,openAt:(fd,name,flags,mode)=>{if(name==="new"&&!swapped){swapped=true;renameSync(join(f.work,"nested"),join(f.work,"retired"));symlinkSync(f.outside,join(f.work,"nested"));}return native.openAt(fd,name,flags,mode);}};
    const tree=openTree(f.work,ops);expect(()=>tree.write("nested/new","bad")).toThrow();expect(await readFile(join(f.outside,"new")).catch(()=>null)).toBeNull();expect(tree.changedFiles.size).toBe(0);
  });
  it("lists a directory named with one natural trailing slash exactly like the bare name, and still refuses every escape",async()=>{
    const f=await fixture();await mkdir(join(f.work,"base/src"),{recursive:true});await writeFile(join(f.work,"base/src/a.js"),"a");await writeFile(join(f.work,"top.txt"),"t");const tree=openTree(f.work);
    expect(tree.list("base/").files).toEqual(["base/src/a.js"]);expect(tree.list("base/").files).toEqual(tree.list("base").files);expect(tree.list("base/src/").files).toEqual(["base/src/a.js"]);
    for(const bad of ["/","//","../","../outside/","base//",".git/","base/../","a\\b/","/tmp/"])expect(()=>tree.list(bad),bad).toThrow();
    expect(tree.list().files.sort()).toEqual(["base/src/a.js","top.txt"]);
  });
  it("does not spend default inventory on 5100 dependency files but admits an explicit prefix",async()=>{
    const f=await fixture();await mkdir(join(f.work,"node_modules"));await writeFile(join(f.work,"source.txt"),"original");
    for(let i=0;i<5100;i+=100)await Promise.all(Array.from({length:100},(_,j)=>writeFile(join(f.work,"node_modules",`${i+j}.js`),"dependency")));
    const tree=openTree(f.work);expect(tree.list().files).toEqual(["source.txt"]);expect(tree.list().truncated).toBe(false);expect(tree.list("node_modules").files.length).toBeGreaterThan(0);expect(tree.list("node_modules").truncated).toBe(true);expect(tree.read("node_modules/0.js")).toBe("dependency");
  });
  it("bounds file bytes, refuses binary data and excludes Git metadata",async()=>{
    const f=await fixture();await mkdir(join(f.work,".git"));await writeFile(join(f.work,".git/config"),"PRIVATE");await writeFile(join(f.work,"large"),Buffer.alloc(REVIEW_FILE_BYTES+1));await writeFile(join(f.work,"binary"),"a\0b");const tree=openTree(f.work);
    expect(()=>tree.read("large")).toThrow("2 MiB");expect(()=>tree.read("binary")).toThrow("二进制");expect(()=>tree.write("new","x".repeat(REVIEW_FILE_BYTES+1))).toThrow();expect(tree.list().files).not.toContain(".git/config");
  });
});
