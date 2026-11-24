import Database from 'better-sqlite3';
import { resolveDbPath } from '../src/db/path.ts';
import { listAiAgents } from '../src/db/aiSettings.ts';
import { fetchQueuePage, setTranslationStatus, type QueueRow } from '../src/wporg/reviewer.ts';
import { judgeSubmissions } from '../src/server/judge.ts';
import type { Engine } from '../translate/types.ts';

interface RescueOptions {
  apply: boolean;
  projectSlug?: string;
  fromSlug?: string;
  maxPagesPerQueue: number;
  pauseMs: number;
}

interface LoggedRejection {
  source: string;
  translation: string;
  slug: string;
  reason: string;
}

function parseCliArgs(): RescueOptions {
  const args = process.argv.slice(2);
  let apply = false;
  let projectSlug: string | undefined;
  let fromSlug: string | undefined;
  let maxPagesPerQueue = 50;
  let pauseMs = 250;

  for (const arg of args) {
    if (arg === '--apply') apply = true;
    else if (arg === '--dry-run') apply = false;
    else if (arg.startsWith('--project=')) projectSlug = arg.slice('--project='.length).trim();
    else if (arg.startsWith('--from=')) fromSlug = arg.slice('--from='.length).trim();
    else if (arg.startsWith('--max-pages=')) maxPagesPerQueue = parseInt(arg.slice('--max-pages='.length), 10) || 50;
    else if (arg.startsWith('--pause=')) pauseMs = parseInt(arg.slice('--pause='.length), 10) || 250;
  }

  return { apply, projectSlug, fromSlug, maxPagesPerQueue, pauseMs };
}

async function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function getProjectPaths(slug: string, cookie: string): Promise<string[]> {
  // Check if theme first
  const themeUrl = `https://translate.wordpress.org/projects/wp-themes/${slug}/`;
  try {
    const res = await fetch(themeUrl, { headers: { Cookie: cookie, 'User-Agent': 'Mozilla/5.0' } });
    if (res.ok) {
      return [`wp-themes/${slug}`];
    }
  } catch {}

  // Check if plugin
  const pluginUrl = `https://translate.wordpress.org/projects/wp-plugins/${slug}/`;
  try {
    const res = await fetch(pluginUrl, { headers: { Cookie: cookie, 'User-Agent': 'Mozilla/5.0' } });
    if (res.ok) {
      const html = await res.text();
      const regex = /href="\/projects\/wp-plugins\/[^\/]+\/([^\/]+)\/tr\/default\/"/gi;
      const sets = new Set<string>();
      let m: RegExpExecArray | null;
      while ((m = regex.exec(html)) !== null) {
        if (m[1]) sets.add(`wp-plugins/${slug}/${m[1]}`);
      }
      if (sets.size > 0) return Array.from(sets);
      return [
        `wp-plugins/${slug}/dev`,
        `wp-plugins/${slug}/stable`,
        `wp-plugins/${slug}/dev-readme`,
        `wp-plugins/${slug}/stable-readme`,
      ];
    }
  } catch {}

  return [`wp-plugins/${slug}/dev`, `wp-plugins/${slug}/stable`];
}

