import { beforeEach, describe, expect, it, vi } from 'vitest';
import { openDb, type Db } from '../src/db/open.ts';
import { setAppSetting } from '../src/db/appSettings.ts';
import { importProject } from '../src/project/import.ts';
import { publishProjectToWporg, verifyWporgSession } from '../src/wporg/publish.ts';
import type { Catalogue, TranslationUnit } from '../src/po/types.ts';

const catalogue = (units: Partial<TranslationUnit>[]): Catalogue => ({
  headers: { Language: 'tr' },
  units: units.map((u, ordinal) => ({ ordinal, msgid: '', ...u }) as TranslationUnit),
});

describe('WordPress.org PO publishing and session verification', () => {
  let db: Db;
  let projectId: number;

  beforeEach(() => {
    db = openDb(':memory:');
    projectId = importProject(
      db,
      {
        family: 'plugin',
        projectPath: 'wp-plugins/measured-quote/dev',
        translateUrl: 'https://translate.wordpress.org/projects/wp-plugins/measured-quote/dev/tr/default/',
        name: 'Measured Quote',
      },
      catalogue([
        { msgid: 'Save changes', msgstr: 'Değişiklikleri kaydet' },
        { msgid: 'Cancel', msgstr: 'İptal' },
        { msgid: 'Untranslated string', msgstr: '' },
      ]),
    );

    // Approve the first unit
    db.prepare(`UPDATE translation_units SET state = 'ok' WHERE project_id = ? AND msgid = 'Save changes'`).run(
      projectId,
    );
  });

  describe('verifyWporgSession', () => {
    it('returns valid: false when cookie is empty', async () => {
      const res = await verifyWporgSession('');
      expect(res.valid).toBe(false);
      expect(res.error).toContain('boş olamaz');
    });

    it('extracts username and display name when logged in', async () => {
      vi.stubGlobal('fetch', () =>
        Promise.resolve(
          new Response(
            `<html>
              <body>
                <span class="user-display-name">Turker YILDIRIM</span>
                <span class="username">trkr</span>
              </body>
            </html>`,
            { status: 200 },
          ),
        ),
      );

      const res = await verifyWporgSession('wporg_logged_in=trkr|...');
      expect(res.valid).toBe(true);
      expect(res.username).toBe('trkr');
      expect(res.displayName).toBe('Turker YILDIRIM');
    });

    it('detects logged-out or expired session', async () => {
      vi.stubGlobal('fetch', () =>
        Promise.resolve(new Response('<html><body>Login to WordPress.org</body></html>', { status: 403 })),
      );

      const res = await verifyWporgSession('expired_cookie=1');
      expect(res.valid).toBe(false);
      expect(res.error).toContain('dolmuş');
    });
  });

  describe('publishProjectToWporg', () => {
    it('throws if no approved strings exist', async () => {
      db.prepare(`UPDATE translation_units SET state = 'untranslated' WHERE project_id = ?`).run(projectId);
      setAppSetting(db, 'wporg_cookie', 'valid_cookie');

      await expect(publishProjectToWporg(db, projectId)).rejects.toThrow(/onaylı/);
    });

    it('throws if wporg cookie is not configured', async () => {
      db.prepare(`DELETE FROM app_settings WHERE key = 'wporg_cookie'`).run();

      await expect(publishProjectToWporg(db, projectId)).rejects.toThrow(/çerezi tanımlı değil/);
    });

    it('fetches nonce and posts multipart PO import to GlotPress', async () => {
      setAppSetting(db, 'wporg_cookie', 'wporg_logged_in=trkr|...');

      let getUrlCalled = '';
      let postUrlCalled = '';
      let postedFormData: FormData | null = null;

      vi.stubGlobal('fetch', (url: string | URL, init?: RequestInit) => {
        const urlStr = String(url);
        if (init?.method === 'GET' || !init?.method) {
          getUrlCalled = urlStr;
          return Promise.resolve(
            new Response(
              `<html>
                <form action="" method="post" enctype="multipart/form-data">
                  <input type="hidden" id="_gp_route_nonce" name="_gp_route_nonce" value="abc123nonce" />
                </form>
              </html>`,
              { status: 200 },
            ),
          );
        }

        if (init?.method === 'POST') {
          postUrlCalled = urlStr;
          postedFormData = init.body as FormData;
          return Promise.resolve(
            new Response(
              `<html>
                <div class="notice notice-success"><p>1 translation imported.</p></div>
              </html>`,
              { status: 200 },
            ),
          );
        }

        return Promise.reject(new Error(`Unexpected call: ${urlStr}`));
      });

      const result = await publishProjectToWporg(db, projectId);

      expect(result.ok).toBe(true);
      expect(result.exported).toBe(2);
      expect(result.message).toContain('1 translation imported');

      expect(getUrlCalled).toBe(
        'https://translate.wordpress.org/projects/wp-plugins/measured-quote/dev/tr/default/import-translations/',
      );
      expect(postUrlCalled).toBe(
        'https://translate.wordpress.org/projects/wp-plugins/measured-quote/dev/tr/default/import-translations/',
      );

      expect(postedFormData).not.toBeNull();
      expect(postedFormData!.get('_gp_route_nonce')).toBe('abc123nonce');
      expect(postedFormData!.get('format')).toBe('po');
      expect(postedFormData!.get('status')).toBe('current');
    });

    it('publishes only specified unitIds and marks them ok upon success', async () => {
      setAppSetting(db, 'wporg_cookie', 'wporg_logged_in=trkr|...');

      const units = db
        .prepare(`SELECT id, msgid, state FROM translation_units WHERE project_id = ? ORDER BY ordinal`)
        .all(projectId) as { id: number; msgid: string; state: string }[];

      // Set second unit ('Cancel') to review
      db.prepare(`UPDATE translation_units SET state = 'review' WHERE id = ?`).run(units[1]!.id);

      let postedFormData: FormData | null = null;
      vi.stubGlobal('fetch', (url: string | URL, init?: RequestInit) => {
        if (init?.method === 'GET' || !init?.method) {
          return Promise.resolve(
            new Response(
              `<html>
                <form action="" method="post" enctype="multipart/form-data">
                  <input type="hidden" id="_gp_route_nonce" name="_gp_route_nonce" value="nonce456" />
                </form>
              </html>`,
              { status: 200 },
            ),
          );
        }

        if (init?.method === 'POST') {
          postedFormData = init.body as FormData;
          return Promise.resolve(
            new Response(
              `<html>
                <div class="notice notice-success"><p>1 translation imported.</p></div>
              </html>`,
              { status: 200 },
            ),
          );
        }

        return Promise.reject(new Error(`Unexpected call: ${String(url)}`));
      });

      const result = await publishProjectToWporg(db, projectId, {
        unitIds: [units[1]!.id, units[2]!.id],
      });

      expect(result.ok).toBe(true);
      expect(result.exported).toBe(1);
      expect(result.withheld).toBe(1);

      const updatedCancel = db
        .prepare(`SELECT state FROM translation_units WHERE id = ?`)
        .get(units[1]!.id) as { state: string };
      expect(updatedCancel.state).toBe('ok');

      expect(postedFormData).not.toBeNull();
      expect(postedFormData!.get('_gp_route_nonce')).toBe('nonce456');
    });

    it('throws error when GlotPress returns notice-error', async () => {
      vi.stubGlobal('fetch', (_url: string | URL, init?: RequestInit) => {
        if (!init?.method || init.method === 'GET') {
          return Promise.resolve(
            new Response(
              `<html><input type="hidden" name="_gp_route_nonce" value="nonce789" /></html>`,
              { status: 200 },
            ),
          );
        }
        return Promise.resolve(
          new Response(
            `<html>
              <div class="notice notice-error"><p>Import failed: Invalid PO format.</p></div>
            </html>`,
            { status: 200 },
          ),
        );
      });

      await expect(publishProjectToWporg(db, projectId)).rejects.toThrow(
        /Import failed: Invalid PO format/,
      );
    });

    it('falls back to default success message when no notice element exists in postHtml', async () => {
      vi.stubGlobal('fetch', (_url: string | URL, init?: RequestInit) => {
        if (!init?.method || init.method === 'GET') {
          return Promise.resolve(
            new Response(
              `<html><input type="hidden" name="_gp_route_nonce" value="nonceFallback" /></html>`,
              { status: 200 },
            ),
          );
        }
        return Promise.resolve(
          new Response(`<html><body><div>Import completed without class.</div></body></html>`, {
            status: 200,
          }),
        );
      });

      const res = await publishProjectToWporg(db, projectId);
      expect(res.ok).toBe(true);
      expect(res.message).toContain('onaylı çeviri wp.org\'a başarıyla gönderildi ve yayınlandı');
    });
  });
});
