import type { Db } from '../db/open.ts';
import { getAppSetting } from '../db/appSettings.ts';
import { exportProject } from '../project/export.ts';
import { load } from 'cheerio';

export interface PublishResult {
  ok: boolean;
  message: string;
  exported: number;
  withheld: number;
}

export interface SessionVerification {
  valid: boolean;
  username?: string | undefined;
  displayName?: string | undefined;
  error?: string | undefined;
}

const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36';

/**
 * Verify if the provided WordPress.org session cookie is valid and has an active login.
 */
export async function verifyWporgSession(cookie: string): Promise<SessionVerification> {
  const trimmed = cookie.trim();
  if (!trimmed) {
    return { valid: false, error: 'Oturum çerezi boş olamaz.' };
  }

  try {
    const res = await fetch('https://translate.wordpress.org/locale/tr/default/', {
      method: 'GET',
      headers: {
        Cookie: trimmed,
        'User-Agent': DEFAULT_USER_AGENT,
      },
    });

    if (res.status === 401 || res.status === 403 || res.url.includes('login.wordpress.org')) {
      return { valid: false, error: 'Oturum süresi dolmuş veya geçersiz.' };
    }

    if (!res.ok) {
      return { valid: false, error: `WordPress.org yanıt vermedi (HTTP ${res.status}).` };
    }

    const html = await res.text();

    if (html.includes('wp-login.php') && !html.includes('wp-admin-bar-my-account')) {
      return { valid: false, error: 'Giriş yapılmamış; çerez oturum açmış bir kullanıcıya ait değil.' };
    }

    const userMatch = /<span class=['"]username['"]>([^<]+)<\/span>/i.exec(html);
    const displayMatch = /<span class=['"]user-display-name['"]>([^<]+)<\/span>/i.exec(html);

    return {
      valid: true,
      username: userMatch && userMatch[1] ? userMatch[1].trim() : undefined,
      displayName: displayMatch && displayMatch[1] ? displayMatch[1].trim() : undefined,
    };
  } catch (err: unknown) {
    return { valid: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export interface PublishOptions {
  status?: 'current' | 'waiting' | undefined;
  unitIds?: readonly number[] | undefined;
}

/**
 * Direct PO import to translate.wordpress.org using authenticated GlotPress web import.
 */
export async function publishProjectToWporg(
  db: Db,
  projectId: number,
  options?: PublishOptions,
): Promise<PublishResult> {
  const project = db
    .prepare(
      `SELECT id, name, project_path AS projectPath, translate_url AS translateUrl
         FROM projects
        WHERE id = ?`,
    )
    .get(projectId) as
    | { id: number; name: string | null; projectPath: string; translateUrl: string }
    | undefined;

  if (!project) throw new Error(`Proje bulunamadı (ID: ${projectId}).`);

  const { po, exported, withheld } = exportProject(db, projectId, {
    unitIds: options?.unitIds,
  });
  if (exported === 0) {
    if (options?.unitIds && options.unitIds.length > 0) {
      throw new Error('Seçilen satırlarda gönderilecek geçerli bir çeviri metni bulunamadı.');
    }
    throw new Error('Yayınlanacak onaylı ("ok") çeviri bulunamadı. Önce çevirileri onaylayın.');
  }

  const cookie = getAppSetting(db, 'wporg_cookie');
  if (!cookie || !cookie.trim()) {
    throw new Error(
      'WordPress.org oturum çerezi tanımlı değil. Lütfen "Genel Ayarlar" ekranından çerezinizi kaydedin.',
    );
  }

  const base = project.translateUrl.endsWith('/') ? project.translateUrl : `${project.translateUrl}/`;
  const importUrl = `${base}import-translations/`;

  // 1. Fetch import page to retrieve _gp_route_nonce
  const getRes = await fetch(importUrl, {
    method: 'GET',
    headers: {
      Cookie: cookie.trim(),
      'User-Agent': DEFAULT_USER_AGENT,
    },
  });

  if (getRes.status === 401 || getRes.status === 403 || getRes.url.includes('login.wordpress.org')) {
    throw new Error(
      'WordPress.org oturumunuzun süresi dolmuş veya yetki yetersiz. Lütfen Ayarlar sekmesinden çerezinizi güncelleyin.',
    );
  }

  if (!getRes.ok) {
    throw new Error(`GlotPress içe aktarma sayfasına erişilemedi (HTTP ${getRes.status}).`);
  }

  const html = await getRes.text();

  const nonceMatch =
    /name=["']_gp_route_nonce["'][^>]*value=["']([^"']+)["']/i.exec(html) ||
    /value=["']([^"']+)["'][^>]*name=["']_gp_route_nonce["']/i.exec(html) ||
    /id=["']_gp_route_nonce["'][^>]*value=["']([^"']+)["']/i.exec(html);

  if (!nonceMatch || !nonceMatch[1]) {
    throw new Error(
      'GlotPress güvenlik kodu (_gp_route_nonce) formdan alınamadı. Bu projede içe aktarma yetkiniz olmayabilir.',
    );
  }

  const nonce = nonceMatch[1];

  // 2. Prepare multipart/form-data payload
  const form = new FormData();
  const filename = `${project.projectPath.replace(/[^a-zA-Z0-9_-]/g, '-')}-tr.po`;
  form.append('import-file', new Blob([po], { type: 'text/x-gettext-translation' }), filename);
  form.append('format', 'po');
  form.append('status', options?.status ?? 'current');
  form.append('_gp_route_nonce', nonce);
  form.append('_wp_http_referer', importUrl);
  form.append('submit', 'Import');

  // 3. POST to GlotPress import endpoint
  const postRes = await fetch(importUrl, {
    method: 'POST',
    redirect: 'manual',
    headers: {
      Cookie: cookie.trim(),
      'User-Agent': DEFAULT_USER_AGENT,
      Referer: importUrl,
    },
    body: form,
  });

  let resultRes = postRes;
  const notices = new Map<string, string>();
  if ([301, 302, 303].includes(postRes.status)) {
    const location = postRes.headers.get('location');
    if (!location) throw new Error('GlotPress yönlendirme adresi bulunamadı.');
    const destination = new URL(location, importUrl);
    const expected = new URL(base);
    const importPage = new URL(importUrl);
    if (destination.origin !== expected.origin ||
        ![expected.pathname.replace(/\/$/, ''), importPage.pathname.replace(/\/$/, '')]
          .includes(destination.pathname.replace(/\/$/, ''))) {
      throw new Error('GlotPress içe aktarma beklenmeyen bir adrese yönlendirildi.');
    }
    const cookiePairs = cookie.split(';').map((part) => part.trim())
      .filter((part) => part && !part.startsWith('_gp_notice_'));
    for (const header of postRes.headers.getSetCookie()) {
      const pair = header.split(';', 1)[0] ?? '';
      const match = /^(_gp_notice_(?:error|success|notice))=([^;\r\n]*)$/.exec(pair);
      if (!match || !match[2]) continue;
      cookiePairs.push(pair);
      try {
        notices.set(match[1]!, decodeURIComponent(match[2].replace(/\+/g, ' ')));
      } catch {
        notices.set(match[1]!, match[2]);
      }
    }
    resultRes = await fetch(destination, {
      headers: { Cookie: cookiePairs.join('; '), 'User-Agent': DEFAULT_USER_AGENT },
      redirect: 'manual',
    });
  }
  if (!resultRes.ok) {
    throw new Error(`GlotPress içe aktarma yanıtı başarısız (HTTP ${resultRes.status}).`);
  }
  const postHtml = await resultRes.text();

  if (postHtml.includes('notice-error') || postHtml.includes('error-message')) {
    const errorMatch =
      /class=["'][^"']*notice-error[^"']*["'][^>]*>([\s\S]*?)<\/div>/i.exec(postHtml) ||
      /class=["'][^"']*error[^"']*["'][^>]*>([\s\S]*?)<\/div>/i.exec(postHtml);
    const errText =
      errorMatch && errorMatch[1]
        ? errorMatch[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
        : 'GlotPress içe aktarma sırasında hata verdi.';
    throw new Error(errText);
  }

  const noticeError = notices.get('_gp_notice_error');
  if (noticeError) throw new Error(load(noticeError).text().trim());
  const noticeMatch =
    /class=["'][^"']*notice-(?:success|info)[^"']*["'][^>]*>([\s\S]*?)<\/div>/i.exec(postHtml) ||
    /id=["']gp-js-message["'][^>]*>([\s\S]*?)<\/div>/i.exec(postHtml);
  const rawMessage = notices.get('_gp_notice_success') ?? notices.get('_gp_notice_notice') ?? noticeMatch?.[1];
  let message = rawMessage ? load(rawMessage).text().replace(/\s+/g, ' ').trim() : '';
  if (!message) {
    message = `${exported} adet onaylı çeviri wp.org'a başarıyla gönderildi ve yayınlandı.`;
  }

  // If specific units were published, update their local state to 'ok'
  if (options?.status !== 'waiting' && options?.unitIds && options.unitIds.length > 0) {
    const placeholders = options.unitIds.map(() => '?').join(', ');
    db.prepare(
      `UPDATE translation_units
          SET state = 'ok'
        WHERE project_id = ?
          AND id IN (${placeholders})
          AND msgstr IS NOT NULL AND msgstr <> ''`,
    ).run(projectId, ...options.unitIds);
  }

  return {
    ok: true,
    message,
    exported,
    withheld,
  };
}
