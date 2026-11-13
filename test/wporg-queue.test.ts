import { beforeEach, describe, expect, it, vi } from 'vitest';
import { openDb, type Db } from '../src/db/open.ts';
import { setAppSetting } from '../src/db/appSettings.ts';
import { parseWaitingProjects, parseSubProjectTargets, scanQueueTargets } from '../src/wporg/scanner.ts';
import { parseQueuePage, setTranslationStatus } from '../src/wporg/reviewer.ts';
import { queueWorkerManager } from '../src/wporg/queueWorker.ts';

describe('WordPress.org Queue Scanner & Reviewer', () => {
  let db: Db;

  beforeEach(() => {
    db = openDb(':memory:');
    if (queueWorkerManager.getState().running) {
      queueWorkerManager.stop();
    }
  });

  describe('Scanner HTML parsing', () => {
    it('parses waiting projects list from HTML', () => {
      const html = `
        <div id="projects">
          <div class="project project-wp-plugins percent-0">
            <div class="project-name">
              <h4><a href="/locale/tr/default/wp-plugins/sample-plugin/">Sample Plugin</a></h4>
            </div>
            <div class="project-status-waiting">
              <span class="project-status-value">25</span>
            </div>
          </div>
          <div class="project project-wp-plugins percent-50">
            <div class="project-name">
              <h4><a href="/locale/tr/default/wp-plugins/zero-plugin/">Zero Plugin</a></h4>
            </div>
            <div class="project-status-waiting">
              <span class="project-status-value">0</span>
            </div>
          </div>
        </div>
      `;

      const list = parseWaitingProjects(html, 'plugin');
      expect(list).toHaveLength(2);
      expect(list[0]).toEqual({
        family: 'plugin',
        slug: 'sample-plugin',
        name: 'Sample Plugin',
        waitingCount: 25,
        url: 'https://translate.wordpress.org/locale/tr/default/wp-plugins/sample-plugin/',
      });
      expect(list[1]!.waitingCount).toBe(0);
    });

    it('parses sub-project targets and balances trunk vs released pairs', () => {
      const html = `
        <table class="locale-sub-projects">
          <tbody>
            <tr>
              <td class="set-name">
                <a href="/projects/wp-plugins/sample/stable/tr/default/">Stable</a>
              </td>
              <td class="stats fuzzy"><a href="#">2</a></td>
              <td class="stats waiting"><a href="#">10</a></td>
            </tr>
            <tr>
              <td class="set-name">
                <a href="/projects/wp-plugins/sample/dev/tr/default/">Dev</a>
              </td>
              <td class="stats fuzzy"><a href="#">0</a></td>
              <td class="stats waiting"><a href="#">5</a></td>
            </tr>
            <tr>
              <td class="set-name">
                <a href="/projects/wp-plugins/sample/stable-readme/tr/default/">Stable Readme</a>
              </td>
              <td class="stats fuzzy"><a href="#">0</a></td>
              <td class="stats waiting"><a href="#">0</a></td>
            </tr>
          </tbody>
        </table>
      `;

      const targets = parseSubProjectTargets(html, 'plugin', 'sample', 'Sample');
      // Stable has 10+2=12, Dev has 5+0=5 -> Stable is chosen.
      // Stable has waiting=10, fuzzy=2 -> 2 targets (waiting and fuzzy).
      expect(targets).toHaveLength(2);
      expect(targets[0]!.subProject).toBe('stable');
      expect(targets[0]!.status).toBe('waiting');
      expect(targets[0]!.count).toBe(10);
      expect(targets[1]!.status).toBe('fuzzy');
      expect(targets[1]!.count).toBe(2);
    });

    it('parses theme sub-projects without dev/stable split', () => {
      const html = `
        <table>
          <tbody>
            <tr>
              <td class="set-name"><a href="/projects/wp-themes/my-theme/tr/default/">My Theme</a></td>
              <td class="stats fuzzy"><a href="#">3</a></td>
              <td class="stats waiting"><a href="#">7</a></td>
            </tr>
          </tbody>
        </table>
      `;

      const targets = parseSubProjectTargets(html, 'theme', 'my-theme', 'My Theme');
      expect(targets).toHaveLength(2);
      expect(targets[0]!.status).toBe('waiting');
      expect(targets[0]!.count).toBe(7);
      expect(targets[0]!.projectPath).toBe('wp-themes/my-theme');
      expect(targets[1]!.status).toBe('fuzzy');
      expect(targets[1]!.count).toBe(3);
    });
  });

  describe('Reviewer page parsing and action execution', () => {
    it('parses queue rows, text cleanups, nonces and next page link', () => {
      const html = `
        <script>var gp_editor_options = {"set_status_url":"/projects/wp-plugins/sample/dev/tr/default/-set-status/"};</script>
        <table id="translations">
          <tr class="preview status-waiting" row="101-501">
            <td class="original">
              <span class="original-text">Save <span class="glossary-word">settings</span></span>
              <div class="original-tags"><span class="context bubble">admin menu</span></div>
            </td>
            <td class="translation foreign-text">
              <span class="translation-text">Ayarları kaydet</span>
            </td>
            <td>
              <button class="inline-action-approve" data-nonce="nonce_app_123">+</button>
              <button class="inline-action-reject" data-nonce="nonce_rej_456">-</button>
            </td>
          </tr>
        </table>
        <div class="paging">
          <a class="next" href="?page=2">&rarr;</a>
        </div>
      `;

      const page = parseQueuePage(html, 'https://translate.wordpress.org/projects/wp-plugins/sample/dev/tr/default/?filters[status]=waiting');

      expect(page.setStatusUrl).toBe('https://translate.wordpress.org/projects/wp-plugins/sample/dev/tr/default/-set-status/');
      expect(page.nextPageUrl).toBe('https://translate.wordpress.org/projects/wp-plugins/sample/dev/tr/default/?page=2');
      expect(page.rows).toHaveLength(1);

      const row = page.rows[0]!;
      expect(row.rowId).toBe('101-501');
      expect(row.originalId).toBe(101);
      expect(row.translationId).toBe(501);
      expect(row.source).toBe('Save settings');
      expect(row.translation).toBe('Ayarları kaydet');
      expect(row.context).toBe('admin menu');
      expect(row.approveNonce).toBe('nonce_app_123');
      expect(row.rejectNonce).toBe('nonce_rej_456');
    });

    it('sends set-status POST request with proper nonce and payload', async () => {
      let postedBody = '';
      vi.stubGlobal('fetch', (_url: string | URL, init?: RequestInit) => {
        postedBody = String(init?.body);
        return Promise.resolve(new Response('{"ok":true}', { status: 200 }));
      });

      const ok = await setTranslationStatus(
        'https://translate.wordpress.org/projects/wp-plugins/sample/dev/tr/default/-set-status/',
        501,
        'current',
        'nonce_app_123',
        'wporg_cookie_val',
      );

      expect(ok).toBe(true);
      expect(postedBody).toContain('translation_id=501');
      expect(postedBody).toContain('status=current');
      expect(postedBody).toContain('_gp_route_nonce=nonce_app_123');
    });
  });

  describe('QueueWorkerManager lifecycle', () => {
    it('throws if wporg cookie is not set in app_settings', () => {
      setAppSetting(db, 'wporg_cookie', '');
      expect(() => queueWorkerManager.start(db)).toThrow(/oturum çerezi/);
    });

    it('initializes state and allows stopping', () => {
      setAppSetting(db, 'wporg_cookie', 'test_cookie');
      vi.stubGlobal('fetch', () => Promise.resolve(new Response('<html><body></body></html>', { status: 200 })));

      const state = queueWorkerManager.start(db, { mode: 'dry_run' });
      expect(state.running).toBe(true);
      expect(state.phase).toBe('scanning');
      expect(state.mode).toBe('dry_run');

      const stopped = queueWorkerManager.stop();
      expect(stopped.running).toBe(false);
      expect(stopped.phase).toBe('stopped');
    });
  });
});
