<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue';
import {
  bulkDeleteEntries,
  createEntry,
  deleteEntry,
  entryDetail,
  searchGlossary,
  updateEntry,
  type EntrySource,
  type GlossaryEntry,
} from './api.ts';
import Pager from './Pager.vue';
import Legend from './Legend.vue';
import Reveal from './Reveal.vue';

const PAGE = 100;

const rows = ref<GlossaryEntry[]>([]);
const total = ref(0);
const search = ref('');
const posFilter = ref('');
const originFilter = ref<'' | 'trusted' | 'owner'>('');
const caseSensitive = ref(false);
const scope = ref<'' | 'source' | 'translation'>('');
const revealSpaces = ref(true);
const page = ref(0);
const loading = ref(false);
const saving = ref(false);

const selectedIds = ref<Set<number>>(new Set());

const selected = ref<GlossaryEntry | null>(null);
const vouchers = ref<EntrySource[]>([]);
const contexts = ref<string[]>([]);
const draft = ref('');
const draftPlural = ref('');
const draftPos = ref('');
const draftNote = ref('');
const notice = ref('');

/** The form for adding an entry */
const adding = ref(false);
const fresh = ref({
  sourceText: '',
  sourcePlural: '',
  translation: '',
  translationPlural: '',
  pos: 'noun',
  note: '',
});

/**
 * Which request is the current one, so a reply arriving after a newer request
 * cannot paint an older page over it.
 */
let ticket = 0;

async function load(): Promise<void> {
  const mine = (ticket += 1);
  loading.value = true;
  try {
    const params: Record<string, string> = {
      kind: 'term',
      limit: String(PAGE),
      offset: String(page.value * PAGE),
    };
    if (search.value.trim()) params.q = search.value.trim();
    if (posFilter.value) params.pos = posFilter.value;
    if (originFilter.value) params.origin = originFilter.value;
    if (caseSensitive.value) params.case = '1';
    if (scope.value) params.in = scope.value;

    const result = await searchGlossary(params);
    if (mine !== ticket) return;

    rows.value = result.rows;
    total.value = result.total;
    await nextTick();
  } catch (err) {
    notice.value = 'Arama başarısız: ' + String(err);
  } finally {
    if (mine === ticket) loading.value = false;
  }
}

const isAllOnPageSelected = computed(
  () => rows.value.length > 0 && rows.value.every((r) => selectedIds.value.has(r.id)),
);

function toggleSelectAll(): void {
  if (isAllOnPageSelected.value) {
    for (const r of rows.value) selectedIds.value.delete(r.id);
  } else {
    for (const r of rows.value) selectedIds.value.add(r.id);
  }
}

function toggleSelect(id: number): void {
  if (selectedIds.value.has(id)) {
    selectedIds.value.delete(id);
  } else {
    selectedIds.value.add(id);
  }
}

async function bulkDelete(): Promise<void> {
  const count = selectedIds.value.size;
  if (count === 0) return;
  if (!confirm(`Seçilen ${count} terim kalıcı olarak silinsin mi?`)) return;

  try {
    const { removed } = await bulkDeleteEntries(Array.from(selectedIds.value));
    if (selected.value && selectedIds.value.has(selected.value.id)) {
      selected.value = null;
    }
    selectedIds.value.clear();
    await load();
    notice.value = `${removed} terim silindi.`;
  } catch (err) {
    alert('Toplu silme başarısız: ' + String(err));
  }
}

function goTo(next: number): void {
  if (loading.value) return;
  selectedIds.value.clear();
  page.value = next;
}

async function select(entry: GlossaryEntry): Promise<void> {
  adding.value = false;
  selected.value = entry;
  draft.value = entry.translation;
  draftPlural.value = entry.translationPlural ?? '';
  draftPos.value = entry.pos ?? 'noun';
  draftNote.value = entry.note ?? '';
  notice.value = '';
  vouchers.value = [];
  contexts.value = [];
  if (entry.sources > 0 || entry.contexts > 0) {
    const detail = await entryDetail(entry.id);
    vouchers.value = detail.sources;
    contexts.value = detail.contexts;
  }
}

