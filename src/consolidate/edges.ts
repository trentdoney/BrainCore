import { createHash } from "crypto";

export interface MemoryEdgeFingerprintInput {
  tenant: string;
  sourceType: "fact" | "memory" | "episode" | "entity" | "event";
  sourceId: string;
  edgeType:
    | "supports"
    | "contradicts"
    | "caused_by"
    | "precedes"
    | "follows"
    | "fixes"
    | "regresses"
    | "supersedes"
    | "duplicates"
    | "mitigates"
    | "depends_on"
    | "similar_to"
    | "explains"
    | "discovered_during";
  targetType: "fact" | "memory" | "episode" | "entity" | "event";
  targetId: string;
  scopePath?: string | null;
}

function normalizeId(id: string): string {
  return id.trim().toLowerCase();
}

/**
 * Canonical directed edge fingerprint, versioned so future vocabulary or
 * undirected-edge rules can change without corrupting existing dedupe keys.
 */
export function memoryEdgeFingerprint(input: MemoryEdgeFingerprintInput): string {
  const raw = [
    "memory-edge-v1",
    `tenant=${input.tenant.trim()}`,
    `source=${input.sourceType}:${normalizeId(input.sourceId)}`,
    `edge=${input.edgeType}`,
    `target=${input.targetType}:${normalizeId(input.targetId)}`,
    `scope=${input.scopePath?.trim() ?? ""}`,
  ].join("|");
  return createHash("sha256").update(raw, "utf-8").digest("hex");
}
