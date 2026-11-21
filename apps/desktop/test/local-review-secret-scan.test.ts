import { expect, it } from "vitest";
import { reviewSecretFindings } from "../src/main/local-review-secret-scan.js";
const patch=(content:string,path="source.txt")=>`diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -2,2 +2,3 @@\n context\n-removed sk-ant-old\n+${content}\n+safe\n`;
it.each(['sk-ant-synthetic-only','{"auth_mode":"chatgpt"}','"access_token": "synthetic-long-token"','"refreshToken": "synthetic-long-token"','"claudeAiOauth": {','keychain: "synthetic.keychain-db"','class: "genp"','    "acct"<blob>="synthetic"'])("returns only the path and new line for a fixed secret shape: %s",value=>{
  const hits=reviewSecretFindings(patch(value));expect(hits).toEqual([{path:"source.txt",line:3}]);expect(JSON.stringify(hits)).not.toContain(value);
});
it("ignores context and deleted secrets and keeps new-line accounting across hunks",()=>{
 expect(reviewSecretFindings(patch("ordinary code"))).toEqual([]);
 expect(reviewSecretFindings(patch('safe')+'@@ -50,1 +51,1 @@\n-old\n+sk-ant-synthetic\n')).toEqual([{path:"source.txt",line:51}]);
});
it("decodes quoted paths and treats header-looking added text as content",()=>{
 const diff='diff --git "a/a b.txt" "b/a b.txt"\n--- "a/a b.txt"\n+++ "b/a b.txt"\n@@ -0,0 +1,2 @@\n++++ sk-ant-synthetic\n+safe\n';
 expect(reviewSecretFindings(diff)).toEqual([{path:"a b.txt",line:1}]);
});
it("rejects malformed paths without echoing the input",()=>{
 expect(()=>reviewSecretFindings('diff --git a/x b/x\n+++ "bad\\q"\n@@ -0,0 +1 @@\n+sk-ant-synthetic')).toThrow("无法解析");
});
