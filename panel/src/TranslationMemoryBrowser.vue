<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue';
import {
  copyMemoryToTerms,
  entryDetail,
  listTags,
  searchGlossary,
  type EntrySource,
  type GlossaryEntry,
  type Tag,
} from './api.ts';
import Pager from './Pager.vue';
import Legend from './Legend.vue';
import Reveal from './Reveal.vue';

const PAGE = 100;

const rows = ref<GlossaryEntry[]>([]);
const total = ref(0);
const tags = ref<Tag[]>([]);
const search = ref('');
const tagId = ref('');
const contested = ref(false);
const caseSensitive = ref(false);
const scope = ref<'' | 'source' | 'translation'>('');
const revealSpaces = ref(true);
const page = ref(0);
const loading = ref(false);

const selectedIds = ref<Set<number>>(new Set());
const bulkPos = ref('auto');
const singlePos = ref('auto');
const copying = ref(false);

const selected = ref<GlossaryEntry | null>(null);
const vouchers = ref<EntrySource[]>([]);
const contexts = ref<string[]>([]);
const notice = ref('');

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
      kind: 'memory',
      limit: String(PAGE),
      offset: String(page.value * PAGE),
    };
    if (search.value.trim()) params.q = search.value.trim();
    if (tagId.value) params.tag = tagId.value;
    if (contested.value) params.contested = '1';
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

function goTo(next: number): void {
  if (loading.value) return;
  selectedIds.value.clear();
  page.value = next;
}

async function select(entry: GlossaryEntry): Promise<void> {
  selected.value = entry;
  singlePos.value = 'auto';
  notice.value = '';
  vouchers.value = [];
  contexts.value = [];
  if (entry.sources > 0 || entry.contexts > 0) {
    const detail = await entryDetail(entry.id);
    vouchers.value = detail.sources;
    contexts.value = detail.contexts;
  }
}

function applyFilters(): void {
  selectedIds.value.clear();
  page.value = 0;
  void load();
}

async function addSingleToGlossary(entry: GlossaryEntry, pos = 'auto'): Promise<void> {
  copying.value = true;
  try {
    const res = await copyMemoryToTerms([entry.id], pos);
    if (res.added > 0) {
      const assigned = res.entries[0]?.pos ?? 'noun';
      notice.value = `"${entry.sourceText}" (${formatPos(assigned)}) olarak sözlüğe eklendi.`;
    } else if (res.skipped > 0) {
      notice.value = `"${entry.sourceText}" sözlükte zaten mevcut olduğu için korunarak atlandı.`;
    }
  } catch (err) {
    alert('Sözlüğe ekleme başarısız: ' + String(err));
  } finally {
    copying.value = false;
  }
}

async function addBulkToGlossary(): Promise<void> {
  const ids = Array.from(selectedIds.value);
  if (ids.length === 0) return;

  copying.value = true;
  try {
    const res = await copyMemoryToTerms(ids, bulkPos.value);
    selectedIds.value.clear();
    notice.value = `${res.added} terim sözlüğe eklendi${res.skipped > 0 ? ` (${res.skipped} terim zaten mevcuttu, korunarak atlandı)` : ''}.`;
  } catch (err) {
    alert('Toplu sözlüğe aktarma başarısız: ' + String(err));
  } finally {
    copying.value = false;
  }
}

function formatPos(pos: string): string {
  const map: Record<string, string> = {
    auto: 'Otomatik',
    noun: 'İsim (noun)',
    verb: 'Fiil (verb)',
    adjective: 'Sıfat (adj)',
    adverb: 'Zarf (adv)',
    expression: 'Deyim (expr)',
    abbreviation: 'Kısaltma (abbr)',
    pronoun: 'Zamir (pron)',
    preposition: 'Edat (prep)',
  };
  return map[pos] ?? pos;
}

onMounted(async () => {
  tags.value = await listTags();
  await load();
});

watch(page, load);
</script>

