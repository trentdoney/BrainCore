import type postgres from "postgres";
import { buildBrainCoreSnapshot, type BrainCoreSnapshotOptions } from "./snapshot";

export interface ShadowEvalCase {
  name: string;
  cwd: string;
  gitRoot?: string | null;
  prompt: string;
  expectedTerms?: string[];
  forbiddenTerms?: string[];
  expectEmpty?: boolean;
  maxTokens?: number;
}

export interface ShadowEvalCaseResult {
  name: string;
  useful: boolean;
  badRecall: boolean;
  injected: boolean;
  promptEligible: number;
  retrieved: number;
  tokenEstimate: number;
  truncated: boolean;
  missingExpected: string[];
  matchedForbidden: string[];
  expectEmpty: boolean;
}

export interface ShadowEvalResult {
  total: number;
  useful: number;
  badRecall: number;
  truncated: number;
  empty: number;
  usefulRate: number;
  badRecallRate: number;
  truncationRate: number;
  passed: boolean;
  cases: ShadowEvalCaseResult[];
}

export async function runBrainCoreShadowEval(sql: postgres.Sql, cases: ShadowEvalCase[]): Promise<ShadowEvalResult> {
  const results: ShadowEvalCaseResult[] = [];
  for (const testCase of cases) {
    const snapshotOptions: BrainCoreSnapshotOptions = {
      cwd: testCase.cwd,
      gitRoot: testCase.gitRoot,
      prompt: testCase.prompt,
      maxTokens: testCase.maxTokens ?? 800,
      mode: "shadow",
    };
    const snapshot = await buildBrainCoreSnapshot(sql, snapshotOptions);
    const haystack = snapshot.markdown.toLowerCase();
    const missingExpected = (testCase.expectedTerms ?? []).filter((term) => !haystack.includes(term.toLowerCase()));
    const matchedForbidden = (testCase.forbiddenTerms ?? []).filter((term) => haystack.includes(term.toLowerCase()));
    const expectEmpty = testCase.expectEmpty === true;
    const hasPromptPackage = snapshot.recall.promptPackage.length > 0;
    const useful = expectEmpty
      ? !hasPromptPackage && matchedForbidden.length === 0
      : hasPromptPackage && ((testCase.expectedTerms?.length ?? 0) === 0 || missingExpected.length === 0);
    const badRecall = matchedForbidden.length > 0 || (expectEmpty && hasPromptPackage);
    results.push({
      name: testCase.name,
      useful,
      badRecall,
      injected: snapshot.recall.injected,
      promptEligible: snapshot.recall.promptPackage.length,
      retrieved: snapshot.recall.results.length,
      tokenEstimate: snapshot.tokenEstimate,
      truncated: snapshot.truncated,
      missingExpected,
      matchedForbidden,
      expectEmpty,
    });
  }
  const total = results.length;
  const useful = results.filter((result) => result.useful).length;
  const badRecall = results.filter((result) => result.badRecall).length;
  const truncated = results.filter((result) => result.truncated).length;
  const empty = results.filter((result) => result.promptEligible === 0).length;
  const positiveTotal = results.filter((result) => !result.expectEmpty).length;
  const positiveUseful = results.filter((result) => !result.expectEmpty && result.useful).length;
  const usefulRate = positiveTotal ? positiveUseful / positiveTotal : (total ? useful / total : 0);
  const badRecallRate = total ? badRecall / total : 0;
  const truncationRate = total ? truncated / total : 0;
  return {
    total,
    useful,
    badRecall,
    truncated,
    empty,
    usefulRate,
    badRecallRate,
    truncationRate,
    passed: total > 0 && usefulRate >= 0.7 && badRecallRate < 0.1 && truncationRate < 0.25,
    cases: results,
  };
}
