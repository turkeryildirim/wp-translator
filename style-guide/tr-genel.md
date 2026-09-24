# Türkçe çeviri rehberi — genel kurallar

Bu metin, çeviri isteklerinin her birinde yapay zekâya sözlük terimleriyle birlikte gönderilir. Bir dil bilgisi ders kitabı değil; **çeviri anında uygulanacak kararlar** listesidir.

Kaynak: TDK Yazım Kuralları. WordPress'e özgü maddeler ayrıca işaretlendi.

---

## 1. Büyük harf — en sık yapılan hata

**WordPress arayüz metinleri cümle düzeninde yazılır, başlık düzeninde değil.**

İngilizce arayüzde her kelimenin büyük harfle başlaması (*Title Case*) bir **biçem** geleneğidir, dil bilgisi kuralı değil. Türkçede büyük harf yalnızca cümle başında ve özel adlarda kullanılır. Bir düğme metni **emirdir**, başlık değil.

| İngilizce | ✅ Doğru | ❌ Yanlış |
|---|---|---|
| Save All Changes | Tüm değişiklikleri kaydet | Tüm Değişiklikleri Kaydet |
| Add New Post | Yeni yazı ekle | Yeni Yazı Ekle |
| Approve Comment | Yorumu onayla | Yorumu Onayla |
| Screen Options | Ekran seçenekleri | Ekran Seçenekleri |

Büyük harf **yalnızca** şunlarda:

- Cümle başı
- Özel adlar: `WordPress`, `WooCommerce`, `Ayşe`, `İstanbul`, `Türkçe`
- Kurum adları: `Türk Dil Kurumu`
- Millet, dil, din adları: `Türk`, `Türkçe`, `Müslüman`

Kitap, dergi, yazı adlarında her kelime büyük harfle başlar (`Nutuk`, `Türk Dili`) — ama bir arayüz metni yazı adı değildir. **Tereddütte kalınca cümle düzenini seç.**

---

## 2. Yer tutucular ve ekler — WordPress'e özgü

`%s`, `%d`, `%1$s` çalışma anında bilinmeyen bir değerle dolar. Değerin son sesi bilinmediği için **ek uyumu hesaplanamaz**.

**Kural: yer tutucuya ek ekleme, cümleyi ek gerektirmeyecek şekilde kur.**

Bu bir tercih değil, yerleşik uygulama: WordPress core, WooCommerce ve BuddyPress'in Türkçe çevirilerinde ~26.000 dizeden **yalnızca 2 tanesinde** yer tutucuya gerçek bir Türkçe eki eklenmiş. Yer tutucuların %52'sini boşluk, %32'sini noktalama, %14'ünü dize sonu izliyor.

| Kaynak | ✅ Doğru | ❌ Yanlış |
|---|---|---|
| `Delete %s?` | `%s silinsin mi?` | `%s'yi sil?` |
| `%s has been updated.` | `%s güncellendi.` | `%s'ı güncellendi.` |
| `Move to %s` | `Taşınacak yer: %s` | `%s'a taşı` |
| `Edit %s` | `Düzenle: %s` | `%s'ı düzenle` |

Ekten kaçınılamıyorsa iki yol var: ya değeri tırnağa al (`"%s" silinsin mi?`), ya da eki en geniş biçimde seç ve bunu bilinçli bir istisna olarak işaretle. Yanlış olan, tek bir uyum varsayıp sessizce geçmek: `%s'ın siteleri` dizesinde değer *Ayşe* ise sonuç `Ayşe'ın` olur — doğrusu `Ayşe'nin`.

**Sıra değiştirmek serbesttir ve teşvik edilir.** `%1$s`, `%2$s` biçimi tam bu yüzden vardır:
`%1$s in %2$s` → `%2$s içinde %1$s`

---

## 2b. HTML içeren dizeler

Etiketler ve **yapısal** öznitelikler olduğu gibi kalır: `href`, `src`, `class`, `id`,
`target`, `rel`. Bunlarda yer tutucu varsa (`href="%1$s"`) birebir korunur.

Ama **kullanıcının gördüğü öznitelik metinleri çevrilir**: `title`, `alt`,
`aria-label`, `placeholder`. Bunlar ekranda görünen ya da ekran okuyucunun
seslendirdiği metinlerdir; İngilizce bırakmak onları çevrilmemiş arayüz yapar.

| | |
|---|---|
| ✅ | `<a href="%1$s" title="Sharing Docs">` → `<a href="%1$s" title="Paylaşma belgeleri">` |
| ❌ | `<a href="%2$s" title="Sharing Docs">` — href değişmiş |
| ❌ | `<a href="%1$s">` — title silinmiş |
| ❌ | `<a href="%1$s" title="Sharing Docs">` — title çevrilmemiş |

Özniteliği **silme**; yalnızca değerini çevir.

