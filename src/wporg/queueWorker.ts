import type { Db } from '../db/open.ts';
import { getAppSetting } from '../db/appSettings.ts';
import { listAiAgents } from '../db/aiSettings.ts';
import { judgeSubmissions } from '../server/judge.ts';
import { scanQueueTargets } from './scanner.ts';
import { fetchQueuePage, setTranslationStatus } from './reviewer.ts';
import { logMessage } from '../db/logs.ts';
import type { Engine } from '../server/translate.ts';

export interface QueueWorkerConfig {
  family?: 'plugin' | 'theme' | 'all' | undefined;
  mode?: 'dry_run' | 'apply' | undefined;
  autoApprove?: boolean | undefined;
  autoReject?: boolean | undefined;
  engine?: Engine | undefined;
  model?: string | undefined;
  pauseMs?: number | undefined;
}

export interface QueueLog {
  time: string;
  level: 'info' | 'warn' | 'error' | 'success';
  text: string;
}

export interface QueueWorkerState {
  running: boolean;
  phase: 'idle' | 'scanning' | 'working' | 'done' | 'stopped' | 'error';
  mode: 'dry_run' | 'apply';
  targetsTotal: number;
  targetsCompleted: number;
  currentProject: string;
  currentQueue: string;
  rowsTotal: number;
  rowsProcessed: number;
  approved: number;
  rejected: number;
  skipped: number;
  logs: QueueLog[];
  error?: string | undefined;
}

const DEFAULT_PAUSE_MS = 400;
const MAX_LOGS = 500;

function nowTime(): string {
  const d = new Date();
  return d.toTimeString().split(' ')[0] ?? '';
}

class QueueWorkerManager {
  private db: Db | null = null;
  private abortController: AbortController | null = null;
  private state: QueueWorkerState = {
    running: false,
    phase: 'idle',
    mode: 'dry_run',
    targetsTotal: 0,
    targetsCompleted: 0,
    currentProject: '',
    currentQueue: '',
    rowsTotal: 0,
    rowsProcessed: 0,
    approved: 0,
    rejected: 0,
    skipped: 0,
    logs: [],
  };

  getState(): QueueWorkerState {
    return { ...this.state, logs: [...this.state.logs] };
  }

  private log(level: QueueLog['level'], text: string, details?: unknown): void {
    const entry: QueueLog = { time: nowTime(), level, text };
    this.state.logs.push(entry);
    if (this.state.logs.length > MAX_LOGS) {
      this.state.logs.splice(0, this.state.logs.length - MAX_LOGS);
    }

    if (this.db) {
      const dbLevel = level === 'success' || level === 'info' ? 'info' : level;
      logMessage(this.db, {
        level: dbLevel,
        category: 'queue_worker',
        message: text,
        details,
      });
    }
  }

  stop(): QueueWorkerState {
    if (this.abortController && !this.abortController.signal.aborted) {
      this.abortController.abort();
      this.log('warn', 'İşlem durduruluyor.');
    }
    this.state.running = false;
    this.state.phase = 'stopped';
    return this.getState();
  }

  start(db: Db, config: QueueWorkerConfig = {}): QueueWorkerState {
    if (this.state.running) {
      throw new Error('Kuyruk tarayıcısı zaten çalışıyor.');
    }

    const cookie = getAppSetting(db, 'wporg_cookie')?.trim();
    if (!cookie) {
      throw new Error(
        'WordPress.org oturum çerezi bulunamadı. Lütfen önce Ayarlar sekmesinden çerezinizi kaydedin.',
      );
    }

    this.db = db;
    this.abortController = new AbortController();
    const signal = this.abortController.signal;

    const mode = config.mode ?? 'dry_run';
    this.state = {
      running: true,
      phase: 'scanning',
      mode,
      targetsTotal: 0,
      targetsCompleted: 0,
      currentProject: '',
      currentQueue: '',
      rowsTotal: 0,
      rowsProcessed: 0,
      approved: 0,
      rejected: 0,
      skipped: 0,
      logs: [],
      error: undefined,
    };

    this.log(
      'info',
      `Kuyruk tarayıcısı başlatıldı (Mod: ${mode === 'apply' ? 'Canlı Uygulama' : 'Simülasyon / Dry-Run'}).`,
    );

    // Run async loop in background
    void this.run(db, cookie, config, signal);

    return this.getState();
  }

