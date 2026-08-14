import { describe, expect, expectTypeOf, it } from "vitest";

import {
  DECISION_ANALYTICS_METHOD_NAMES,
  METHODOLOGY_RECORD_METHOD_NAMES,
  PRACTICE_ASSET_METHOD_NAMES,
  type DecisionAnalyticsApi,
  type MethodologyRecordsApi,
  type MethodologyWorkspaceApi,
  type PracticeAssetsApi,
} from "../src/shared/renderer-api.js";

const methodologyRecordMethods = [
  "acknowledgeMethodologyValidation",
  "clearMethodologyRelation",
  "commitMethodologyMarkdownImport",
  "createManualMethodology",
  "createManualMethodologyFromEvidence",
  "createMethodologyMergeDraft",
  "createMethodologyRevisionDraft",
  "deferMethodologySuggestion",
  "deleteManualFormDraft",
  "generateMethodology",
  "getDeferredMethodologySuggestions",
  "getKnowledgeGraph",
  "getMethodologyBuildProgress",
  "getMethodologyEvidenceMatches",
  "getMethodologyMergePlan",
  "getMethodologySuggestions",
  "getMethodologyUsage",
  "getMethodologyValidationInbox",
  "importMethodologyMarkdown",
  "listDecisions",
  "listManualFormDrafts",
  "listMethodologies",
  "listMethodologyVersions",
  "openSurface",
  "prepareMethodologyMergeAsset",
  "restoreMethodologyMergeSources",
  "restoreMethodologySuggestion",
  "restoreMethodologyVersion",
  "retireMethodologyMergeSources",
  "reviseMethodology",
  "saveManualFormDraft",
  "setMethodologyEvidence",
  "setMethodologyRelation",
  "setMethodologyStatus",
] as const;

const analyticsMethods = [
  "getDecisionAnalytics",
  "getDecisionConsultationMetrics",
  "previewDecisionConsultation",
  "submitDecisionConsultationFeedback",
] as const;

const practiceAssetMethods = [
  "createManualPracticeAsset",
  "deleteManualFormDraft",
  "generatePracticeAsset",
  "listManualFormDrafts",
  "listMethodologies",
  "listPracticeAssets",
  "listPracticeAssetVersions",
  "listPracticePublicationStatuses",
  "publishPracticeAsset",
  "regeneratePracticeAsset",
  "restorePracticeAssetVersion",
  "revisePracticeAsset",
  "rollbackPracticeAssetPublication",
  "saveManualFormDraft",
  "setPracticeAssetStatus",
] as const;

describe("renderer API capabilities", () => {
  it("keeps methodology records on an explicit API surface", () => {
    expect(METHODOLOGY_RECORD_METHOD_NAMES).toEqual(methodologyRecordMethods);
    expectTypeOf<keyof MethodologyRecordsApi>().toEqualTypeOf<
      (typeof methodologyRecordMethods)[number]
    >();
  });

  it("keeps analytics and consultation calibration isolated", () => {
    expect(DECISION_ANALYTICS_METHOD_NAMES).toEqual(analyticsMethods);
    expectTypeOf<keyof DecisionAnalyticsApi>().toEqualTypeOf<
      (typeof analyticsMethods)[number]
    >();
  });

  it("keeps practice assets isolated from unrelated renderer operations", () => {
    expect(PRACTICE_ASSET_METHOD_NAMES).toEqual(practiceAssetMethods);
    expectTypeOf<keyof PracticeAssetsApi>().toEqualTypeOf<
      (typeof practiceAssetMethods)[number]
    >();
  });

  it("composes the complete methodology workspace from the three capabilities", () => {
    expectTypeOf<keyof MethodologyWorkspaceApi>().toEqualTypeOf<
      | keyof MethodologyRecordsApi
      | keyof DecisionAnalyticsApi
      | keyof PracticeAssetsApi
    >();
  });
});

const rejectUnrelatedAnalyticsApi = (api: DecisionAnalyticsApi): void => {
  // @ts-expect-error Analytics cannot change global appearance.
  void api.setTheme;
};

const rejectUnrelatedPracticeApi = (api: PracticeAssetsApi): void => {
  // @ts-expect-error Practice assets cannot submit rationale capture.
  void api.submitRationale;
};

void rejectUnrelatedAnalyticsApi;
void rejectUnrelatedPracticeApi;