**Sıra serbesttir.** Etiketlerin ve yer tutucuların cümle içindeki yeri Türkçe söz
dizimine göre değişebilir; önemli olan sayılarının ve biçimlerinin aynı kalması.
`<b>A</b> and <i>B</i>` → `<i>B</i> ve <b>A</b>` doğrudur.

---

## 3. Kesme işareti

**Kullanılır:**

- Özel ada gelen çekim eki: `WordPress'te`, `Türkiye'nin`, `Ayşe'ye`
- Kısaltmaya gelen ek: `TDK'nin`, `URL'yi`, `API'den`, `HTML'e`
- Sayıya gelen ek: `2024'te`, `8'inci`, `%50'si`
- Harf ve hece: `a'dan z'ye`

**Kullanılmaz:**

- Yapım eki: `Türkçe`, `Türklük`, `WordPressçi` *(ad değil, türetilmiş sözcük)*
- Çokluk eki: `Ahmetler`
- Kurum adına gelen ek: `Türk Dil Kurumundan` *(kesmesiz)*
- Cins adlar: `sitede`, `yazıda`, `eklentiden`

---

## 4. Ek uyumu

**Ünsüz uyumu.** Sert ünsüzle (`ç f h k p s ş t`) biten sözcük sert ünsüzle başlayan ek alır:
`seç-ti`, `bak-tım`, `çiçek-ten`, `link-ten` — `seç-di` ✗

**Küçük ünlü uyumu.** Düz ünlüden sonra düz, yuvarlaktan sonra dar yuvarlak veya geniş düz gelir. Alıntı sözcüklerde aranmaz (`doktor`, `radyo`, `alkol`), ama onlara gelen ek son ünlüye uyar: `müzik-çi`, `alkol-lü`.

**Ünlü düşmesi.** İki heceli bazı sözcüklerde ikinci hecenin dar ünlüsü, ünlüyle başlayan ek alınca düşer: `ağız → ağzı`, `burun → burnu`, `şehir → şehri`.
Ama `içeri`, `dışarı`, `yukarı`, `ileri` sözcüklerinin ünlüsü **düşmez**: `içeride` ✅ / `içerde` ✗

**Ünsüz türemesi.** Arapça kökenli bazı sözcükler ünlüyle başlayan ek alınca son ünsüzünü ikizler: `hak → hakkı`, `af → affetmek`, `his → hissetmek`, `ret → reddi`, `zam → zammı`.

**Ünsüz yumuşaması.** Sonu `p ç t k` ile biten alıntı sözcükler ünlüyle başlayan ek alınca yumuşar: `kitap → kitabı`, `renk → rengi`.

**Ünlü daralması.** `-yor` eki önünde `a/e` daralır ve **yazıya geçer**: `başla-yor → başlıyor`, `izle-yor → izliyor`. Ama çok heceli fiillerde `-acak/-ecek`, `-an/-en` önünde daralma **yazılmaz**: `başlayacak` ✅ / `başlıyacak` ✗, `gelmeyen` ✅ / `gelmiyen` ✗
İstisna: `demek` ve `yemek` — `diyen`, `diyecek`, `yiyecek` yazılır (ama `deyince`, `deyip`).

**Mastara gelen ek.** `-ma/-me` ile biten mastara `-a/-e` veya `-ı/-i` gelirse araya `y` girer: `okuma-y-a`, `görme-y-i`, `silme-y-i`.

---

## 5. Ayrı mı, bitişik mi

| Yapı | Kural | Örnek |
|---|---|---|
| Bağlaç `da/de` | **Ayrı**, kesmesiz, asla `ta/te` olmaz | `Ayşe de geldi`, `ya da` |
| Bulunma eki `-da/-de/-ta/-te` | **Bitişik** | `yolda`, `işte`, `sitede` |
| Bağlaç `ki` | **Ayrı** | `demek ki`, `kaldı ki` |
| Kalıplaşmış `ki` | **Bitişik** | `belki`, `çünkü`, `hâlbuki`, `sanki`, `oysaki`, `mademki` |
| Soru eki `mı/mi/mu/mü` | **Ayrı**, sonraki ek ona bitişir | `Kaldı mı?`, `Verecek misin?`, `Silinsin mi?` |
| `ile` | Ayrı ya da bitişik | `bulut ile` / `bulutla`, `çevre-y-le` |
| Ek fiil `idi/imiş/ise/iken` | Ayrı ya da bitişik | `yorgundu`, `gelirse`, `okuldayken` |
| Deyimler | **Ayrı** | `göz atmak`, `kulak vermek` |
| İkilemeler | **Ayrı**, tiresiz | `adım adım`, `yavaş yavaş`, `el ele` |
| Pekiştirmeli sözler | **Bitişik** | `bembeyaz`, `kupkuru`, `dümdüz` |
| `etmek/olmak` ile kurulanlar | Ses değişmiyorsa **ayrı** | `kabul etmek`, `var olmak` — ama `kaybolmak`, `emretmek` |

`da/de` ayrımı arayüzde sık karışır: *"Bu sayfada da görünür"* (bağlaç, ayrı) / *"Bu sayfada görünür"* (ek, bitişik).