<template>
  <div class="page-layout">
    <div class="page-header">
      <div>
        <h1 class="page-title">Terim Bankası</h1>
        <p class="page-desc">
          Güvenilir kaynaklara ait taranmış çeviri çiftleri ve bellek girdileri. Seçtiğiniz girdileri tekli veya toplu olarak Sözlüğe kopyalayabilirsiniz (mevcut terimlerin üzerine yazılmaz).
        </p>
      </div>
    </div>

    <!-- Filter & Search Deck -->
    <div class="filter-card">
      <div class="search-box" style="flex: 1.5;">
        <span class="search-icon">🔍</span>
        <input
          v-model="search"
          class="search-input"
          placeholder="Kaynak metin veya çeviride ara..."
          @keyup.enter="applyFilters"
        />
      </div>

      <select v-model="scope" class="btn" aria-label="Arama Alanı" @change="applyFilters">
        <option value="">Kaynak + Çeviri</option>
        <option value="source">Yalnızca Kaynak</option>
        <option value="translation">Yalnızca Çeviri</option>
      </select>

      <select v-model="tagId" class="btn" aria-label="Etiket" @change="applyFilters">
        <option value="">Tüm Etiketler</option>
        <option v-for="tag in tags" :key="tag.id" :value="String(tag.id)">
          {{ tag.name }} ({{ tag.entries.toLocaleString('tr') }})
        </option>
      </select>

      <label class="filter-check" title="Kapalıyken İ/ı/I/i aynı sayılır ve büyük-küçük harf gözetilmez">
        <input v-model="caseSensitive" type="checkbox" @change="applyFilters" />
        Harf duyarlı
      </label>

      <label class="filter-check" title="Birden fazla kaynak tarafından farklı çevrilenler">
        <input v-model="contested" type="checkbox" @change="applyFilters" />
        Çelişenler
      </label>

      <label class="filter-check" title="Boşluk ve satır sonu gibi görünmez karakterleri renklendirir">
        <input v-model="revealSpaces" type="checkbox" />
        Boşlukları Vurgula
      </label>

      <button class="btn primary" @click="applyFilters">Ara</button>
    </div>

    <!-- Bulk Actions Toolbar -->
    <div v-if="selectedIds.size > 0" class="bulk-toolbar">
      <span class="bulk-count">{{ selectedIds.size }} bellek girdisi seçildi</span>
      <div style="display: flex; align-items: center; gap: 6px;">
        <span style="font-size: 11px; font-weight: 700; color: var(--text-muted); text-transform: uppercase;">Hedef Kelime Türü:</span>
        <select v-model="bulkPos" class="btn" style="padding: 4px 8px; font-size: 12px;">
          <option value="auto">✨ Otomatik Belirle (Akıllı Tahmin)</option>
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
      <button class="btn primary" :disabled="copying" @click="addBulkToGlossary">
        📖 Seçilenleri Sözlüğe Ekle ({{ selectedIds.size }})
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
              <th style="width: 110px;">Etiket</th>
              <th style="width: 130px;">Güvenilir Kaynak</th>
              <th style="min-width: 120px;">Açıklama / Not</th>
              <th style="text-align: center; width: 140px;">İşlemler</th>
            </tr>
          </thead>
          <tbody>
            <tr v-if="rows.length === 0">
              <td colspan="7" style="text-align: center; padding: 36px; color: var(--text-muted);">
                {{ loading ? 'Yükleniyor…' : 'Eşleşen terim bankası girdisi bulunamadı.' }}
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
                <div v-if="row.msgctxt" style="font-size: 11px; color: var(--text-subtle); margin-top: 2px;">
                  <code>ctx: {{ row.msgctxt }}</code>
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
                <span class="status-pill ok">{{ row.tag }}</span>
              </td>
              <td>
                <span v-if="row.sources > 0" class="origin-tag trusted" :title="`${row.sources} güvenilir kaynak tarafından doğrulanmış`">
                  🔒 Güvenilir ({{ row.sources }})
                </span>
                <span v-else class="origin-tag owner" title="Kullanıcı belleği">
                  ✏️ Bellek
                </span>
                <span v-if="row.readings > 1" class="origin-tag contested" style="margin-left: 4px;" title="Bu kaynak için başka çeviriler de mevcut">
                  ⚠️ {{ row.readings }} seçenek
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
                    title="Detayları incele"
                    @click="select(row)"
                  >
                    Detay
                  </button>
                  <button
                    class="btn primary"
                    style="padding: 2px 8px; font-size: 11px;"
                    title="Bu girdiyi otomatik kelime türüyle sözlüğe kopyalar (eskileri ezmez)"
                    :disabled="copying"
                    @click="addSingleToGlossary(row, 'auto')"
                  >
                    + Sözlük
                  </button>
                </div>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <!-- Right Detail Inspector (Read-Only) -->
      <aside v-if="selected" class="inspector-card">
        <div class="inspector-header">
          <div>
            <div class="inspector-badge">
              <span class="status-pill memory-pill">Çeviri Belleği</span>
              <span class="status-pill ok">{{ selected.tag }}</span>
              <span v-if="selected.sources > 0" class="origin-tag trusted">🔒 {{ selected.sources }} Kaynak</span>
            </div>
            <h3 class="inspector-title">
              <Reveal v-if="revealSpaces" :value="selected.sourceText" />
              <span v-else>{{ selected.sourceText }}</span>
            </h3>
          </div>
          <button class="btn close-btn" title="Kapat" @click="selected = null">✕</button>
        </div>

        <!-- Turkish Translation View -->
        <div class="inspector-section" style="margin-top: 12px;">
          <div class="inspector-field-label">
            <span>{{ selected.sourcePlural ? 'Türkçe Çeviri (Tekil)' : 'Türkçe Karşılık' }}</span>
          </div>
          <div class="readonly-value">
            <Reveal v-if="revealSpaces" :value="selected.translation" />
            <span v-else>{{ selected.translation }}</span>
          </div>
        </div>

        <!-- Plural View if exists -->
        <div v-if="selected.sourcePlural" class="inspector-section">
          <div class="inspector-field-label">
            <span>Çoğul Kaynak: <b>{{ selected.sourcePlural }}</b></span>
          </div>
          <div class="inspector-field-label" style="margin-top: 6px;">
            <span>Türkçe Çeviri (Çoğul)</span>
          </div>
          <div class="readonly-value">
            <Reveal v-if="revealSpaces" :value="selected.translationPlural ?? ''" />
            <span v-else>{{ selected.translationPlural }}</span>
          </div>
        </div>

        <!-- Note if present -->
        <div v-if="selected.note" class="inspector-note-box">
          <span style="font-size: 10px; font-weight: 700; text-transform: uppercase; color: var(--text-subtle);">Açıklama / Not:</span>
          <p style="margin: 2px 0 0; font-size: 12px; color: var(--text-default);">{{ selected.note }}</p>
        </div>

        <!-- Sözlüğe Ekle Box -->
        <div class="add-to-glossary-box">
          <div style="font-size: 11px; font-weight: 700; text-transform: uppercase; color: #60a5fa; margin-bottom: 6px;">
            📖 Sözlüğe Aktar
          </div>
          <div style="display: flex; gap: 8px; align-items: center; margin-bottom: 8px;">
            <label style="font-size: 11px; color: var(--text-muted);">Kelime Türü:</label>
            <select v-model="singlePos" class="search-input" style="padding: 4px 8px; font-size: 12px; flex: 1;">
              <option value="auto">✨ Otomatik Belirle (Akıllı Tahmin)</option>
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
          <button
            class="btn primary"
            style="width: 100%; justify-content: center;"
            :disabled="copying"
            @click="addSingleToGlossary(selected, singlePos)"
          >
            {{ copying ? 'Aktarılıyor…' : 'Bu Girdiyi Sözlüğe Ekle' }}
          </button>
          <div style="font-size: 11px; color: var(--text-subtle); margin-top: 6px; line-height: 1.3;">
            * Kelime türü otomatik belirlenir. Gerekirse daha sonra Sözlük ekranından dilediğiniz gibi düzeltebilirsiniz. Var olan terimlerin üzerine yazılmaz.
          </div>
        </div>

        <p v-if="notice" class="notice-strip">{{ notice }}</p>

        <!-- Supporting Vouchers -->
        <div v-if="vouchers.length > 0" class="inspector-section" style="margin-top: 16px;">
          <h4 class="inspector-section-title">Destekleyen Güvenilir Kaynaklar ({{ vouchers.length }})</h4>
          <ul class="vouchers-list">
            <li v-for="voucher in vouchers" :key="voucher.projectPath" class="voucher-item">
              <div style="font-weight: 600; color: #fff;">
                {{ voucher.rank }}. {{ voucher.label ?? voucher.projectPath }}
              </div>
              <div :class="{ differs: voucher.translation !== selected.translation }" style="font-size: 12px; color: #34d399;">
                {{ voucher.translation }}
              </div>
            </li>
          </ul>
        </div>

        <!-- Contexts -->
        <div v-if="contexts.length > 0" class="inspector-section" style="margin-top: 16px;">
          <h4 class="inspector-section-title">Geçtiği Bağlamlar ({{ contexts.length }})</h4>
          <div class="contexts-wrap">
            <code v-for="ctx in contexts" :key="ctx" class="context-pill">{{ ctx }}</code>
          </div>
        </div>
      </aside>
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
  flex-wrap: wrap;
  gap: 10px;
  background: rgba(59, 130, 246, 0.08);
  border: 1px solid rgba(59, 130, 246, 0.3);
  border-radius: 6px;
  padding: 8px 14px;
}

