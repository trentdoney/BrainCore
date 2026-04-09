/**
 * grafana-parser.ts — Query Grafana alert annotations and correlate with incidents.
 *
 * Uses a service account API key to query Grafana's annotation API.
 * Extracts alert events as facts and attempts to correlate them with
 * existing incidents in the preserve schema by:
 *   1. Service name matching (alert tags -> entity services)
 *   2. Temporal proximity (alert within 2h window of incident start_at)
 *   3. Device matching (alert dashboard name -> device entity)
 *
 * Deduplicates by annotation ID to avoid re-processing.
 */

import { readFile, writeFile } from "fs/promises";
import { existsSync } from "fs";
import type { DeterministicResult, Entity, Fact, Segment, Episode } from "./deterministic";
import { config } from "../config";

const DATA_DIR = "./data";
const STATE_FILE = `${DATA_DIR}/grafana-state.json`;

// ── Configuration ──────────────────────────────────────────────────────────────

export interface GrafanaConfig {
  baseUrl: string;
  apiKey: string;
}

const DEFAULT_CONFIG: GrafanaConfig = {
  baseUrl: config.grafana?.baseUrl || process.env.GRAFANA_URL || "http://localhost:3010",
  apiKey: config.grafana?.apiKey || process.env.GRAFANA_API_KEY || "",
};

// ── State Management ───────────────────────────────────────────────────────────

interface GrafanaState {
  lastPollEpochMs: number;
  seenAnnotationIds: number[];
  updatedAt: string;
}

async function readState(): Promise<GrafanaState> {
  if (!existsSync(STATE_FILE)) {
    return {
      lastPollEpochMs: Date.now() - 7 * 24 * 60 * 60 * 1000, // default: 7 days ago
      seenAnnotationIds: [],
      updatedAt: new Date().toISOString(),
    };
  }
  try {
    const raw = await readFile(STATE_FILE, "utf-8");
    return JSON.parse(raw);
  } catch {
    return {
      lastPollEpochMs: Date.now() - 7 * 24 * 60 * 60 * 1000,
      seenAnnotationIds: [],
      updatedAt: new Date().toISOString(),
    };
  }
}

async function writeState(state: GrafanaState): Promise<void> {
  state.updatedAt = new Date().toISOString();
  // Keep only last 1000 annotation IDs to bound state file size
  if (state.seenAnnotationIds.length > 1000) {
    state.seenAnnotationIds = state.seenAnnotationIds.slice(-1000);
  }
  await writeFile(STATE_FILE, JSON.stringify(state, null, 2) + "\n");
}

// ── Grafana API ────────────────────────────────────────────────────────────────

interface GrafanaAnnotation {
  id: number;
  alertId: number;
  alertName: string;
  dashboardId: number;
  dashboardUID: string;
  panelId: number;
  time: number;       // epoch ms
  timeEnd: number;    // epoch ms
  tags: string[];
  text: string;
  newState: string;   // "alerting", "ok", "pending", "no_data"
  prevState: string;
  /**
   * Structured labels parsed from annotation.text for Grafana 11.2 Unified
   * Alerting. Populated by normalizeAnnotation() — always present, may be
   * empty. Keys are lowercase label names (alertname, service, severity, ...).
   */
  labels: Record<string, string>;
}

interface GrafanaDashboard {
  uid: string;
  title: string;
  tags: string[];
}

/**
 * Parse Grafana 11.2 Unified Alerting annotation.text into a labels object.
 *
 * Grafana 11.2 stopped populating annotation.tags[] and annotation.alertName
 * on alert-state-change annotations. Labels are instead embedded in the text
 * field as:
 *
 *   "BrainCore Test - Fact Check {alertname=BrainCore Test - Fact Check, \
 *    service=braincore, severity=info} - A=26947.000000, C=1.000000"
 *
 * Returns the rule title (text before the `{`) and a labels map. Either may
 * be empty if the text doesn't match the expected shape.
 */
export function parseUnifiedAlertingText(text: string): {
  ruleTitle: string;
  labels: Record<string, string>;
} {
  if (!text) return { ruleTitle: "", labels: {} };

  const labels: Record<string, string> = {};
  const braceMatch = text.match(/\{([^}]+)\}/);
  if (braceMatch) {
    const inside = braceMatch[1];
    // Split on commas but keep it forgiving about whitespace.
    for (const pair of inside.split(/,\s*/)) {
      const eq = pair.indexOf("=");
      if (eq <= 0) continue;
      const key = pair.slice(0, eq).trim().toLowerCase();
      const value = pair.slice(eq + 1).trim();
      if (key) labels[key] = value;
    }
  }

  // Rule title is everything before the first `{`, trimmed.
  let ruleTitle = "";
  const braceIdx = text.indexOf("{");
  if (braceIdx > 0) {
    ruleTitle = text.slice(0, braceIdx).trim();
  } else {
    ruleTitle = text.trim();
  }

  return { ruleTitle, labels };
}