async function save(): Promise<void> {
  if (!selected.value) return;
  saving.value = true;
  try {
    const { entry } = await updateEntry(
      selected.value.id,
      draft.value,
      selected.value.sourcePlural === null ? undefined : draftPlural.value,
      draftNote.value.trim() || undefined,
      draftPos.value.trim() || undefined,
    );

    const index = rows.value.findIndex((row) => row.id === entry.id);
    if (index >= 0) rows.value[index] = entry;
    selected.value = entry;
    draftPlural.value = entry.translationPlural ?? '';
    draftPos.value = entry.pos ?? 'noun';
    draftNote.value = entry.note ?? '';

    notice.value = 'Kaydedildi.';
  } catch (err) {
    notice.value = 'Hata: ' + String(err);
  } finally {
    saving.value = false;
  }
}

function applyFilters(): void {
  selectedIds.value.clear();
  page.value = 0;
  void load();
}

function openForm(): void {
  selected.value = null;
  notice.value = '';
  fresh.value = {
    sourceText: '',
    sourcePlural: '',
    translation: '',
    translationPlural: '',
    pos: 'noun',
    note: '',
  };
  adding.value = true;
}

async function add(): Promise<void> {
  const plural = fresh.value.sourcePlural.trim();

  try {
    const entry = await createEntry({
      sourceText: fresh.value.sourceText,
      ...(plural
        ? { sourcePlural: plural, translationPlural: fresh.value.translationPlural }
        : {}),
      translation: fresh.value.translation,
      pos: fresh.value.pos.trim() || 'noun',
      note: fresh.value.note.trim() || undefined,
    });

    adding.value = false;
    await load();
    await select(entry);
  } catch (err) {
    alert('Terim eklenemedi: ' + String(err));
  }
}

async function removeRow(entry: GlossaryEntry): Promise<void> {
  if (!confirm(`"${entry.sourceText}" → "${entry.translation}" terimi silinsin mi?`)) return;

  try {
    await deleteEntry(entry.id);
    if (selected.value?.id === entry.id) {
      selected.value = null;
    }
    selectedIds.value.delete(entry.id);
    await load();
    notice.value = 'Terim silindi.';
  } catch (err) {
    alert('Terim silinemedi: ' + String(err));
  }
}

function formatPos(pos: string | null): string {
  if (!pos) return 'Genel';
  const map: Record<string, string> = {
    noun: 'İsim (noun)',
    verb: 'Fiil (verb)',
    adjective: 'Sıfat (adj)',
    adverb: 'Zarf (adv)',
    pronoun: 'Zamir (pron)',
    preposition: 'Edat (prep)',
    expression: 'Deyim (expr)',
    abbreviation: 'Kısaltma (abbr)',
  };
  return map[pos] ?? pos;
}

onMounted(async () => {
  await load();
});

watch(page, load);
</script>

