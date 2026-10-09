# Turkish translation guide — general rules

This text is not just a grammar textbook; it is also a list of **decisions to be applied during translation**.

Source: TDK (Turkish Language Association) Spelling Rules. Items specific to WordPress are marked separately.

---

## 1. Capitalization — the most common mistake

**WordPress interface texts are written in sentence case, not title case.**

In English interfaces, capitalizing every word (*Title Case*) is a **style** convention, not a grammatical rule. In Turkish, capital letters are used only at the beginning of sentences and for proper nouns. A button text is a **command**, not a title.

| English | ✅ Correct | ❌ Incorrect |
|---|---|---|
| Save All Changes | Tüm değişiklikleri kaydet | Tüm Değişiklikleri Kaydet |
| Add New Post | Yeni yazı ekle | Yeni Yazı Ekle |
| Approve Comment | Yorumu onayla | Yorumu Onayla |
| Screen Options | Ekran seçenekleri | Ekran Seçenekleri |

Capitalization is used **only** for:

- Sentence beginnings
- Proper nouns: `WordPress`, `WooCommerce`, `Ayşe`, `İstanbul`, `Türkçe`
- Institution names: `Türk Dil Kurumu`
- Names of nationalities, languages, and religions: `Türk`, `Türkçe`, `Müslüman`

In titles of books, magazines, or articles, every word starts with a capital letter (`Nutuk`, `Türk Dili`) — but an interface text is not a book title. **When in doubt, choose sentence case.**

---

## 2. Placeholders and suffixes — WordPress specific

`%s`, `%d`, `%1$s` are replaced by values unknown at runtime. Since the final sound of the value is unknown, **suffix harmony cannot be calculated.**

**Rule: Do not add a suffix to a placeholder; structure the sentence so that it does not require one.**

This is not a preference, but a built-in practice: In the Turkish translations of WordPress core, WooCommerce, and BuddyPress, out of ~26,000 strings, **only 2** have an actual Turkish suffix added to a placeholder. 52% of placeholders are followed by a space, 32% by punctuation, and 14% by the end of the string.

| Source | ✅ Correct | ❌ Incorrect |
|---|---|---|
| `Delete %s?` | `%s silinsin mi?` | `%s'yi sil?` |
| `%s has been updated.` | `%s güncellendi.` | `%s'ı güncellendi.` |
| `Move to %s` | `Taşınacak yer: %s` | `%s'a taşı` |
| `Edit %s` | `Düzenle: %s` | `%s'ı düzenle` |

If a suffix cannot be avoided, there are two ways: either put the value in quotes (`"%s" silinsin mi?`), or choose the most inclusive suffix and mark it as a conscious exception. What is wrong is to assume a single harmony and pass silently: in the string `%s'ın siteleri`, if the value is *Ayşe*, the result becomes `Ayşe'ın` — the correct form is `Ayşe'nin`.

**Changing the order is permitted and encouraged.** This is exactly why the `%1$s`, `%2$s` format exists:
`%1$s in %2$s` → `%2$s içinde %1$s`

---

## 2b. Strings containing HTML

Tags and **structural** attributes remain as they are: `href`, `src`, `class`, `id`, `target`, `rel`. If they contain placeholders (`href="%1$s"`), they are preserved exactly.

However, **attribute texts visible to the user must be translated**: `title`, `alt`, `aria-label`, `placeholder`. These are texts seen on the screen or read by screen readers; leaving them in English makes them untranslated interface elements.

| | |
|---|---|
| ✅ | `<a href="%1$s" title="Sharing Docs">` → `<a href="%1$s" title="Paylaşma belgeleri">` |
| ❌ | `<a href="%2$s" title="Sharing Docs">` — href changed |
| ❌ | `<a href="%1$s">` — title deleted |
| ❌ | `<a href="%1$s" title="Sharing Docs">` — title not translated |

**Do not delete** the attribute; only translate its value.

**Order is flexible.** The positions of tags and placeholders within the sentence can change according to Turkish syntax; what matters is that their quantity and formats remain the same. `<b>A</b> and <i>B</i>` → `<i>B</i> ve <b>A</b>` is correct.

---

## 3. Apostrophe

**Used for:**