  private async run(
    db: Db,
    cookie: string,
    config: QueueWorkerConfig,
    signal: AbortSignal,
  ): Promise<void> {
    try {
      this.log('info', 'WordPress.org bekleme kuyrukları taranıyor...');
      const targets = await scanQueueTargets({
        cookie,
        family: config.family ?? 'all',
        signal,
      });

      if (signal.aborted) return;

      if (targets.length === 0) {
        this.log('info', 'İncelenecek bekleyen veya fuzzy girdisi olan proje bulunamadı.');
        this.state.phase = 'done';
        this.state.running = false;
        return;
      }

      this.state.targetsTotal = targets.length;
      this.state.phase = 'working';
      this.log(
        'info',
        `${targets.length} adet bekleme kuyruğu tespit edildi. İnceleme başlıyor...`,
      );

      // Determine active AI engine & model
      let engine = config.engine;
      let model = config.model;
      if (!engine) {
        const agents = listAiAgents(db);
        const activeAgent = agents.find((a) => a.enabled) ?? agents[0];
        if (activeAgent) {
          engine = activeAgent.id as Engine;
          model = activeAgent.model.trim() || activeAgent.defaultModel.trim() || undefined;
        }
      }

      const pauseMs = config.pauseMs ?? DEFAULT_PAUSE_MS;
      const autoApprove = config.autoApprove ?? true;
      const autoReject = config.autoReject ?? true;

      for (const target of targets) {
        if (signal.aborted) break;

        this.state.currentProject = `${target.name} (${target.slug}${target.subProject ? `/${target.subProject}` : ''})`;
        this.state.currentQueue = target.queueUrl;
        this.log(
          'info',
          `Proje inceleniyor: ${this.state.currentProject} [${target.status.toUpperCase()} ~${target.count}]`,
        );

        let currentUrl: string | undefined = target.queueUrl;
        const visitedUrls = new Set<string>();

        while (currentUrl && !signal.aborted && !visitedUrls.has(currentUrl)) {
          visitedUrls.add(currentUrl);
          const page = await fetchQueuePage(currentUrl, cookie, signal);
          if (page.rows.length === 0) {
            if (target.count > 0) {
              const warnMsg = `Proje (${target.slug}) için ~${target.count} bekleyen bildirilmişti ancak sayfada satır bulunamadı. GlotPress arayüz şablonu değişmiş veya kuyruk temizlenmiş olabilir.`;
              this.log('warn', warnMsg, { target, url: currentUrl });
            }
            break;
          }

          this.state.rowsTotal += page.rows.length;

          // Judge submissions locally & via AI
          const judgeItems = page.rows.map((r) => ({
            id: r.translationId,
            source: r.source,
            ...(r.sourcePlural ? { sourcePlural: r.sourcePlural } : {}),
            ...(r.context ? { context: r.context } : {}),
            translation: r.translation,
            ...(r.translationPlural ? { translationPlural: r.translationPlural } : {}),
          }));

          const judgeResult = await judgeSubmissions(
            db,
            {
              projectPath: target.projectPath,
              items: judgeItems,
            },
            {
              engine,
              model,
              agent: engine === 'opencode' ? 'wp-translator' : undefined,
              signal,
            },
          );

          const judgementMap = new Map(judgeResult.judgements.map((j) => [j.id, j]));

          for (const row of page.rows) {
            if (signal.aborted) break;

            this.state.rowsProcessed++;
            const judgement = judgementMap.get(row.translationId);
            const verdict = judgement?.verdict ?? 'unknown';

            const logDetails = {
              translationId: row.translationId,
              originalId: row.originalId,
              rowId: row.rowId,
              projectSlug: target.slug,
              projectPath: target.projectPath,
              setStatusUrl: page.setStatusUrl,
              approveNonce: row.approveNonce,
              rejectNonce: row.rejectNonce,
              source: row.source,
              sourcePlural: row.sourcePlural,
              translation: row.translation,
              translationPlural: row.translationPlural,
              context: row.context,
              verdict,
              reason: judgement?.reason,
              mode: this.state.mode,
            };

            if (verdict === 'exact' || verdict === 'agreed') {
              if (row.status === 'current') {
                this.state.approved++;
                this.log(
                  'info',
                  `― ZATEN ONAYLI: "${row.source}" → "${row.translation}" (${target.slug})`,
                  { ...logDetails, action: 'already_approved' },
                );
              } else if (this.state.mode === 'apply' && autoApprove) {
                if (!row.approveNonce) {
                  const errMsg = `Satır #${row.translationId} onaylanamadı: GlotPress onay noncesi bulunamadı. Oturum süresi dolmuş veya arayüz şablonu değişmiş olabilir.`;
                  this.log('error', errMsg, { ...logDetails, action: 'approve_failed' });
                } else {
                  try {
                    await setTranslationStatus(
                      page.setStatusUrl,
                      row.translationId,
                      'current',
                      row.approveNonce,
                      cookie,
                      signal,
                    );
                    this.state.approved++;
                    this.log(
                      'success',
                      `✓ ONAYLANDI: "${row.source}" → "${row.translation}" (${target.slug})`,
                      { ...logDetails, action: 'approved' },
                    );
                  } catch (err: unknown) {
                    this.log('error', `Onaylanamadı (${row.translationId}): ${String(err)}`, { ...logDetails, action: 'approve_error', err });
                  }
                }
              } else {
                this.state.approved++;
                this.log(
                  'info',
                  `✓ ONAY ADAYI: "${row.source}" → "${row.translation}" (${target.slug})`,
                  { ...logDetails, action: 'candidate_approve' },
                );
              }
            } else if (verdict === 'flagged') {
              const reason = judgement?.reason || 'Kalite/üslup kontrolünü geçemedi';
              if (row.status === 'rejected') {
                this.state.rejected++;
                this.log(
                  'warn',
                  `― ZATEN REDDEDİLMİŞ: "${row.source}" → "${row.translation}" (${target.slug})`,
                  { ...logDetails, action: 'already_rejected' },
                );
              } else if (this.state.mode === 'apply' && autoReject) {
                if (!row.rejectNonce) {
                  const errMsg = `Satır #${row.translationId} reddedilemedi: GlotPress ret noncesi bulunamadı. Oturum süresi dolmuş veya arayüz şablonu değişmiş olabilir.`;
                  this.log('error', errMsg, { ...logDetails, action: 'reject_failed' });
                } else {
                  try {
                    await setTranslationStatus(
                      page.setStatusUrl,
                      row.translationId,
                      'rejected',
                      row.rejectNonce,
                      cookie,
                      signal,
                    );
                    this.state.rejected++;
                    this.log(
                      'warn',
                      `✗ REDDEDİLDİ: "${row.source}" → "${row.translation}" (${target.slug}) [${reason}]`,
                      { ...logDetails, action: 'rejected' },
                    );
                  } catch (err: unknown) {
                    this.log('error', `Reddedilemedi (${row.translationId}): ${String(err)}`, { ...logDetails, action: 'reject_error', err });
                  }
                }
              } else {
                this.state.rejected++;
                this.log(
                  'warn',
                  `✗ RET ADAYI: "${row.source}" → "${row.translation}" (${target.slug}) [${reason}]`,
                  { ...logDetails, action: 'candidate_reject' },
                );
              }
            } else {
              this.state.skipped++;
              const note = judgement?.reason || 'Kararsız';
              this.log(
                'info',
                `― ATLANDI: "${row.source}" (${target.slug}) [${note} - Kuyrukta bırakıldı]`,
                { ...logDetails, action: 'skipped' },
              );
            }

            // Small pause between row actions
            if (pauseMs > 0) {
              await new Promise((resolve) => setTimeout(resolve, Math.min(pauseMs, 200)));
            }
          }

          // Next page in the same queue if available
          currentUrl = page.nextPageUrl;
          if (currentUrl && pauseMs > 0) {
            await new Promise((resolve) => setTimeout(resolve, pauseMs));
          }
        }

        this.state.targetsCompleted++;
        if (pauseMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, pauseMs));
        }
      }

      if (!signal.aborted) {
        this.state.phase = 'done';
        this.state.running = false;
        this.log(
          'success',
          `Tarama tamamlandı! ${this.state.approved} onay, ${this.state.rejected} ret, ${this.state.skipped} kararsız/atlandı.`,
        );
      }
    } catch (err: unknown) {
      if (!signal.aborted) {
        const msg = err instanceof Error ? err.message : String(err);
        this.state.phase = 'error';
        this.state.running = false;
        this.state.error = msg;
        this.log('error', `Beklenmeyen hata: ${msg}`);
      }
    } finally {
      if (this.abortController?.signal === signal) {
        if (signal.aborted) {
          this.state.phase = 'stopped';
          this.state.running = false;
          this.log('warn', 'İşlem durduruldu.');
        }
        this.abortController = null;
      }
    }
  }
}

export const queueWorkerManager = new QueueWorkerManager();