/**
 * Normalize a Grafana annotation in place so downstream code can keep using
 * annotation.tags[] and annotation.alertName regardless of whether Grafana
 * populated them natively (legacy) or embedded them in annotation.text
 * (Unified Alerting 11.2+).
 */
function normalizeAnnotation(ann: GrafanaAnnotation): GrafanaAnnotation {
  // Ensure labels field is always present.
  if (!ann.labels) ann.labels = {};

  // Only re-parse if we need to fill in missing data.
  const needsParse =
    !ann.alertName ||
    ann.alertName.trim() === "" ||
    !ann.tags ||
    ann.tags.length === 0;

  if (!needsParse) return ann;

  const { ruleTitle, labels } = parseUnifiedAlertingText(ann.text || "");
  ann.labels = labels;

  // Populate alertName from labels.alertname, falling back to rule title.
  if (!ann.alertName || ann.alertName.trim() === "") {
    ann.alertName = labels.alertname || ruleTitle || "";
  }

  // Synthesize tags[] as "key=value" strings so existing tag logic keeps
  // working (service/severity tag scans, entity building, correlation).
  if (!ann.tags || ann.tags.length === 0) {
    ann.tags = Object.entries(labels).map(([k, v]) => `${k}=${v}`);
  }

  return ann;
}

async function fetchAnnotations(
  cfg: GrafanaConfig,
  fromEpochMs: number,
  toEpochMs: number,
): Promise<GrafanaAnnotation[]> {
  const url = `${cfg.baseUrl}/api/annotations?type=alert&from=${fromEpochMs}&to=${toEpochMs}&limit=500`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${cfg.apiKey}` },
  });
  if (!res.ok) {
    throw new Error(`Grafana annotations API error: ${res.status} ${await res.text()}`);
  }
  const raw = (await res.json()) as GrafanaAnnotation[];
  return raw.map(normalizeAnnotation);
}

async function fetchDashboard(
  cfg: GrafanaConfig,
  uid: string,
): Promise<GrafanaDashboard | null> {
  try {
    const url = `${cfg.baseUrl}/api/dashboards/uid/${uid}`;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${cfg.apiKey}` },
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data.dashboard as GrafanaDashboard;
  } catch {
    return null;
  }
}

// ── Incident Correlation ───────────────────────────────────────────────────────

interface IncidentRef {
  entity_id: string;
  canonical_name: string;
  start_at: Date | null;
  end_at: Date | null;
}

/**
 * Match an alert to known incidents by:
 * 1. Service name overlap (alert tags vs incident-related services)
 * 2. Temporal proximity (within 2h window)
 * 3. Device name in dashboard title
 */
function correlateAlert(
  annotation: GrafanaAnnotation,
  dashboardTitle: string,
  incidents: IncidentRef[],
): { incident: IncidentRef; matchType: string } | null {
  const alertTime = new Date(annotation.time);
  const twoHoursMs = 2 * 60 * 60 * 1000;

  // Collect candidate service names from labels (preferred, Unified Alerting)
  // and raw tag strings (legacy shape). Labels get split on `=` so only the
  // values (e.g. "braincore") are compared, not keys like "service".
  const candidateTokens = new Set<string>();
  for (const [key, val] of Object.entries(annotation.labels || {})) {
    if (!val) continue;
    candidateTokens.add(val.toLowerCase());
    if (key === "service") candidateTokens.add(val.toLowerCase());
  }
  for (const rawTag of annotation.tags || []) {
    const t = rawTag.toLowerCase();
    if (t.includes("=")) {
      const [, v] = t.split("=", 2);
      if (v) candidateTokens.add(v);
    } else {
      candidateTokens.add(t);
    }
  }

  const dashLower = dashboardTitle.toLowerCase();

  for (const incident of incidents) {
    if (!incident.start_at) continue;

    const timeDiff = Math.abs(alertTime.getTime() - incident.start_at.getTime());
    if (timeDiff > twoHoursMs) continue;

    // Check service tag match
    const incidentName = incident.canonical_name.toLowerCase();
    for (const tok of candidateTokens) {
      if (!tok) continue;
      if (incidentName.includes(tok) || tok.includes(incidentName.split("-")[0])) {
        return { incident, matchType: "service_tag" };
      }
    }

    // Check device in dashboard title
    const devices = (process.env.BRAINCORE_KNOWN_DEVICES || "server-a,server-b,workstation").split(",").map(d => d.trim());
    for (const device of devices) {
      if (dashLower.includes(device) && incidentName.includes(device)) {
        return { incident, matchType: "device_dashboard" };
      }
    }

    // Temporal-only match (weaker confidence)
    if (timeDiff < 30 * 60 * 1000) { // within 30 min = strong temporal
      return { incident, matchType: "temporal_proximity" };
    }
  }

  return null;
}