<template>
  <div class="page-layout">
    <div class="page-header">
      <div>
        <h1 class="page-title">Sözlük</h1>
        <p class="page-desc">
          WordPress Türkiye resmî global sözlüğü ve kişisel terim kayıtlarınız. Tüm kelimeleri serbestçe düzenleyebilir, tekli veya toplu silebilirsiniz.
        </p>
      </div>
      <button class="btn primary" @click="openForm">
        + Yeni Terim Ekle
      </button>
    </div>

    <!-- Filter & Search Deck -->
    <div class="filter-card">
      <div class="search-box" style="flex: 1.5;">
        <span class="search-icon">🔍</span>
        <input
          v-model="search"
          class="search-input"
          placeholder="İngilizce veya Türkçe terim ara..."
          @keyup.enter="applyFilters"
        />
      </div>

      <select v-model="scope" class="btn" aria-label="Arama Alanı" @change="applyFilters">
        <option value="">Kaynak + Çeviri</option>
        <option value="source">Yalnızca Kaynak</option>
        <option value="translation">Yalnızca Çeviri</option>
      </select>

      <select v-model="posFilter" class="btn" aria-label="Kelime Türü" @change="applyFilters">
        <option value="">Tüm Kelime Türleri</option>
        <option value="noun">İsim (Noun)</option>
        <option value="verb">Fiil (Verb)</option>
        <option value="adjective">Sıfat (Adjective)</option>
        <option value="adverb">Zarf (Adverb)</option>
        <option value="expression">Deyim / İfade (Expression)</option>
        <option value="abbreviation">Kısaltma (Abbreviation)</option>
        <option value="pronoun">Zamir (Pronoun)</option>
        <option value="preposition">Edat (Preposition)</option>
      </select>

      <select v-model="originFilter" class="btn" aria-label="Menşei" @change="applyFilters">
        <option value="">Menşei: Tümü</option>
        <option value="trusted">🔒 Resmî Sözlük (wp.org)</option>
        <option value="owner">✏️ Kişisel Terimler</option>
      </select>

      <label class="filter-check" title="Kapalıyken İ/ı/I/i aynı sayılır ve büyük-küçük harf gözetilmez">
        <input v-model="caseSensitive" type="checkbox" @change="applyFilters" />
        Harf duyarlı
      </label>

      <label class="filter-check" title="Boşluk ve satır sonu gibi görünmez karakterleri renklendirir">
        <input v-model="revealSpaces" type="checkbox" />
        Boşlukları Vurgula
      </label>

      <button class="btn primary" @click="applyFilters">Ara</button>
    </div>

    <!-- Bulk Actions Toolbar -->
    <div v-if="selectedIds.size > 0" class="bulk-toolbar">
      <span class="bulk-count">{{ selectedIds.size }} terim seçildi</span>
      <button class="btn danger-btn" @click="bulkDelete">
        🗑️ Seçilenleri Sil ({{ selectedIds.size }})
      </button>
      <button class="btn link-btn" style="margin-left: 8px;" @click="selectedIds.clear()">
        Seçimi Temizle
      </button>
    </div>

    <!-- Pager & Legend -->
    <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;">
      <Pager :page="page" :total="total" :page-size="PAGE" :busy="loading" @go="goTo" />
      <Legend />
    </div>

    <p v-if="notice && !selected" class="notice-strip">{{ notice }}</p>

    <!-- Split: Data Table & Right Inspector -->
    <div class="glossary-split">
      <div class="data-table-container table-wrapper">
        <table class="data-table">
          <thead>
            <tr>
              <th style="width: 38px; text-align: center;">
                <input
                  type="checkbox"
                  aria-label="Tümünü seç"
                  :checked="isAllOnPageSelected"
                  @change="toggleSelectAll"
                />
              </th>
              <th style="min-width: 170px;">İngilizce Kaynak</th>
              <th style="min-width: 170px;">Türkçe Karşılık</th>
              <th style="width: 140px;">Kelime Türü</th>
              <th style="min-width: 150px;">Açıklama / Not</th>
              <th style="text-align: center; width: 100px;">İşlemler</th>
            </tr>
          </thead>
          <tbody>
            <tr v-if="rows.length === 0">
              <td colspan="6" style="text-align: center; padding: 36px; color: var(--text-muted);">
                {{ loading ? 'Yükleniyor…' : 'Eşleşen sözlük terimi bulunamadı.' }}
              </td>
            </tr>
            <tr
              v-for="row in rows"
              :key="row.id"
              :class="{ active: selected?.id === row.id }"
              style="cursor: pointer;"
              @click="select(row)"
            >
              <td style="text-align: center;" @click.stop>
                <input
                  type="checkbox"
                  aria-label="Seç"
                  :checked="selectedIds.has(row.id)"
                  @change="toggleSelect(row.id)"
                />
              </td>
              <td>
                <div style="font-weight: 700; color: #fff;">
                  <Reveal v-if="revealSpaces" :value="row.sourceText" />
                  <span v-else>{{ row.sourceText }}</span>
                </div>
                <div v-if="row.sourcePlural" class="plural-row">
                  <span class="plural-badge">çoğul:</span>
                  <Reveal v-if="revealSpaces" :value="row.sourcePlural" />
                  <span v-else>{{ row.sourcePlural }}</span>
                </div>
              </td>
              <td>
                <div style="font-weight: 600; color: #34d399;">
                  <Reveal v-if="revealSpaces" :value="row.translation" />
                  <span v-else>{{ row.translation }}</span>
                </div>
                <div v-if="row.translationPlural" class="plural-row">
                  <span class="plural-badge">çoğul:</span>
                  <Reveal v-if="revealSpaces" :value="row.translationPlural" />
                  <span v-else>{{ row.translationPlural }}</span>
                </div>
              </td>
              <td>
                <span class="status-pill pos-pill">
                  {{ formatPos(row.pos) }}
                </span>
              </td>
              <td>
                <div v-if="row.note" class="row-note" :title="row.note">
                  {{ row.note }}
                </div>
                <div v-else style="color: var(--text-subtle); font-size: 12px;">—</div>
              </td>
              <td style="text-align: center;" @click.stop>
                <div style="display: flex; gap: 4px; justify-content: center;">
                  <button
                    class="btn"
                    style="padding: 2px 8px; font-size: 11px;"
                    title="Detayları incele ve düzenle"
                    @click="select(row)"
                  >
                    Detay
                  </button>
                  <button
                    class="btn"
                    style="padding: 2px 6px; font-size: 11px; color: #f87171;"
                    title="Terimi sil"
                    @click="removeRow(row)"
                  >
                    🗑️
                  </button>
                </div>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <!-- Right Detail Inspector -->
      <aside v-if="selected" class="inspector-card">
        <div class="inspector-header">
          <div>
            <div class="inspector-badge">
              <span class="status-pill pos-pill">{{ formatPos(selected.pos) }}</span>
              <span v-if="selected.isOfficial" class="origin-tag official" title="WordPress Türkiye resmî sözlüğünden içe aktarılmıştır">
                🔒 Resmî Sözlük (wp.org)
              </span>
              <span v-else class="origin-tag owner" title="Kişisel terim kaydı">
                ✏️ Kişisel Terim
              </span>
            </div>
            <h3 class="inspector-title">
              <Reveal v-if="revealSpaces" :value="selected.sourceText" />
              <span v-else>{{ selected.sourceText }}</span>
            </h3>
          </div>
          <button class="btn close-btn" title="Kapat" @click="selected = null">✕</button>
        </div>

        <!-- Note if present -->
        <div v-if="selected.note" class="inspector-note-box">
          <span style="font-size: 10px; font-weight: 700; text-transform: uppercase; color: var(--text-subtle);">Açıklama / Not:</span>
          <p style="margin: 2px 0 0; font-size: 12px; color: var(--text-default);">{{ selected.note }}</p>
        </div>

        <!-- Translation Edit -->
        <div class="inspector-field">
          <div class="inspector-field-label">
            <span>{{ selected.sourcePlural ? 'Türkçe Çeviri (Tekil)' : 'Türkçe Karşılık' }}</span>
            <button class="link-btn" title="Orijinal kaynak metni çeviri kutusuna kopyalar" @click="draft = selected.sourceText">
              Kaynağı Kopyala
            </button>
          </div>
          <textarea
            v-model="draft"
            class="edit-area"
            rows="3"
            @keydown.ctrl.enter.prevent="save"
          />
        </div>

        <!-- Plural Edit if exists -->
        <div v-if="selected.sourcePlural" class="inspector-field">
          <div class="inspector-field-label">
            <span>Çoğul Kaynak: <b>{{ selected.sourcePlural }}</b></span>
          </div>
          <div class="inspector-field-label" style="margin-top: 4px;">
            <span>Türkçe Çeviri (Çoğul)</span>
          </div>
          <textarea
            v-model="draftPlural"
            class="edit-area"
            rows="3"
            @keydown.ctrl.enter.prevent="save"
          />
        </div>

        <!-- Kelime Türü Edit -->
        <div class="inspector-field">
          <div class="inspector-field-label">
            <span>Kelime Türü</span>
          </div>
          <select v-model="draftPos" class="search-input" style="padding: 6px 10px;">
            <option value="noun">İsim (Noun)</option>
            <option value="verb">Fiil (Verb)</option>
            <option value="adjective">Sıfat (Adjective)</option>
            <option value="adverb">Zarf (Adverb)</option>
            <option value="expression">Deyim / İfade (Expression)</option>
            <option value="abbreviation">Kısaltma (Abbreviation)</option>
            <option value="pronoun">Zamir (Pronoun)</option>
            <option value="preposition">Edat (Preposition)</option>
          </select>
        </div>

        <!-- Note edit -->
        <div class="inspector-field">
          <div class="inspector-field-label">
            <span>Açıklama / Not</span>
          </div>
          <input
            v-model="draftNote"
            class="search-input"
            placeholder="Açıklama notu ekleyin..."
          />
        </div>

        <!-- Actions -->
        <div class="inspector-actions">
          <button
            class="btn primary"
            style="flex: 1; justify-content: center;"
            :disabled="saving"
            @click="save"
          >
            {{ saving ? 'Kaydediliyor…' : 'Kaydet (Ctrl+Enter)' }}
          </button>
          <button
            class="btn"
            style="color: #f87171; border-color: rgba(248, 113, 113, 0.4);"
            title="Bu terimi kalıcı olarak sil"
            @click="removeRow(selected)"
          >
            Sil
          </button>
        </div>

        <p v-if="notice" class="notice-strip">{{ notice }}</p>
      </aside>
    </div>

    <!-- Modal: Yeni Sözlük Terimi Ekle -->
    <div v-if="adding" class="backdrop" @click.self="adding = false">
      <div class="modal" style="max-width: 520px;">
        <div style="display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid var(--border-default); padding-bottom: 10px;">
          <h3 style="margin: 0; color: #fff; font-size: 16px;">Yeni Sözlük Terimi Ekle</h3>
          <button class="btn" style="padding: 2px 8px;" @click="adding = false">✕</button>
        </div>

        <div style="display: flex; flex-direction: column; gap: 12px; margin-top: 14px;">
          <div>
            <label class="form-label">İngilizce Kaynak (Tekil): *</label>
            <textarea
              v-model="fresh.sourceText"
              class="search-input"
              rows="2"
              placeholder="Örn: Checkout"
            />
          </div>

          <div>
            <label class="form-label">İngilizce Kaynak (Çoğul - Varsa):</label>
            <textarea
              v-model="fresh.sourcePlural"
              class="search-input"
              rows="2"
              placeholder="Örn: Checkouts"
            />
          </div>

          <div>
            <label class="form-label">Türkçe Karşılık (Tekil): *</label>
            <textarea
              v-model="fresh.translation"
              class="search-input"
              rows="2"
              placeholder="Örn: Ödeme"
            />
          </div>

          <div v-if="fresh.sourcePlural">
            <label class="form-label">Türkçe Karşılık (Çoğul): *</label>
            <textarea
              v-model="fresh.translationPlural"
              class="search-input"
              rows="2"
              placeholder="Örn: Ödemeler"
            />
          </div>

          <div>
            <label class="form-label">Kelime Türü: *</label>
            <select v-model="fresh.pos" class="search-input" style="padding: 6px 10px;">
              <option value="noun">İsim (Noun)</option>
              <option value="verb">Fiil (Verb)</option>
              <option value="adjective">Sıfat (Adjective)</option>
              <option value="adverb">Zarf (Adverb)</option>
              <option value="expression">Deyim / İfade (Expression)</option>
              <option value="abbreviation">Kısaltma (Abbreviation)</option>
              <option value="pronoun">Zamir (Pronoun)</option>
              <option value="preposition">Edat (Preposition)</option>
            </select>
          </div>

          <div>
            <label class="form-label">Açıklama / Not (Opsiyonel):</label>
            <input
              v-model="fresh.note"
              class="search-input"
              placeholder="Kullanım alanı veya açıklama notu..."
            />
          </div>
        </div>

        <div style="display: flex; justify-content: flex-end; gap: 8px; margin-top: 16px; border-top: 1px solid var(--border-default); padding-top: 12px;">
          <button class="btn" @click="adding = false">İptal</button>
          <button
            class="btn primary"
            :disabled="
              !fresh.sourceText.trim() ||
              !fresh.translation.trim() ||
              (Boolean(fresh.sourcePlural.trim()) !== Boolean(fresh.translationPlural.trim()))
            "
            @click="add"
          >
            Terimi Ekle
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.page-layout {
  display: flex;
  flex-direction: column;
  gap: 12px;
  height: 100%;
}

