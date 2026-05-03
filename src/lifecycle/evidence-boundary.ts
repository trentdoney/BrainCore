import type { FeedbackSignal, LifecycleEventType, LifecycleTargetKind } from "./types";

export class EvidenceBoundaryError extends Error {
  readonly code = "EVIDENCE_BOUNDARY_BLOCKED";

  constructor(message: string) {
    super(message);
    this.name = "EvidenceBoundaryError";
  }
}

const DURABLE_FACT_EVENT_TYPES = new Set<LifecycleEventType>([
  "approval_decided",
  "user_corrected",
  "fact_inserted",
]);

const REVIEW_FEEDBACK_SIGNALS = new Set<FeedbackSignal>([
  "injected_contradicted",
  "led_to_failure",
  "user_corrected",
]);

export function assertFeedbackMutationAllowed(input: {
  targetKind: LifecycleTargetKind;
  signal: FeedbackSignal;
  requestedNativeMutation?: boolean;
}): void {
  if (input.requestedNativeMutation) {
    throw new EvidenceBoundaryError(
      "Feedback may update lifecycle intelligence, cues, audits, and review pressure only; native truth/lifecycle mutation is blocked.",
    );
  }
}

export function assertLifecycleEventCanCreateTarget(input: {
  eventType: LifecycleEventType;
  targetKind: LifecycleTargetKind;
  evidenceRefs?: unknown[];
}): void {
  if (input.targetKind === "working_memory") return;

  if (input.targetKind !== "fact") {
    throw new EvidenceBoundaryError(
      "Lifecycle events cannot directly create durable memories, procedures, or event frames.",
    );
  }

  const hasSegmentEvidence = hasNonEmptySegmentEvidence(input.evidenceRefs ?? []);

  if (!DURABLE_FACT_EVENT_TYPES.has(input.eventType) || !hasSegmentEvidence) {
    throw new EvidenceBoundaryError(
      "Lifecycle fact creation requires an approved/corrected/fact_inserted event and an existing segment_id evidence ref.",
    );
  }
}

export function hasNonEmptySegmentEvidence(evidenceRefs: unknown[]): boolean {
  return evidenceRefs.some((ref) => {
    if (!ref || typeof ref !== "object" || !("segment_id" in ref)) return false;
    const segmentId = (ref as { segment_id?: unknown }).segment_id;
    return typeof segmentId === "string" && segmentId.trim().length > 0;
  });
}

export function assertAdminStatusMutationAllowed(input: {
  targetKind: LifecycleTargetKind;
  requestedNativeMutation?: boolean;
}): void {
  if (input.requestedNativeMutation) {
    throw new EvidenceBoundaryError(
      "Admin status changes in this release update lifecycle intelligence only, not native BrainCore truth/lifecycle columns.",
    );
  }
}

export function feedbackCreatesReview(signal: FeedbackSignal): boolean {
  return REVIEW_FEEDBACK_SIGNALS.has(signal);
}
