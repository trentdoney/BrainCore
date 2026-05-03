export const TARGET_KINDS = ["fact", "memory", "procedure", "event_frame", "working_memory"] as const;
export type LifecycleTargetKind = typeof TARGET_KINDS[number];

export const LIFECYCLE_STATUSES = [
  "candidate",
  "archived",
  "active",
  "review_required",
  "validated",
  "disputed",
  "suppressed",
  "retired",
] as const;
export type LifecycleStatus = typeof LIFECYCLE_STATUSES[number];

export const FEEDBACK_SIGNALS = [
  "retrieved_not_injected",
  "injected_referenced",
  "injected_ignored",
  "injected_contradicted",
  "led_to_success",
  "led_to_failure",
  "user_corrected",
  "user_confirmed",
  "admin_suppressed",
  "admin_promoted",
] as const;
export type FeedbackSignal = typeof FEEDBACK_SIGNALS[number];

export const LIFECYCLE_EVENT_TYPES = [
  "mission_started",
  "mission_completed",
  "mission_failed",
  "session_started",
  "session_completed",
  "session_failed",
  "model_call_started",
  "model_call_completed",
  "model_call_failed",
  "tool_called",
  "tool_completed",
  "tool_failed",
  "approval_decided",
  "user_corrected",
  "context_compacted",
  "memory_retrieved",
  "memory_injected",
  "memory_omitted",
  "memory_feedback",
  "memory_written",
  "memory_suppressed",
  "memory_retired",
  "memory_promoted",
  "admin_memory_suppressed",
  "admin_memory_retired",
  "admin_memory_promoted",
  "admin_memory_disputed",
  "admin_feedback_resolved",
  "admin_policy_override",
  "artifact_archived",
  "extraction_completed",
  "fact_inserted",
  "memory_consolidated",
  "procedure_used",
  "working_memory_added",
  "working_memory_promoted",
] as const;
export type LifecycleEventType = typeof LIFECYCLE_EVENT_TYPES[number];

export const LIFECYCLE_CUE_TYPES = [
  "entity",
  "action",
  "tool",
  "failure_mode",
  "goal",
  "file_path",
  "policy",
  "user_preference",
  "environment",
  "project",
  "procedure",
  "session",
] as const;
export type LifecycleCueType = typeof LIFECYCLE_CUE_TYPES[number];

export const LIFECYCLE_CUE_EXTRACTION_METHODS = [
  "template",
  "keyword",
  "entity",
  "llm",
  "manual",
] as const;
export type LifecycleCueExtractionMethod = typeof LIFECYCLE_CUE_EXTRACTION_METHODS[number];

export interface LifecycleTarget {
  targetKind: LifecycleTargetKind;
  targetId: string;
}

export interface JsonObject {
  [key: string]: unknown;
}

export function isTargetKind(value: string | undefined): value is LifecycleTargetKind {
  return TARGET_KINDS.includes(value as LifecycleTargetKind);
}

export function isLifecycleStatus(value: string | undefined): value is LifecycleStatus {
  return LIFECYCLE_STATUSES.includes(value as LifecycleStatus);
}

export function isFeedbackSignal(value: string | undefined): value is FeedbackSignal {
  return FEEDBACK_SIGNALS.includes(value as FeedbackSignal);
}

export function isLifecycleEventType(value: string | undefined): value is LifecycleEventType {
  return LIFECYCLE_EVENT_TYPES.includes(value as LifecycleEventType);
}

export function isLifecycleCueType(value: string | undefined): value is LifecycleCueType {
  return LIFECYCLE_CUE_TYPES.includes(value as LifecycleCueType);
}

export function isLifecycleCueExtractionMethod(value: string | undefined): value is LifecycleCueExtractionMethod {
  return LIFECYCLE_CUE_EXTRACTION_METHODS.includes(value as LifecycleCueExtractionMethod);
}