async function main() {
  const options = parseCliArgs();
  console.log(`=== WP-Translator Log Tabanlı Kurtarma (Rescue) Modülü ===`);
  console.log(`Mod: ${options.apply ? 'UYGULAMA (APPLY - translate.wordpress.org üzerinde onaylanacak)' : 'SİMÜLASYON (DRY-RUN - sadece analiz edilecek)'}`);
  if (options.projectSlug) console.log(`Hedef Proje: ${options.projectSlug}`);
  if (options.fromSlug) console.log(`Başlangıç Projesi (--from): ${options.fromSlug}`);

  const db = new Database(resolveDbPath());
  const cookieRow = db.prepare("SELECT value FROM app_settings WHERE key = 'wporg_cookie'").get() as { value: string } | undefined;
  const cookie = cookieRow?.value;

  if (!cookie) {
    console.error('Hata: wporg_cookie bulunamadı! Lütfen önce panelden giriş yapın.');
    process.exit(1);
  }

  // Determine AI Engine & Model
  const agents = listAiAgents(db);
  const activeAgent = agents.find((a) => a.enabled) ?? agents[0];
  const engine = (activeAgent?.id || 'agy') as Engine;
  const model = activeAgent?.model.trim() || activeAgent?.defaultModel.trim() || undefined;

  console.log(`Kullanılan AI Motoru: ${activeAgent?.name || engine} (${model || 'varsayılan'})`);

  // Parse all applied rejections from system_logs
  const logRows = db.prepare(`SELECT message FROM system_logs WHERE message LIKE ?`).all('%✗ REDDEDİLDİ:%') as { message: string }[];
  const rejectionsBySlug = new Map<string, LoggedRejection[]>();

  for (const r of logRows) {
    const m = r.message.match(/^✗ REDDEDİLDİ:\s*"([\s\S]*)"\s*→\s*"([\s\S]*)"\s*\(([a-z0-9_-]+)\)\s*\[([\s\S]*)\]$/);
    if (m) {
      const [, source, translation, slug, reason] = m;
      if (!rejectionsBySlug.has(slug!)) {
        rejectionsBySlug.set(slug!, []);
      }
      rejectionsBySlug.get(slug!)!.push({ source: source!, translation: translation!, slug: slug!, reason: reason! });
    }
  }

  let targetSlugs = Array.from(rejectionsBySlug.keys()).map((slug) => ({
    slug,
    count: rejectionsBySlug.get(slug)!.length,
  }));

  // Sort ascending by count so smaller queues complete first
  targetSlugs.sort((a, b) => a.count - b.count);

  if (options.projectSlug) {
    targetSlugs = targetSlugs.filter((s) => s.slug === options.projectSlug);
    if (targetSlugs.length === 0) {
      targetSlugs = [{ slug: options.projectSlug, count: 0 }];
    }
  }

  if (options.fromSlug) {
    const fromIdx = targetSlugs.findIndex((s) => s.slug === options.fromSlug);
    if (fromIdx !== -1) {
      targetSlugs = targetSlugs.slice(fromIdx);
    }
  }

  console.log(`Loglardan tespit edilen toplam proje sayısı: ${targetSlugs.length}`);
  const totalLoggedRejections = targetSlugs.reduce((acc, s) => acc + s.count, 0);
  console.log(`Hedef projelerdeki loglanmış ret sayısı: ~${totalLoggedRejections}`);

  let totalMatchedRows = 0;
  let totalRescued = 0;
  let totalConfirmedRejected = 0;
  let totalErrors = 0;

  for (let idx = 0; idx < targetSlugs.length; idx++) {
    const { slug, count } = targetSlugs[idx]!;
    const loggedList = rejectionsBySlug.get(slug) || [];
    console.log(`\n--------------------------------------------------------------------------------`);
    console.log(`[${idx + 1}/${targetSlugs.length}] Proje: ${slug} (Loglardaki ret sayısı: ${count})`);
    console.log(`--------------------------------------------------------------------------------`);

    // Create lookup set for quick matching
    // Note: because source in log might have been truncated due to span bug,
    // we match by:
    // 1) Exact translation match (translation was never truncated)
    // 2) Or exact source match
    // 3) Or source starts with truncated source if length >= 4
    const matchLogRow = (row: QueueRow): LoggedRejection | undefined => {
      // Priority 1: Exact translation match
      const exactTrans = loggedList.find((l) => l.translation.trim() === row.translation.trim());
      if (exactTrans) return exactTrans;

      // Priority 2: Exact source match
      const exactSrc = loggedList.find((l) => l.source.trim() === row.source.trim());
      if (exactSrc) return exactSrc;

      // Priority 3: Truncated source match (logged source is prefix of row.source)
      const prefixSrc = loggedList.find(
        (l) => l.source.length >= 4 && row.source.startsWith(l.source) && l.translation.trim() === row.translation.trim(),
      );
      if (prefixSrc) return prefixSrc;

      return undefined;
    };

    const paths = await getProjectPaths(slug, cookie);
    await sleep(options.pauseMs);

    let foundForProject = 0;

    for (const projectPath of paths) {
      const queueUrl = `https://translate.wordpress.org/projects/${projectPath}/tr/default/?filters[status]=rejected`;
      let currentUrl: string | undefined = queueUrl;
      let pageNum = 1;

      while (currentUrl && pageNum <= options.maxPagesPerQueue) {
        let page;
        try {
          page = await fetchQueuePage(currentUrl, cookie);
        } catch (err: any) {
          console.error(`  - Sayfa çekilemedi (${currentUrl}): ${err.message}`);
          totalErrors++;
          break;
        }

        if (page.rows.length === 0) {
          break;
        }

        // Filter rows that were rejected in our logs
        const matchingRows: { row: QueueRow; log: LoggedRejection }[] = [];
        for (const row of page.rows) {
          const matched = matchLogRow(row);
          if (matched) {
            matchingRows.push({ row, log: matched });
          }
        }

        if (matchingRows.length > 0) {
          console.log(`  > ${projectPath} (Sayfa ${pageNum}): ${page.rows.length} satırdan ${matchingRows.length} tanesi loglarımızla eşleşti.`);
          totalMatchedRows += matchingRows.length;
          foundForProject += matchingRows.length;

          // Judge matching submissions
          const judgeItems = matchingRows.map(({ row }) => ({
            id: row.translationId,
            source: row.source,
            ...(row.sourcePlural ? { sourcePlural: row.sourcePlural } : {}),
            translation: row.translation,
            ...(row.translationPlural ? { translationPlural: row.translationPlural } : {}),
            ...(row.context ? { context: row.context } : {}),
          }));

          let judgeResult;
          try {
            judgeResult = await judgeSubmissions(
              db,
              { projectPath, items: judgeItems },
              { engine, model },
            );
          } catch (err: any) {
            console.error(`    Değerlendirme hatası: ${err.message}`);
            totalErrors++;
            break;
          }

          const judgementMap = new Map(judgeResult.judgements.map((j) => [j.id, j]));

          for (const { row, log } of matchingRows) {
            const judgement = judgementMap.get(row.translationId);
            const verdict = judgement?.verdict ?? 'unknown';
            const reason = judgement?.reason ?? '';

            if (verdict === 'exact' || verdict === 'agreed') {
              totalRescued++;
              console.log(`    ✓ [KURTARILACAK (${verdict.toUpperCase()})] #${row.translationId}: "${row.source}" → "${row.translation}"`);
              console.log(`      Eski ret nedeni : ${log.reason}`);
              console.log(`      Yeni gerekçe    : ${reason}`);

              if (options.apply) {
                if (!row.approveNonce) {
                  console.error(`      ✗ Onaylanamadı: Satır #${row.translationId} için approveNonce bulunamadı.`);
                  totalErrors++;
                  continue;
                }

                try {
                  await setTranslationStatus(page.setStatusUrl, row.translationId, 'current', row.approveNonce, cookie);
                  console.log(`      ✓ Başarıyla onaylandı (current durumuna alındı)!`);

                  db.prepare(`
                    INSERT INTO system_logs (category, level, message, details, created_at)
                    VALUES (?, ?, ?, ?, datetime('now', 'localtime'))
                  `).run(
                    'queue_worker',
                    'info',
                    `✓ KURTARILDI (ONAYLANDI): "${row.source}" → "${row.translation}" (${slug}) [${reason}]`,
                    JSON.stringify({
                      action: 'rescued_approve',
                      translationId: row.translationId,
                      originalId: row.originalId,
                      rowId: row.rowId,
                      projectSlug: slug,
                      projectPath,
                      source: row.source,
                      translation: row.translation,
                      verdict,
                      reason,
                      previousReason: log.reason,
                    }),
                  );
                  await sleep(options.pauseMs);
                } catch (err: any) {
                  console.error(`      ✗ Onaylama isteği başarısız: ${err.message}`);
                  totalErrors++;
                }
              }
            } else {
              totalConfirmedRejected++;
              console.log(`    ✗ [HAKLI RET KORUNDU (${verdict.toUpperCase()})] #${row.translationId}: "${row.source.slice(0, 40)}" → "${row.translation.slice(0, 40)}"`);
              console.log(`      Gerekçe: ${reason}`);
            }
          }
        }

        // If we found all logged items for this project, stop searching further pages
        if (foundForProject >= count && count > 0) {
          break;
        }

        currentUrl = page.nextPageUrl;
        pageNum++;
        await sleep(options.pauseMs);
      }

      if (foundForProject >= count && count > 0) {
        break;
      }
    }
  }

  console.log('\n=============================================');
  console.log('             KURTARMA RAPORU                 ');
  console.log('=============================================');
  console.log(`Loglarla Eşleşen İncelenen Satır  : ${totalMatchedRows}`);
  console.log(`Kurtarılan ve Onaylanan (False +) : ${totalRescued}`);
  console.log(`Haklı Ret Olarak Kalan (True -)   : ${totalConfirmedRejected}`);
  console.log(`Karşılaşılan Hatalar              : ${totalErrors}`);
  console.log('=============================================\n');
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