.page-header {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 16px;
}

.page-title {
  margin: 0;
  font-size: 20px;
  font-weight: 700;
  color: #fff;
}

.page-desc {
  margin: 4px 0 0;
  font-size: 13px;
  color: var(--text-muted);
}

.filter-card {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
  background: var(--bg-surface);
  border: 1px solid var(--border-default);
  border-radius: 6px;
  padding: 10px 12px;
}

.bulk-toolbar {
  display: flex;
  align-items: center;
  gap: 10px;
  background: rgba(239, 68, 68, 0.08);
  border: 1px solid rgba(239, 68, 68, 0.3);
  border-radius: 6px;
  padding: 8px 14px;
}

.bulk-count {
  font-size: 13px;
  font-weight: 700;
  color: #f87171;
}

.danger-btn {
  background: #dc2626 !important;
  color: #fff !important;
  border-color: #b91c1c !important;
  padding: 4px 12px;
  font-size: 12px;
  font-weight: 600;
}

.danger-btn:hover {
  background: #b91c1c !important;
}

.search-box {
  display: flex;
  align-items: center;
  position: relative;
  min-width: 220px;
}

.search-icon {
  position: absolute;
  left: 10px;
  font-size: 13px;
  pointer-events: none;
  opacity: 0.6;
}

.search-input {
  width: 100%;
  background: var(--bg-canvas);
  border: 1px solid var(--border-default);
  color: var(--text-default);
  border-radius: 4px;
  padding: 6px 10px 6px 30px;
  font-size: 13px;
  font-family: inherit;
}