// ── Main Parser ────────────────────────────────────────────────────────────────

export interface GrafanaPollResult {
  annotationsFound: number;
  newAnnotations: number;
  alertFacts: number;
  correlations: number;
}

/**
 * Poll Grafana for alert annotations and build a DeterministicResult.
 *
 * @param incidents - known incidents for correlation (pass empty array if unavailable)
 * @param dryRun - if true, don't persist state
 * @param cfg - Grafana config override
 */
export async function parseGrafanaAlerts(
  incidents: IncidentRef[] = [],
  dryRun = false,
  cfg: GrafanaConfig = DEFAULT_CONFIG,
): Promise<{ result: DeterministicResult; stats: GrafanaPollResult }> {
  const state = await readState();
  const fromMs = state.lastPollEpochMs;
  const toMs = Date.now();
  const seenSet = new Set(state.seenAnnotationIds);

  console.log(`  Polling annotations from ${new Date(fromMs).toISOString()} to ${new Date(toMs).toISOString()}`);

  let annotations: GrafanaAnnotation[];
  try {
    annotations = await fetchAnnotations(cfg, fromMs, toMs);
  } catch (e: any) {
    console.error(`  Grafana API error: ${e.message}`);
    annotations = [];
  }

  console.log(`  Annotations found: ${annotations.length}`);

  // Filter to unseen
  const newAnnotations = annotations.filter((a) => !seenSet.has(a.id));
  console.log(`  New annotations: ${newAnnotations.length}`);

  // Build result
  const entities: Entity[] = [];
  const facts: Fact[] = [];
  const segments: Segment[] = [];
  const seenEntities = new Set<string>();
  let segOrdinal = 0;
  let correlationCount = 0;

  // Cache dashboard lookups
  const dashboardCache = new Map<string, string>();

  for (const ann of newAnnotations) {
    segOrdinal++;
    const segKey = `seg_${segOrdinal}`;
    const alertTime = new Date(ann.time).toISOString();
    const alertEndTime = ann.timeEnd > 0 ? new Date(ann.timeEnd).toISOString() : undefined;
    const durationMs = ann.timeEnd > ann.time ? ann.timeEnd - ann.time : 0;
    const durationStr = durationMs > 0
      ? `${Math.round(durationMs / 60000)}m`
      : "ongoing";

    // Resolve dashboard name
    let dashTitle = `dashboard-${ann.dashboardUID}`;
    if (ann.dashboardUID) {
      if (dashboardCache.has(ann.dashboardUID)) {
        dashTitle = dashboardCache.get(ann.dashboardUID)!;
      } else {
        const dash = await fetchDashboard(cfg, ann.dashboardUID);
        if (dash) {
          dashTitle = dash.title;
          dashboardCache.set(ann.dashboardUID, dash.title);
        }
      }
    }

    // Alert entity
    const alertEntityName = `grafana-alert-${ann.id}`;
    entities.push({
      name: alertEntityName,
      type: "incident",
    });

    // Resolve the alert's logical service and severity labels.
    // Prefer Unified Alerting labels, fall back to parsing legacy k=v tags,
    // then derive severity from alert state as a last resort.
    const labelService =
      (ann.labels?.service || "").toLowerCase() || undefined;
    const labelSeverity =
      (ann.labels?.severity || "").toLowerCase() || undefined;

    const stateDerivedSeverity =
      ann.newState?.toLowerCase() === "alerting" ? "warning" : "info";
    const severity = labelSeverity || stateDerivedSeverity;

    // Service entity from labels (preferred) or fallback to filtered tags.
    const serviceCandidates = new Set<string>();
    if (labelService) serviceCandidates.add(labelService);
    for (const rawTag of ann.tags) {
      const t = rawTag.toLowerCase();
      if (t.includes("=")) {
        const [k, v] = t.split("=", 2);
        // Only treat service/app/component/job labels as service entities.
        if (v && ["service", "app", "component", "job", "target"].includes(k)) {
          serviceCandidates.add(v);
        }
      } else if (t) {
        serviceCandidates.add(t);
      }
    }
    for (const svc of serviceCandidates) {
      if (!seenEntities.has(`service:${svc}`)) {
        seenEntities.add(`service:${svc}`);
        entities.push({ name: svc, type: "service" });
      }
    }

    const serviceForMeta = labelService || [...serviceCandidates][0] || "unknown";

    // Per-fact metadata that quality-gate's validateMonitoringAlert expects.
    const factMeta = {
      service: serviceForMeta,
      severity,
      labels: ann.labels,
      alert_id: ann.id,
    };

    // Segment: alert content
    const segContent = [
      `Alert: ${ann.alertName}`,
      `State: ${ann.prevState} -> ${ann.newState}`,
      `Dashboard: ${dashTitle}`,
      `Duration: ${durationStr}`,
      `Service: ${serviceForMeta}`,
      `Severity: ${severity}`,
      `Tags: ${ann.tags.join(", ") || "none"}`,
      ann.text ? `Details: ${ann.text}` : "",
    ].filter(Boolean).join("\n");

    segments.push({
      ordinal: segOrdinal,
      section_label: `Alert: ${ann.alertName} @ ${alertTime}`,
      content: segContent,
      line_start: 1,
      line_end: segContent.split("\n").length,
    });

    // Fact: the alert event itself
    facts.push({
      subject: alertEntityName,
      predicate: "alert_fired",
      object_value: {
        name: ann.alertName,
        state: ann.newState,
        prevState: ann.prevState,
        dashboard: dashTitle,
        duration: durationStr,
        service: serviceForMeta,
        severity,
        labels: ann.labels,
        tags: ann.tags,
      },
      fact_kind: "event",
      assertion_class: "deterministic",
      confidence: 1.0,
      valid_from: alertTime,
      valid_to: alertEndTime,
      segment_ids: [segKey],
      metadata: factMeta,
    });

    // Fact: severity (from labels if present, else derived from state)
    facts.push({
      subject: alertEntityName,
      predicate: "severity",
      object_value: severity,
      fact_kind: "state",
      assertion_class: "deterministic",
      confidence: 1.0,
      valid_from: alertTime,
      segment_ids: [segKey],
      metadata: factMeta,
    });

    // Tag associations: emit one tagged_service fact per service candidate.
    for (const svc of serviceCandidates) {
      facts.push({
        subject: alertEntityName,
        predicate: "tagged_service",
        object_value: svc,
        fact_kind: "state",
        assertion_class: "deterministic",
        confidence: 1.0,
        segment_ids: [segKey],
        metadata: factMeta,
      });
    }

    // Correlation with known incidents
    const correlation = correlateAlert(ann, dashTitle, incidents);
    if (correlation) {
      correlationCount++;
      const confMap: Record<string, number> = {
        service_tag: 0.85,
        device_dashboard: 0.8,
        temporal_proximity: 0.6,
      };
      facts.push({
        subject: alertEntityName,
        predicate: "correlated_with",
        object_value: correlation.incident.canonical_name,
        fact_kind: "cause",
        assertion_class: "deterministic",
        confidence: confMap[correlation.matchType] || 0.5,
        valid_from: alertTime,
        segment_ids: [segKey],
        metadata: factMeta,
      });
    }

    // Track seen
    seenSet.add(ann.id);
  }

  // Persist state
  if (!dryRun) {
    await writeState({
      lastPollEpochMs: toMs,
      seenAnnotationIds: [...seenSet],
      updatedAt: new Date().toISOString(),
    });
  }

  const episode: Episode = {
    type: "session",
    title: `Grafana alert poll: ${newAnnotations.length} new annotations`,
    start_at: newAnnotations.length > 0
      ? new Date(Math.min(...newAnnotations.map((a) => a.time))).toISOString()
      : new Date().toISOString(),
    end_at: new Date().toISOString(),
    summary: `Polled ${annotations.length} annotations, ${newAnnotations.length} new. Created ${facts.length} facts with ${correlationCount} incident correlations.`,
  };

  const result: DeterministicResult = {
    entities,
    facts,
    segments,
    episode,
    scope_path: "monitoring:grafana/alerts",
  };

  const stats: GrafanaPollResult = {
    annotationsFound: annotations.length,
    newAnnotations: newAnnotations.length,
    alertFacts: facts.length,
    correlations: correlationCount,
  };

  return { result, stats };
}
