import type { Db } from '../db/open.ts';
import { checkTranslation } from '../quality/check.ts';

export interface MultiSearchQuery {
  projectIds?: number[] | undefined;
  sourceText?: string | undefined;
  findText: string;
  replaceText?: string | undefined;
  caseSensitive?: boolean | undefined;
  limit?: number | undefined;
  offset?: number | undefined;
}

export interface MultiSearchMatch {
  id: number;
  projectId: number;
  projectName: string;
  projectSlug: string;
  msgid: string;
  msgidPlural: string | null;
  msgstr: string;
  msgstrPlural: string | null;
  proposedMsgstr: string;
  proposedMsgstrPlural: string | null;
  state: string;
}

export interface MultiSearchResult {
  total: number;
  projectCount: number;
  matches: MultiSearchMatch[];
}

export interface MultiReplaceExecuteRequest {
  unitIds?: number[] | undefined;
  projectIds?: number[] | undefined;
  sourceText?: string | undefined;
  findText: string;
  replaceText: string;
  caseSensitive?: boolean | undefined;
}

export interface MultiReplaceExecuteResult {
  matched: number;
  changed: number;
  blocked: number;
  projectCount: number;
}

/**
 * Escapes regex special characters and folds Turkish dotted/dotless I
 * so case-insensitive matches align correctly with Turkish orthography.
 */
export function turkishRegex(pattern: string): RegExp {
  const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const trFolded = escaped.replace(/[iİıI]/g, '[iİıI]');
  return new RegExp(trFolded, 'gui');
}

export function createReplacer(
  find: string,
  replace: string,
  caseSensitive: boolean,
): (text: string) => string {
  if (caseSensitive) {
    return (text: string) => text.replaceAll(find, replace);
  }
  const regex = turkishRegex(find);
  return (text: string) => text.replace(regex, replace);
}

/**
 * Searches translation units across projects with optional sourceText (msgid) condition.
 */
export function searchMultiProjectUnits(
  db: Db,
  query: MultiSearchQuery,
): MultiSearchResult {
  if (!query.findText || query.findText.trim() === '') {
    return { total: 0, projectCount: 0, matches: [] };
  }

  const findText = query.findText;
  const replaceText = query.replaceText ?? '';
  const caseSensitive = query.caseSensitive === true;
  const replacer = createReplacer(findText, replaceText, caseSensitive);

  const whereClauses: string[] = ["u.msgstr IS NOT NULL AND u.msgstr <> ''"];
  const params: unknown[] = [];

  if (query.projectIds && query.projectIds.length > 0) {
    const placeholders = query.projectIds.map(() => '?').join(',');
    whereClauses.push(`u.project_id IN (${placeholders})`);
    params.push(...query.projectIds);
  }

  if (query.sourceText && query.sourceText.trim()) {
    const src = query.sourceText.trim();
    if (caseSensitive) {
      whereClauses.push(
        `(u.msgid LIKE ? OR (u.msgid_plural IS NOT NULL AND u.msgid_plural LIKE ?))`,
      );
      params.push(`%${src}%`, `%${src}%`);
    } else {
      whereClauses.push(
        `(fold(u.msgid) LIKE '%' || fold(?) || '%' OR (u.msgid_plural IS NOT NULL AND fold(u.msgid_plural) LIKE '%' || fold(?) || '%'))`,
      );
      params.push(src, src);
    }
  }

  if (caseSensitive) {
    whereClauses.push(
      `(u.msgstr LIKE ? OR (u.msgstr_plural IS NOT NULL AND u.msgstr_plural LIKE ?))`,
    );
    params.push(`%${findText}%`, `%${findText}%`);
  } else {
    whereClauses.push(
      `(fold(u.msgstr) LIKE '%' || fold(?) || '%' OR (u.msgstr_plural IS NOT NULL AND fold(u.msgstr_plural) LIKE '%' || fold(?) || '%'))`,
    );
    params.push(findText, findText);
  }

  const whereSql = whereClauses.join(' AND ');

  const sql = `
    SELECT u.id, u.project_id AS projectId, p.name AS projectName,
           p.slug AS projectSlug, p.project_path AS projectPath,
           u.msgid, u.msgid_plural AS msgidPlural,
           u.msgstr, u.msgstr_plural AS msgstrPlural, u.state
      FROM translation_units u
      JOIN projects p ON p.id = u.project_id
     WHERE ${whereSql}
     ORDER BY p.name ASC, u.id ASC
  `;

  const rows = db.prepare(sql).all(...params) as Array<{
    id: number;
    projectId: number;
    projectName: string | null;
    projectSlug: string | null;
    projectPath: string;
    msgid: string;
    msgidPlural: string | null;
    msgstr: string;
    msgstrPlural: string | null;
    state: string;
  }>;

  // Filter in memory to guarantee exact string / regex replacements
  const verifiedMatches: MultiSearchMatch[] = [];
  const projectSet = new Set<number>();

  for (const row of rows) {
    const proposed = replacer(row.msgstr);
    const proposedPlural = row.msgstrPlural ? replacer(row.msgstrPlural) : null;

    if (proposed === row.msgstr && proposedPlural === row.msgstrPlural) {
      continue;
    }

    projectSet.add(row.projectId);
    verifiedMatches.push({
      id: row.id,
      projectId: row.projectId,
      projectName: row.projectName || row.projectSlug || row.projectPath,
      projectSlug: row.projectSlug || '',
      msgid: row.msgid,
      msgidPlural: row.msgidPlural,
      msgstr: row.msgstr,
      msgstrPlural: row.msgstrPlural,
      proposedMsgstr: proposed,
      proposedMsgstrPlural: proposedPlural,
      state: row.state,
    });
  }

  const limit = query.limit ?? 100;
  const offset = query.offset ?? 0;
  const paginated = verifiedMatches.slice(offset, offset + limit);

  return {
    total: verifiedMatches.length,
    projectCount: projectSet.size,
    matches: paginated,
  };
}