.search-input:focus {
  outline: none;
  border-color: #3b82f6;
}

.filter-check {
  display: flex;
  align-items: center;
  gap: 5px;
  font-size: 12px;
  color: var(--text-muted);
  cursor: pointer;
  user-select: none;
}

.glossary-split {
  display: flex;
  gap: 14px;
  flex: 1;
  min-height: 0;
  overflow: hidden;
}

.table-wrapper {
  flex: 1;
  min-width: 0;
  overflow-y: auto;
  border: 1px solid var(--border-default);
  border-radius: 6px;
  background: var(--bg-surface);
}

.data-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
}

.data-table th {
  position: sticky;
  top: 0;
  background: var(--bg-surface-raised);
  border-bottom: 1px solid var(--border-default);
  padding: 8px 12px;
  text-align: left;
  font-size: 11px;
  font-weight: 700;
  text-transform: uppercase;
  color: var(--text-muted);
  z-index: 1;
}

.data-table td {
  padding: 8px 12px;
  border-bottom: 1px solid var(--border-subtle);
  vertical-align: middle;
}

.data-table tr:hover {
  background: rgba(255, 255, 255, 0.02);
}

.data-table tr.active {
  background: rgba(59, 130, 246, 0.08);
}

.plural-row {
  margin-top: 3px;
  font-size: 12px;
  color: var(--text-muted);
  display: flex;
  align-items: center;
  gap: 4px;
}

