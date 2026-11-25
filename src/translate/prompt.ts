import type { TranslationContext } from './types.ts';

/**
 * Both providers are coding agents whose models can reach for a shell or a file
 * read instead of answering, which spends the turn and returns nothing. Measured
 * against agy, this line is what stops it.
 */
export const NO_TOOLS =
  'Bu bir metin görevidir. Hiçbir araç, komut ya da dosya okuma kullanma; ' +
  'yalnızca istenen JSON yapısını döndür.';

/**
 * Build the instruction that accompanies the JSON payload.
 *
 * Where the payload itself sits differs per provider — opencode attaches it as a
 * file, agy carries it inline — so this says only that there is one. The
 * terminology block is the part that does the real work: consistency across the
 * strings nobody has translated before comes from telling the model how each
 * known term has already been translated.
 */
export function buildPrompt(context: TranslationContext): string {
  const sections = [
    NO_TOOLS,
    '',
    'Sana verilen JSON, bir WordPress projesinden İngilizce arayüz metinlerinin listesidir.',
    'Her öğenin "s" değerini Türkçeye (tr_TR) çevir. "p" varsa İngilizce çoğul biçimdir, onu da çevir.',
    '"c" varsa gettext bağlamıdır; anlamı belirlemek için kullan, çevrilecek metin olarak alma.',
    '"u" varsa metnin kullanım alanını belirtir (admin, frontend veya both); üslup ve sözcük seçimini buna göre yap.',
    '',
    'ÇIKTI BİÇİMİ — buna harfiyen uy:',
    '- Yalnızca bir JSON dizisi döndür. Açıklama, giriş cümlesi, markdown çiti yazma.',
    '- Her öğe: {"i": <aynı id>, "t": "<Türkçe çeviri>"}; "p" verilmişse ayrıca "tp".',
    '- Girdideki her "i" için tam olarak bir öğe döndür. Yeni id uydurma, hiçbirini atlama.',
    '',
    'ÇEVİRİ KURALLARI:',
    '- Yer tutucuları (%s, %d, %1$s, %@) kaynaktakiyle aynı sayıda ve aynı biçimde koru.',
    '- HTML etiketlerini ve yapısal özniteliklerini (href, src, class, id, target…) olduğu gibi koru.',
    '- Ama kullanıcıya görünen öznitelik metinlerini ÇEVİR: title, alt, aria-label, placeholder.',
    '  Örnek: <a href="%1$s" title="Sharing Docs"> → <a href="%1$s" title="Paylaşma belgeleri">',
    '  Özniteliği silme; yalnızca değerini çevir.',
    '- Yer tutucuların ve etiketlerin SIRASI değişebilir — Türkçe söz dizimi bunu gerektirir.',
    '  Sayıları ve biçimleri aynı kaldığı sürece serbestsin: "%1$s in %2$s" → "%2$s içinde %1$s".',
    '- Satır sonlarını (\\n) ve baştaki/sondaki boşlukları kaynaktaki gibi bırak.',
    '- Kaynak nokta ile bitmiyorsa çeviri de bitmesin.',
  ];

  const project = describeProject(context);
  if (project) sections.push('', 'PROJE:', project);

  if (context.terms.length > 0) {
    sections.push(
      '',
      'SÖZLÜK — bu terimler insan çevirmenlerce onaylanmıştır. Geçtikleri yerde bu karşılıkları kullan.',
      'Bir terimin birden fazla karşılığı varsa bağlama uyanı seç.',
      '',
      ...context.terms.map(formatTerm),
    );
  }

  if (context.styleGuide.trim()) {
    sections.push('', 'ÜSLUP REHBERİ:', context.styleGuide.trim());
  }

  return sections.join('\n');
}

function formatTerm(term: { source: string; readings: readonly { translation: string; pos?: string; note?: string }[] }): string {
  const readings = term.readings
    .map((reading) => {
      const pos = reading.pos ? ` (${reading.pos})` : '';
      const note = reading.note ? ` — ${collapse(reading.note)}` : '';
      return `${reading.translation}${pos}${note}`;
    })
    .join(' | ');
  return `- ${term.source} = ${readings}`;
}

function describeProject(context: TranslationContext): string {
  const project = context.project;
  if (!project) return '';

  const parts: string[] = [];
  if (project.name) parts.push(project.name);
  if (project.description) parts.push(collapse(project.description));
  if (project.readme) parts.push(collapse(project.readme).slice(0, 1200));
  return parts.join('\n');
}

const collapse = (text: string): string => text.replace(/\s+/g, ' ').trim();
