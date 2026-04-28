import { createHash } from "crypto";

export type ReflectionKind = "entity_summary" | "belief" | "rule" | "memory_health";

export type HealthStatus = "healthy" | "watch" | "degraded" | "critical";

export interface EvidenceLink {
  factId?: string | null;
  episodeId?: string | null;
  segmentId?: string | null;
  memoryId?: string | null;
  edgeId?: string | null;
  eventFrameId?: string | null;
  usageId?: string | null;
}

export interface ReflectionFingerprintInput {
  tenant: string;
  kind: ReflectionKind;
  subjectId?: string | null;
  scopePath?: string | null;
  statement: string;
  evidence: EvidenceLink[];
}

export interface MemoryUsageMetrics {
  totalMemoryCount: number;
  unsupportedCount: number;
  staleCount: number;
  contradictionCount: number;
  evidenceGapCount?: number;
}

export interface BeliefCandidate {
  kind: "belief";
  tenant: string;
  beliefText: string;
  confidence: number;
  evidence: EvidenceLink[];
  beliefFingerprint: string;
}

function normalizePart(value: string | null | undefined): string {
  return (value ?? "").trim().toLowerCase();
}

function evidenceKey(evidence: EvidenceLink): string {
  return [
    evidence.factId ? `fact:${normalizePart(evidence.factId)}` : "",
    evidence.episodeId ? `episode:${normalizePart(evidence.episodeId)}` : "",
    evidence.segmentId ? `segment:${normalizePart(evidence.segmentId)}` : "",
    evidence.memoryId ? `memory:${normalizePart(evidence.memoryId)}` : "",
    evidence.edgeId ? `edge:${normalizePart(evidence.edgeId)}` : "",
    evidence.eventFrameId ? `event-frame:${normalizePart(evidence.eventFrameId)}` : "",
    evidence.usageId ? `usage:${normalizePart(evidence.usageId)}` : "",
  ].filter(Boolean).join(",");
}

export function hasEvidenceSource(evidence: EvidenceLink): boolean {
  return Boolean(evidenceKey(evidence));
}

export function requireEvidenceLinks(evidence: EvidenceLink[]): EvidenceLink[] {
  const linked = evidence.filter(hasEvidenceSource);
  if (linked.length === 0) {
    throw new Error("Derived reflection items require at least one evidence link");
  }
  return linked;
}

export function reflectionFingerprint(input: ReflectionFingerprintInput): string {
  const evidenceKeys = requireEvidenceLinks(input.evidence)
    .map(evidenceKey)
    .sort()
    .join("|");
  const raw = [
    "reflection-v1",
    `tenant=${normalizePart(input.tenant)}`,
    `kind=${input.kind}`,
    `subject=${normalizePart(input.subjectId)}`,
    `scope=${normalizePart(input.scopePath)}`,
    `statement=${normalizePart(input.statement)}`,
    `evidence=${evidenceKeys}`,
  ].join("|");
  return createHash("sha256").update(raw, "utf-8").digest("hex");
}

export function clampConfidence(value: number): number {
  if (!Number.isFinite(value)) return 0.5;
  return Math.max(0, Math.min(1, value));
}

export function classifyMemoryHealth(metrics: MemoryUsageMetrics): HealthStatus {
  const total = Math.max(0, metrics.totalMemoryCount);
  const unsupportedRatio = total === 0 ? 0 : metrics.unsupportedCount / total;
  const staleRatio = total === 0 ? 0 : metrics.staleCount / total;
  const evidenceGaps = metrics.evidenceGapCount ?? 0;

  if (metrics.contradictionCount > 0 || unsupportedRatio >= 0.25 || evidenceGaps >= 10) {
    return "critical";
  }
  if (unsupportedRatio >= 0.1 || staleRatio >= 0.25 || evidenceGaps > 0) {
    return "degraded";
  }
  if (unsupportedRatio > 0 || staleRatio > 0) {
    return "watch";
  }
  return "healthy";
}

export function createBeliefCandidate(input: {
  tenant: string;
  beliefText: string;
  confidence: number;
  subjectId?: string | null;
  scopePath?: string | null;
  evidence: EvidenceLink[];
}): BeliefCandidate {
  const evidence = requireEvidenceLinks(input.evidence);
  return {
    kind: "belief",
    tenant: input.tenant,
    beliefText: input.beliefText,
    confidence: clampConfidence(input.confidence),
    evidence,
    beliefFingerprint: reflectionFingerprint({
      tenant: input.tenant,
      kind: "belief",
      subjectId: input.subjectId,
      scopePath: input.scopePath,
      statement: input.beliefText,
      evidence,
    }),
  };
}