.plural-badge {
  font-size: 10px;
  text-transform: uppercase;
  font-weight: 700;
  color: var(--text-subtle);
}

.row-note {
  font-size: 12px;
  color: var(--text-muted);
  white-space: pre-wrap;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.status-pill {
  display: inline-block;
  font-size: 11px;
  font-weight: 600;
  padding: 2px 7px;
  border-radius: 10px;
  background: var(--bg-surface-raised);
  color: var(--text-muted);
}

.status-pill.pos-pill {
  background: rgba(168, 85, 247, 0.15);
  color: #c084fc;
}

.origin-tag {
  display: inline-block;
  font-size: 11px;
  padding: 1px 6px;
  border-radius: 4px;
  font-weight: 600;
}

.origin-tag.official {
  background: rgba(59, 130, 246, 0.15);
  color: #60a5fa;
}

.origin-tag.owner {
  background: rgba(16, 185, 129, 0.15);
  color: #34d399;
}

.inspector-card {
  width: 380px;
  background: var(--bg-surface);
  border: 1px solid var(--border-default);
  border-radius: 6px;
  padding: 16px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.inspector-header {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 8px;
}

.inspector-badge {
  display: flex;
  gap: 6px;
  margin-bottom: 6px;
}

.inspector-title {
  margin: 0;
  font-size: 16px;
  font-weight: 700;
  color: #fff;
  word-break: break-word;
}

.inspector-field {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.inspector-field-label {
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-size: 11px;
  font-weight: 700;
  text-transform: uppercase;
  color: var(--text-muted);
}

.edit-area {
  width: 100%;
  background: var(--bg-canvas);
  border: 1px solid var(--border-default);
  border-radius: 4px;
  padding: 8px 10px;
  font-size: 13px;
  color: #fff;
  font-family: inherit;
  resize: vertical;
}

.edit-area:focus {
  outline: none;
  border-color: #3b82f6;
}

.inspector-note-box {
  background: var(--bg-canvas);
  border: 1px solid var(--border-subtle);
  border-radius: 4px;
  padding: 8px 10px;
}

.inspector-actions {
  display: flex;
  gap: 8px;
  margin-top: 4px;
}

.link-btn {
  background: none;
  border: none;
  color: #60a5fa;
  font-size: 11px;
  cursor: pointer;
  padding: 0;
}

.link-btn:hover {
  text-decoration: underline;
}

.form-label {
  display: block;
  font-size: 11px;
  font-weight: 700;
  color: var(--text-muted);
  text-transform: uppercase;
  margin-bottom: 4px;
}

.backdrop {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.7);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
}

.modal {
  background: var(--bg-surface);
  border: 1px solid var(--border-default);
  border-radius: 8px;
  padding: 20px;
  width: 100%;
  box-shadow: 0 10px 25px rgba(0, 0, 0, 0.5);
}

.notice-strip {
  margin: 0;
  padding: 8px 12px;
  background: rgba(59, 130, 246, 0.1);
  border: 1px solid rgba(59, 130, 246, 0.3);
  border-radius: 4px;
  color: #60a5fa;
  font-size: 13px;
}
</style>