/**
 * Executes find and replace across multiple projects, optionally restricted to specific unitIds.
 */
export function executeMultiProjectReplace(
  db: Db,
  request: MultiReplaceExecuteRequest,
): MultiReplaceExecuteResult {
  if (!request.findText || request.findText === '') {
    throw new Error('Aranacak metin boş olamaz.');
  }

  const caseSensitive = request.caseSensitive === true;
  const replacer = createReplacer(request.findText, request.replaceText, caseSensitive);

  let targetUnits: Array<{
    id: number;
    projectId: number;
    msgid: string;
    msgidPlural: string | null;
    msgstr: string;
    msgstrPlural: string | null;
  }> = [];

  if (request.unitIds && request.unitIds.length > 0) {
    const placeholders = request.unitIds.map(() => '?').join(',');
    targetUnits = db
      .prepare(
        `SELECT u.id, u.project_id AS projectId, u.msgid, u.msgid_plural AS msgidPlural,
                u.msgstr, u.msgstr_plural AS msgstrPlural
           FROM translation_units u
          WHERE u.id IN (${placeholders})
            AND u.msgstr IS NOT NULL AND u.msgstr <> ''`,
      )
      .all(...request.unitIds) as typeof targetUnits;
  } else {
    // Replace all matching query criteria
    const searchRes = searchMultiProjectUnits(db, {
      projectIds: request.projectIds,
      sourceText: request.sourceText,
      findText: request.findText,
      replaceText: request.replaceText,
      caseSensitive: request.caseSensitive,
      limit: 100000,
      offset: 0,
    });

    targetUnits = searchRes.matches.map((m) => ({
      id: m.id,
      projectId: m.projectId,
      msgid: m.msgid,
      msgidPlural: m.msgidPlural,
      msgstr: m.msgstr,
      msgstrPlural: m.msgstrPlural,
    }));
  }

  const write = db.prepare(
    `UPDATE translation_units
        SET msgstr = ?, msgstr_plural = ?, state = 'review', blocked = ?,
            provenance = 'human', updated_at = datetime('now')
      WHERE id = ?`,
  );
  const exceptions = db.prepare(`SELECT rule FROM qa_exceptions WHERE unit_id = ?`);

  return db.transaction((): MultiReplaceExecuteResult => {
    let matched = 0;
    let changed = 0;
    let blocked = 0;
    const projectSet = new Set<number>();

    for (const row of targetUnits) {
      const msgstr = replacer(row.msgstr);
      const msgstrPlural = row.msgstrPlural ? replacer(row.msgstrPlural) : null;
      if (msgstr === row.msgstr && msgstrPlural === row.msgstrPlural) continue;

      matched += 1;
      projectSet.add(row.projectId);

      const overridden = new Set(
        (exceptions.all(row.id) as { rule: string }[]).map((e) => e.rule),
      );
      const blocking = checkTranslation({
        ordinal: 0,
        msgid: row.msgid,
        ...(row.msgidPlural ? { msgidPlural: row.msgidPlural } : {}),
        msgstr,
        ...(msgstrPlural ? { msgstrPlural } : {}),
      }).filter((failure) => !overridden.has(failure.rule));

      write.run(msgstr, msgstrPlural, blocking.length === 0 ? 0 : 1, row.id);
      changed += 1;
      if (blocking.length > 0) blocked += 1;
    }

    return {
      matched,
      changed,
      blocked,
      projectCount: projectSet.size,
    };
  })();
}