---

## 6. Sayılar, simgeler, birimler

- Saat, para, ölçü, istatistik **rakamla**: `17.30`, `%25`, `5 MB`
- Yüzde ve binde işaretinden sonra boşluk yok: `%25` ✅ / `% 25` ✗
- Sıra sayısı: `15.` ya da `15'inci` — ikisi birden değil (`15'nci` ✗)
- Dört ve daha çok basamaklı sayılar üçerli gruplanır: `1.000`, `326.197`
- Üleştirme sayıları **yazıyla**: `ikişer` ✅ / `2'şer` ✗
- Birim simgelerinden sonra nokta konmaz: `5 cm`, `10 kg`
- Ek, simgeye değil sözcüğün okunuşuna göre gelir: `5 MB'a` değil, mümkünse `5 MB boyutunda`

---

## 7. Noktalama

- Noktalama işaretleri kendinden önceki sözcüğe **bitişik**, sonrasında bir boşluk
- Üç nokta tek karakterdir: `…` (üç ayrı nokta değil)
- `ve` bağlacından önce virgül konmaz
- Tırnak içindeki cümlenin noktalaması tırnağın **içinde** kalır
- İngilizce tırnak `"` yerine Türkçe metinde `"…"` tercih edilir — **ama arayüz dizelerinde kaynaktaki karakteri koru**, HTML ve JSON bozulabilir

**Kaynaktaki noktalamayı koru.** Kaynak `Save changes` ise çeviri `Değişiklikleri kaydet` olur, `Değişiklikleri kaydet.` değil. Kaynak nokta ile bitiyorsa çeviri de bitmeli.

---

## 8. Alıntı sözcükler ve yabancı adlar

- Yerleşmiş alıntılar Türkçe yazımla: `program`, `proje`, `spor`, `tren`, `elektrik`, `paragraf`
- Latin alfabesi kullanan dillerden özel adlar **özgün yazımıyla**: `WordPress`, `WooCommerce`, `Gutenberg`, `New York`
- Yerleşmiş biçimi olanlar Türkçe yazımla: `Londra`, `Atina`, `Napolyon`
- Terim tercihleri sözlükte tutulur; rehber değil sözlük belirler. Genel eğilim: yerleşmiş Türkçe karşılık varsa o kullanılır (`e-posta`, `bağlantı`, `eklenti`, `tema`), yoksa özgün terim korunur (`plugin` değil `eklenti`; ama `widget`, `blok` gibi yerleşmişlerde sözlüğe bak).

---

## 9. Düzeltme işareti (şapka)

- Anlam ayırmak için: `hala` (teyze) / `hâlâ` (henüz), `adem` / `âdem`
- `g`, `k`, `l` ince okunuyorsa: `kâğıt`, `dergâh`, `Elâzığ`
- Nispet eki `-î`: `millî`, `resmî`, `dinî` — `dini` (onun dini) ile karışmasın

Uzun ünlüler bunun dışında **işaretlenmez**: `adalet`, `şair`, `numune`.

---

## 10. Arayüz metni türüne göre

| Tür | Biçim | Örnek |
|---|---|---|
| Düğme | Emir kipi, cümle düzeni, nokta yok | `Kaydet`, `Yeni yazı ekle` |
| Menü / sekme | Ad öbeği, cümle düzeni | `Ekran seçenekleri` |
| Başlık | Cümle düzeni | `Yorum ayarları` |
| Onay sorusu | Soru, `mi` ayrı | `Bu yazı silinsin mi?` |
| Bilgi mesajı | Tam cümle, nokta ile | `Değişiklikleriniz kaydedildi.` |
| Hata mesajı | Ne olduğunu ve ne yapılacağını söyle | `Dosya yüklenemedi. Boyutu 2 MB'ı aşıyor.` |
| Alan etiketi | Kısa ad öbeği, iki nokta yok | `E-posta adresi` |
| Yer tutucu metin | Örnek değer | `ornek@site.com` |

**Uzun metinler (paragraf, e-posta gövdesi).** Cümle cümle çevir, İngilizce cümle sınırlarını koru. Satır sonları (`\n`), boş satırlar ve HTML yapısı kaynaktaki gibi kalmalı — bunlar boşluk değil, biçimdir.

**Siz/sen.** WordPress Türkçe çevirilerinde kullanıcıya **siz** diye hitap edilir, ama edilgen ve emir yapıları yüzünden çoğu dizede hitap hiç geçmez. Gereksiz yere özne ekleme: `Değişiklikleriniz kaydedildi.` ✅ / `Siz değişikliklerinizi kaydettiniz.` ✗

---

## Açık maddeler

Aşağıdakiler henüz karara bağlanmadı; sahibi doldurur:

- Terim tercihleri tablosu (sözlükte tutulacak, burada değil)
- Etiket bazlı ek kurallar (e-ticaret, form, SEO…) ayrı dosyalarda