- Inflectional suffixes attached to proper nouns: `WordPress'te`, `Türkiye'nin`, `Ayşe'ye`
- Suffixes attached to abbreviations: `TDK'nin`, `URL'yi`, `API'den`, `HTML'e`
- Suffixes attached to numbers: `2024'te`, `8'inci`, `%50'si`
- Letters and syllables: `a'dan z'ye`

**Not used for:**

- Derivational suffixes: `Türkçe`, `Türklük`, `WordPressçi` *(not a proper noun, a derived word)*
- Plural suffixes: `Ahmetler`
- Suffixes attached to institution names: `Türk Dil Kurumundan` *(without apostrophe)*
- Common nouns: `sitede`, `yazıda`, `eklentiden`

---

## 4. Suffix harmony

**Consonant harmony.** Words ending with voiceless consonants (`ç f h k p s ş t`) take suffixes starting with voiceless consonants: `seç-ti`, `bak-tım`, `çiçek-ten`, `link-ten` — `seç-di` ✗

**Minor vowel harmony.** After an unrounded vowel comes an unrounded one; after a rounded vowel comes a close-rounded or open-unrounded one. This is not sought in loanwords (`doktor`, `radyo`, `alkol`), but the suffixes attached to them must match the final vowel: `müzik-çi`, `alkol-lü`.

**Vowel syncope.** In some two-syllable words, the close vowel of the second syllable drops when a suffix starting with a vowel is added: `ağız → ağzı`, `burun → burnu`, `şehir → şehri`.
However, the vowels in `içeri`, `dışarı`, `yukarı`, `ileri` **do not drop**: `içeride` ✅ / `içerde` ✗

**Consonant gemination.** Some words of Arabic origin double their final consonant when a suffix starting with a vowel is added: `hak → hakkı`, `af → affetmek`, `his → hissetmek`, `ret → reddi`, `zam → zammı`.

**Consonant lenition.** Loanwords ending in `p ç t k` soften when a suffix starting with a vowel is added: `kitap → kitabı`, `renk → rengi`.

**Vowel narrowing.** Before the `-yor` suffix, `a/e` narrows and **this is written**: `başla-yor → başlıyor`, `izle-yor → izliyor`. However, in multi-syllable verbs, narrowing is **not written** before `-acak/-ecek` and `-an/-en`: `başlayacak` ✅ / `başlıyacak` ✗, `gelmeyen` ✅ / `gelmiyen` ✗
Exception: `demek` and `yemek` — `diyen`, `diyecek`, `yiyecek` are written (but `deyince`, `deyip`).

**Suffixes for infinitives.** If `-a/-e` or `-ı/-i` are added to an infinitive ending in `-ma/-me`, a `y` is inserted: `okuma-y-a`, `görme-y-i`, `silme-y-i`.

---

## 5. Separate or joined

| Structure | Rule | Example |
|---|---|---|
| Conjunction `da/de` | **Separate**, no apostrophe, never `ta/te` | `Ayşe de geldi`, `ya da` |
| Locative suffix `-da/-de/-ta/-te` | **Joined** | `yolda`, `işte`, `sitede` |
| Conjunction `ki` | **Separate** | `demek ki`, `kaldı ki` |
| Fixed/Idiomatic `ki` | **Joined** | `belki`, `çünkü`, `hâlbuki`, `sanki`, `oysaki`, `mademki` |
| Question suffix `mı/mi/mu/mü` | **Separate**, following suffixes join to it | `Kaldı mı?`, `Verecek misin?`, `Silinsin mi?` |
| `ile` | Separate or joined | `bulut ile` / `bulutla`, `çevre-y-le` |
| Copula `idi/imiş/ise/iken` | Separate or joined | `yorgundu`, `gelirse`, `okuldayken` |
| Idioms | **Separate** | `göz atmak`, `kulak vermek` |
| Reduplications | **Separate**, no hyphens | `adım adım`, `yavaş yavaş`, `el ele` |
| Intensifiers | **Joined** | `bembeyaz`, `kupkuru`, `dümdüz` |
| Formed with `etmek/olmak` | **Separate** if no sound change | `kabul etmek`, `var olmak` — but `kaybolmak`, `emretmek` |