.bulk-count {
  font-size: 13px;
  font-weight: 700;
  color: #60a5fa;
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

.status-pill.ok {
  background: rgba(16, 185, 129, 0.15);
  color: #34d399;
}

.status-pill.memory-pill {
  background: rgba(148, 163, 184, 0.15);
  color: #94a3b8;
}

.origin-tag {
  display: inline-block;
  font-size: 11px;
  padding: 1px 6px;
  border-radius: 4px;
  font-weight: 600;
}

.origin-tag.trusted {
  background: rgba(59, 130, 246, 0.15);
  color: #60a5fa;
}

.origin-tag.owner {
  background: rgba(245, 158, 11, 0.15);
  color: #fbbf24;
}

.origin-tag.contested {
  background: rgba(239, 68, 68, 0.15);
  color: #f87171;
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

.readonly-value {
  padding: 8px 10px;
  background: var(--bg-canvas);
  border: 1px solid var(--border-default);
  border-radius: 4px;
  font-weight: 600;
  color: #34d399;
  font-size: 13px;
  line-height: 1.5;
  white-space: pre-wrap;
  word-break: break-word;
}

.inspector-field-label {
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-size: 11px;
  font-weight: 700;
  text-transform: uppercase;
  color: var(--text-muted);
  margin-bottom: 4px;
}

.inspector-note-box {
  background: var(--bg-canvas);
  border: 1px solid var(--border-subtle);
  border-radius: 4px;
  padding: 8px 10px;
}

.add-to-glossary-box {
  background: rgba(59, 130, 246, 0.08);
  border: 1px solid rgba(59, 130, 246, 0.25);
  border-radius: 6px;
  padding: 12px;
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

.inspector-section-title {
  margin: 0 0 6px;
  font-size: 11px;
  font-weight: 700;
  text-transform: uppercase;
  color: var(--text-muted);
}

.vouchers-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.voucher-item {
  padding: 6px 8px;
  background: var(--bg-canvas);
  border: 1px solid var(--border-subtle);
  border-radius: 4px;
  font-size: 12px;
}

.voucher-item .differs {
  color: #f87171 !important;
}

.contexts-wrap {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}

.context-pill {
  font-size: 11px;
  padding: 2px 6px;
  background: var(--bg-canvas);
  border: 1px solid var(--border-subtle);
  border-radius: 3px;
  color: var(--text-muted);
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
