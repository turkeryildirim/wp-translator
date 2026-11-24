import { NO_TOOLS } from '../translate/prompt.ts';
import type { Term } from '../glossary/terminology.ts';
import type { Submission } from './verdict.ts';

export interface JudgeContext {
  styleGuide: string;
  terms: Term[];
}

/** One submission as the model sees it. Ids travel opaquely, as in translation. */
export interface JudgeItem {
  i: number;
  s: string;
  p?: string;
  /** `msgctxt`: what the string is used for. Disambiguates, and is never translated. */
  c?: string;
  t: string;
  tp?: string;
}

/**
 * Ask whether each submitted translation obeys the rules, and what the model
 * would have written instead.
 *
 * Both are asked for because the owner is reviewing somebody else's work: a
 * verdict alone says a translation is wrong without saying what right looks
 * like, and the two side by side is what makes a decision quick.
 */
export function buildJudgePrompt(context: JudgeContext): string {
  const sections = [
    NO_TOOLS,
    '',
    'Aşağıdaki JSON, bir WordPress projesine BAŞKA çevirmenler tarafından gönderilmiş',
    've henüz onaylanmamış çevirilerdir. Her öğede "s" İngilizce kaynak, "t" gönderilen',
    'Türkçe çeviridir. "p" varsa İngilizce çoğul, "tp" gönderilen çoğul çeviridir.',
    '"c" varsa dizgenin gettext bağlamıdır (msgctxt): dizgenin arayüzde nerede ve ne olarak',
    'kullanıldığını söyler, anlamını belirler ve ÇEVRİLMEZ. Aynı İngilizce kelimenin iki',
    'bağlamda iki ayrı karşılığı olabilir; kararı o bağlama göre ver.',
    '',
    'Görevin ÇEVİRMEK DEĞİL, DENETLEMEK: her çeviri aşağıdaki kurallara ve sözlüğe',
    'uyuyor mu? Ayrıca sen nasıl çevirirdin?',
    '',
    'ÇIKTI BİÇİMİ — buna harfiyen uy:',
    '- Her öğe: {"i": <aynı id>, "ok": true|false, "why": "<kısa gerekçe>", "mine": "<senin çevirin>"}',
    '- "ok": çeviri kabul edilebilir mi. Farklı ama doğru bir ifade KABUL EDİLİR;',
    '  senin çevirinle birebir aynı olması gerekmez.',
    '- "ok": false ise "why" hangi kuralın çiğnendiğini söyler. true ise "why" boş olabilir.',
    '- "why" Türkçe ve tek cümle olsun.',
    '- Girdideki her "i" için tam olarak bir öğe döndür. Yeni id uydurma, hiçbirini atlama.',
    '',
    'NE ZAMAN "ok": false:',
    '- Yer tutucular (%s, %d, %1$s, %@) sayı ya da biçim olarak kaynaktan farklıysa.',
    '- HTML etiketleri ya da yapısal öznitelikleri (href, src, class, id) bozulmuşsa.',
    '- Anlam yanlışsa ya da kaynağın söylemediği bir şey söylüyorsa.',
    '- Sözlükteki terim karşılıkları yerine başka karşılıklar kullanılmışsa.',
    '- Üslup rehberindeki bir kural çiğnenmişse (özellikle büyük harf düzeni).',
    '',
    'NE ZAMAN "ok": true:',
    '- Anlam doğru, kurallara uygun, yer tutucular yerinde — ifade senin seçeceğinden',
    '  farklı olsa bile. Üslup tercihi yüzünden reddetme.',
    '- Kaynağın birden fazla geçerli Türkçe karşılığı olabilir (örn. Continue -> Devam et / İlerle;',
    '  Enabled -> Etkin / Etkinleştirildi; Rating -> Puan / Değerlendirme). Sözlükteki ilk karşılıktan',
    '  farklı olsa da bağlama ve anlama uygunsa KABUL ET (ok: true).',
  ];

  if (context.terms.length > 0) {
    sections.push(
      '',
      'SÖZLÜK — bu karşılıklar insan çevirmenlerce onaylanmıştır:',
      ...context.terms.map(
        (term) => `- ${term.source}: ${term.readings.map((r) => r.translation).join(' / ')}`,
      ),
    );
  }

  if (context.styleGuide.trim()) sections.push('', 'ÜSLUP REHBERİ:', context.styleGuide.trim());

  return sections.join('\n');
}

/** The submissions as a payload, ids renumbered per batch as translation does. */
export const toJudgeItems = (submissions: readonly Submission[]): JudgeItem[] =>
  submissions.map((submission, index) => ({
    i: index,
    s: submission.source,
    ...(submission.sourcePlural ? { p: submission.sourcePlural } : {}),
    ...(submission.context ? { c: submission.context } : {}),
    t: submission.translation,
    ...(submission.translationPlural ? { tp: submission.translationPlural } : {}),
  }));