The `da/de` distinction is often confused in interfaces: *"Bu sayfada da görünür"* (conjunction, separate) / *"Bu sayfada görünür"* (suffix, joined).

---

## 6. Numbers, symbols, units

- Time, currency, measurement, statistics in **digits**: `18:30`, `5 TL`, `5 TRY`, `651317,3034`, `%25`, `5 MB`
- No space after percent and per-mille signs: `%25` ✅ / `% 25` ✗
- Ordinal numbers: `15.` or `15'inci` — not both (`15.'nci` ✗)
- Numbers with four or more digits are grouped by threes: `1.000`, `1.000,4765`, `326.197`
- Distributive numerals are written **in words**: `ikişer` ✅ / `2'şer` ✗
- No period after unit symbols: `5 cm`, `10 kg`
- The suffix follows the reading of the word, not the symbol: not `5 MB'a`, but `5 MB boyutunda` if possible.

---

## 7. Punctuation

- Punctuation marks are **joined** to the preceding word, followed by a space
- Ellipsis is a single character: `…` (not three separate dots)
- No comma before the `ve` conjunction
- Punctuation of a quoted sentence stays **inside** the quotes
- The `&` symbol does not exist in Turkish. This character and its HTML entity equivalent `&amp;` must be translated and used as "ve".

**Preserve the punctuation in the source.** If the source is `Save changes`, the translation is `Değişiklikleri kaydet`, not `Değişiklikleri kaydet.` If the source ends with a period, the translation must end with one too.

---

## 8. Loanwords and foreign names

- Established loanwords are written with Turkish spelling: `program`, `proje`, `spor`, `tren`, `elektrik`, `paragraf`
- Proper nouns from languages using the Latin alphabet are written in their **original form**: `WordPress`, `WooCommerce`, `Gutenberg`, `New York`
- Those with established forms are written in Turkish: `Londra`, `Atina`, `Napolyon`
- Term preferences are kept in the glossary; the glossary, not this guide, determines them. General trend: if there is an established Turkish equivalent, it is used (`e-posta`, `bağlantı`, `eklenti`, `tema`); otherwise, the original term is kept (not `plugin` but `eklenti`; but check the glossary for established ones like `widget`, `blok`).

---

## 9. Circumflex (caret)

- To distinguish meaning: `hala` (aunt) / `hâlâ` (still/yet), `adem` (human) / `âdem` (humanity)
- If `g`, `k`, `l` are read softly: `kâğıt`, `dergâh`, `Elâzığ`
- Relative suffix `-î`: `millî`, `resmî`, `dinî` — so it doesn't mix with `dini` (his religion)

Long vowels are **not marked** otherwise: `adalet`, `şair`, `numune`.

---

## 10. By interface text type

| Type | Format | Example |
|---|---|---|
| Button | Imperative, sentence case, no period | `Kaydet`, `Yeni yazı ekle` |
| Menu / tab | Noun phrase, sentence case | `Ekran seçenekleri` |
| Heading | Sentence case | `Yorum ayarları` |
| Confirmation | Question, `mi` separate | `Bu yazı silinsin mi?` |
| Info message | Full sentence, with period | `Değişiklikleriniz kaydedildi.` |
| Error message | State what it is and what to do | `Dosya yüklenemedi. Boyutu 2 MB'ı aşıyor.` |
| Field label | Short noun phrase, no colon | `E-posta adresi` |
| Placeholder text | Example value | `ornek@site.com` |

**Long texts (paragraphs, email bodies).** Translate sentence by sentence, maintain English sentence boundaries. Line breaks (`\n`), empty lines, and HTML structure must remain as in the source — these are formatting, not whitespace.

**You/Formal.** In WordPress Turkish translations, the user is addressed as **you (siz)**, but due to passive and imperative structures, the address often doesn't appear in most strings. Do not add a subject unnecessarily: `Değişiklikleriniz kaydedildi.` ✅ / `Siz değişikliklerinizi kaydettiniz.` ✗

---

## Open items

The following have not yet been decided; the owner will fill them in:

- Table of term preferences (will be kept in the glossary, not here)
- Tag-based additional rules (e-commerce, form, SEO…) in separate files
