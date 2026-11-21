import { expect, it, vi } from "vitest";
import { ReviewLaunchdLabels, reviewLaunchdLabels, addedReviewLaunchdLabels } from "../src/main/local-review-launchd.js";
import { ManagedChildProcessRunner } from "../src/main/model/cli/managed-child-process.js";
it("keeps labels only and compares additions rather than PID/status or removals",()=>{
  expect(reviewLaunchdLabels("PID\tStatus\tLabel\n123\t0\tcom.example.a\n-\t-9\tlabel with spaces\n")).toEqual(["com.example.a","label with spaces"]);
  expect(addedReviewLaunchdLabels(["a","removed"],["a","new","new"])).toEqual(["new"]);
  expect(addedReviewLaunchdLabels(["stable"],["stable","application.gui.123","application.attacker","applicationx.visible","com.apple.mdworker.shared.123","com.apple.attacker","com.applex.visible","new"])).toEqual(["applicationx.visible","com.applex.visible","new"]);
  expect(()=>reviewLaunchdLabels("unexpected output")).toThrow("无法解析");
});
it.skipIf(process.platform!=="darwin")("the host reader invokes only absolute launchctl list with no inherited credentials",async()=>{
  const runner=new ManagedChildProcessRunner(),run=vi.spyOn(runner,"run").mockResolvedValue({exitCode:0,stdout:"PID\tStatus\tLabel\n-\t0\tstable\n",stderr:"",durationMs:0});
  expect(await new ReviewLaunchdLabels(runner).snapshot()).toEqual(["stable"]);expect(run).toHaveBeenCalledWith(expect.objectContaining({executable:"/bin/launchctl",args:["list"],environment:{PATH:"/usr/bin:/bin",LANG:"C"}}));
});
