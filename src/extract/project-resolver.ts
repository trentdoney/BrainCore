import { sql } from "../db";
import { config } from "../config";

interface ProjectMatch {
  projectEntityId: string;
  projectName: string;
}

export async function resolveProject(
  services: string[],
  tags: string[],
  originalPath: string
): Promise<ProjectMatch | null> {
  // 1. Check project_service_map for any matching service
  for (const svc of services) {
    const rows = await sql`
      SELECT e.entity_id, e.canonical_name
      FROM preserve.project_service_map psm
      JOIN preserve.entity e ON e.entity_id = psm.project_entity_id
      WHERE psm.service_name = ${svc.toLowerCase()}
        AND e.tenant = ${config.tenant}
    `;
    if (rows.length > 0) return { projectEntityId: rows[0].entity_id, projectName: rows[0].canonical_name };
  }

  // 2. Check tags for known project names
  const projectEntities = await sql`
    SELECT entity_id, canonical_name
    FROM preserve.entity
    WHERE tenant = ${config.tenant}
      AND entity_type = 'project'
  `;
  for (const tag of tags) {
    const match = projectEntities.find((p: any) => p.canonical_name.toLowerCase() === tag.toLowerCase());
    if (match) return { projectEntityId: match.entity_id, projectName: match.canonical_name };
  }

  // 3. Check vault path
  const pathMatch = originalPath.match(/10_projects\/([^/]+)/);
  if (pathMatch) {
    const dirName = pathMatch[1].toLowerCase().replace(/[_-]/g, '-');
    const match = projectEntities.find((p: any) => p.canonical_name.toLowerCase() === dirName);
    if (match) return { projectEntityId: match.entity_id, projectName: match.canonical_name };
  }

  return null;
}
