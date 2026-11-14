<script setup lang="ts">
import { ref, computed, onMounted } from 'vue';
import {
  listProjects,
  searchMultiReplace,
  executeMultiReplace,
  type Project,
  type MultiSearchMatch,
} from './api.ts';
import { notify } from './notify.ts';

const projects = ref<Project[]>([]);
const selectedProjectId = ref<number | 'all'>('all');

const sourceText = ref('');
const findText = ref('');
const replaceText = ref('');
const caseSensitive = ref(true);

const searching = ref(false);
const replacing = ref(false);
const hasSearched = ref(false);

const matches = ref<MultiSearchMatch[]>([]);
const totalCount = ref(0);
const projectCount = ref(0);
const selectedIds = ref<Set<number>>(new Set());

onMounted(async () => {
  try {
    projects.value = await listProjects();
  } catch (err) {
    console.error('Projeler yüklenemedi:', err);
  }
});

const isAllSelected = computed(() => {
  return matches.value.length > 0 && matches.value.every((m) => selectedIds.value.has(m.id));
});

const isIndeterminate = computed(() => {
  const count = matches.value.filter((m) => selectedIds.value.has(m.id)).length;
  return count > 0 && count < matches.value.length;
});

function toggleSelectAll(event: Event) {
  const checked = (event.target as HTMLInputElement).checked;
  if (checked) {
    for (const m of matches.value) {
      selectedIds.value.add(m.id);
    }
  } else {
    selectedIds.value.clear();
  }
}

function toggleSelect(id: number) {
  if (selectedIds.value.has(id)) {
    selectedIds.value.delete(id);
  } else {
    selectedIds.value.add(id);
  }
}

async function handleSearch() {
  const find = findText.value.trim();
  if (!find) {
    notify('Lütfen aranacak çeviri metnini girin.', 'error');
    return;
  }

  searching.value = true;
  selectedIds.value.clear();
  try {
    const res = await searchMultiReplace({
      projectIds: selectedProjectId.value === 'all' ? undefined : [selectedProjectId.value],
      sourceText: sourceText.value.trim() || undefined,
      findText: find,
      replaceText: replaceText.value,
      caseSensitive: caseSensitive.value,
      limit: 500,
    });
    matches.value = res.matches;
    totalCount.value = res.total;
    projectCount.value = res.projectCount;
    hasSearched.value = true;
  } catch (err) {
    console.error('Toplu arama hatası:', err);
    notify('Arama sırasında bir hata oluştu.', 'error');
  } finally {
    searching.value = false;
  }
}

function handleReset() {
  sourceText.value = '';
  findText.value = '';
  replaceText.value = '';
  matches.value = [];
  selectedIds.value.clear();
  hasSearched.value = false;
  totalCount.value = 0;
  projectCount.value = 0;
}

async function handleReplaceSelected() {
  const ids = Array.from(selectedIds.value);
  if (ids.length === 0) {
    notify('Lütfen değiştirilecek en az bir satır seçin.', 'warn');
    return;
  }
  const find = findText.value.trim();
  if (!find) {
    notify('Aranan metin boş olamaz.', 'error');
    return;
  }

  const ok = confirm(
    `Seçilen ${ids.length} adet çeviri kaydında "${find}" ifadesi "${replaceText.value}" ile değiştirilecek.\n\nİşlem yapılan satırlar inceleme durumuna alınacaktır. Devam etmek istiyor musunuz?`
  );
  if (!ok) return;

  replacing.value = true;
  try {
    const res = await executeMultiReplace({
      unitIds: ids,
      findText: find,
      replaceText: replaceText.value,
      caseSensitive: caseSensitive.value,
    });

    notify(
      `${res.changed} kayıt başarıyla güncellendi.${res.blocked > 0 ? ` (${res.blocked} kayıt kalite kontrolüne takıldı)` : ''}`,
      'success'
    );
    // Refresh search results
    await handleSearch();
  } catch (err) {
    console.error('Toplu değiştirme hatası:', err);
    notify('Değiştirme sırasında bir hata oluştu.', 'error');
  } finally {
    replacing.value = false;
  }
}

async function handleReplaceAll() {
  const find = findText.value.trim();
  if (!find) {
    notify('Aranan metin boş olamaz.', 'error');
    return;
  }
  if (totalCount.value === 0) {
    notify('Değiştirilecek eşleşme bulunmuyor.', 'warn');
    return;
  }

  const ok = confirm(
    `DİKKAT: Filtrelenen ${projectCount.value} projedeki TÜM ${totalCount.value} eşleşmede:\n"${find}" -> "${replaceText.value}"\nşeklinde toplu değişiklik yapılacak.\n\nDevam etmek istiyor musunuz?`
  );
  if (!ok) return;

  replacing.value = true;
  try {
    const res = await executeMultiReplace({
      projectIds: selectedProjectId.value === 'all' ? undefined : [selectedProjectId.value],
      sourceText: sourceText.value.trim() || undefined,
      findText: find,
      replaceText: replaceText.value,
      caseSensitive: caseSensitive.value,
    });

    notify(
      `${res.changed} kayıt güncellendi (${res.projectCount} projede).${res.blocked > 0 ? ` (${res.blocked} kayıt kalite kontrolüne takıldı)` : ''}`,
      'success'
    );
    // Refresh search results
    await handleSearch();
  } catch (err) {
    console.error('Tümünü değiştirme hatası:', err);
    notify('Toplu değişiklik sırasında bir hata oluştu.', 'error');
  } finally {
    replacing.value = false;
  }
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function highlightFind(text: string): string {
  if (!text || !findText.value) return escapeHtml(text);
  const escapedText = escapeHtml(text);
  const escapedFind = escapeHtml(findText.value);

  if (caseSensitive.value) {
    return escapedText.replaceAll(
      escapedFind,
      `<mark class="highlight-find">${escapedFind}</mark>`
    );
  }

  try {
    const regexPattern = escapedFind
      .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      .replace(/[iİıI]/g, '[iİıI]');
    const re = new RegExp(regexPattern, 'gui');
    return escapedText.replace(re, (match) => `<mark class="highlight-find">${match}</mark>`);
  } catch {
    return escapedText;
  }
}

function highlightReplace(text: string): string {
  if (!text || !replaceText.value) return escapeHtml(text);
  const escapedText = escapeHtml(text);
  const escapedReplace = escapeHtml(replaceText.value);

  if (!escapedReplace) return escapedText;

  return escapedText.replaceAll(
    escapedReplace,
    `<mark class="highlight-replace">${escapedReplace}</mark>`
  );
}
</script>

<template>
  <div class="workspace-screen multi-replace-screen">
    <!-- Header -->
    <header class="screen-header">
      <div class="header-content">
        <h1 class="header-title">
          <span>Toplu Bul & Değiştir</span>
          <span v-if="hasSearched" class="badge-counter">
            {{ projectCount }} Projede {{ totalCount.toLocaleString('tr') }} Eşleşme
          </span>
        </h1>
        <p class="header-subtitle">
          Birden çok projede aynı anda kaynak metin veya hatalı çeviriyi arayın; tek seferde seçerek veya topluca tutarlı hale getirin.
        </p>
      </div>
    </header>

    <!-- Step 1: Search Form Card -->
    <div class="search-panel">
      <div class="form-grid">
        <!-- Project Scope -->
        <div class="form-group project-group">
          <label class="form-label">Proje Kapsamı</label>
          <select v-model="selectedProjectId" class="form-select" :disabled="searching || replacing">
            <option value="all">Tüm Projeler ({{ projects.length }})</option>
            <option v-for="p in projects" :key="p.id" :value="p.id">
              {{ p.name || p.projectPath }}
            </option>
          </select>
        </div>

        <!-- Optional Source Text Filter -->
        <div class="form-group source-group">
          <label class="form-label">
            Kaynak Metin Filtresi <span class="label-hint">(İsteğe bağlı msgid)</span>
          </label>
          <input
            v-model="sourceText"
            type="text"
            placeholder="Örn: post (yalnızca kaynakta bu geçenleri filtreler)"
            class="form-input"
            :disabled="searching || replacing"
            @keydown.enter="handleSearch"
          />
        </div>

        <!-- Find Text (Current / Wrong translation) -->
        <div class="form-group find-group">
          <label class="form-label">
            Hatalı / Aranan Çeviri <span class="label-required">* (find)</span>
          </label>
          <input
            v-model="findText"
            type="text"
            placeholder="Örn: girdi"
            class="form-input"
            :disabled="searching || replacing"
            @keydown.enter="handleSearch"
          />
        </div>

        <!-- Replace Text (Correct / New translation) -->
        <div class="form-group replace-group">
          <label class="form-label">
            Olması Gereken Çeviri <span class="label-required">* (replace)</span>
          </label>
          <input
            v-model="replaceText"
            type="text"
            placeholder="Örn: yazı"
            class="form-input"
            :disabled="searching || replacing"
            @keydown.enter="handleSearch"
          />
        </div>
      </div>

      <!-- Controls Row: Options & Action Buttons -->
      <div class="panel-actions">
        <div class="options-group">
          <label class="checkbox-label" title="Türkçe İ/i ve I/ı harflerini tam doğrulamayla kontrol eder">
            <input
              v-model="caseSensitive"
              type="checkbox"
              :disabled="searching || replacing"
            />
            <span>Büyük/Küçük Harf Duyarlı (Türkçe Ç/ç, İ/i, I/ı uyumlu)</span>
          </label>
        </div>

        <div class="buttons-group">
          <button
            class="btn btn-secondary"
            :disabled="searching || replacing"
            @click="handleReset"
          >
            Temizle
          </button>
          <button
            class="btn btn-primary search-btn"
            :disabled="searching || replacing || !findText.trim()"
            @click="handleSearch"
          >
            <span v-if="searching" class="spinner"></span>
            <span v-else>🔍 Bul & Önizle</span>
          </button>
        </div>
      </div>
    </div>

    <!-- Step 2: Results & Bulk Execution Area -->
    <div class="results-container">
      <!-- Toolbar above results table -->
      <div v-if="hasSearched && matches.length > 0" class="results-toolbar">
        <div class="results-summary">
          <span>Seçili: <b>{{ selectedIds.size }}</b> / {{ matches.length }}</span>
          <span v-if="totalCount > matches.length" class="text-dim">
            (İlk 500 sonuç gösteriliyor)
          </span>
        </div>

        <div class="bulk-actions">
          <button
            class="btn btn-secondary action-btn"
            :disabled="replacing || selectedIds.size === 0"
            @click="handleReplaceSelected"
          >
            <span v-if="replacing" class="spinner"></span>
            <span v-else>Seçilenleri Değiştir ({{ selectedIds.size }})</span>
          </button>

          <button
            class="btn btn-primary action-btn replace-all-btn"
            :disabled="replacing || totalCount === 0"
            @click="handleReplaceAll"
          >
            <span v-if="replacing" class="spinner"></span>
            <span v-else>Tümünü Değiştir ({{ totalCount.toLocaleString('tr') }})</span>
          </button>
        </div>
      </div>

      <!-- Results Table View -->
      <div v-if="hasSearched && matches.length > 0" class="table-card">
        <table class="replace-table">
          <thead>
            <tr>
              <th style="width: 40px; text-align: center;">
                <input
                  type="checkbox"
                  :checked="isAllSelected"
                  :indeterminate="isIndeterminate"
                  @change="toggleSelectAll"
                />
              </th>
              <th style="width: 170px;">Proje</th>
              <th style="width: 28%;">Kaynak Metin (msgid)</th>
              <th style="width: 32%;">Mevcut Çeviri</th>
              <th>Yeni Çeviri Önizlemesi</th>
              <th style="width: 90px; text-align: center;">Durum</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="m in matches"
              :key="m.id"
              :class="{ selected: selectedIds.has(m.id) }"
              @click="toggleSelect(m.id)"
            >
              <td style="text-align: center;" @click.stop>
                <input
                  type="checkbox"
                  :checked="selectedIds.has(m.id)"
                  @change="toggleSelect(m.id)"
                />
              </td>
              <td class="col-project">
                <div class="project-title" :title="m.projectName">{{ m.projectName }}</div>
                <div class="project-slug">{{ m.projectSlug }}</div>
              </td>
              <td class="col-source">
                <div class="text-mono">{{ m.msgid }}</div>
                <div v-if="m.msgidPlural" class="text-mono plural-sub">Çoğul: {{ m.msgidPlural }}</div>
              </td>
              <td class="col-current">
                <div v-html="highlightFind(m.msgstr)"></div>
                <div
                  v-if="m.msgstrPlural"
                  class="plural-sub"
                  v-html="'Çoğul: ' + highlightFind(m.msgstrPlural)"
                ></div>
              </td>
              <td class="col-proposed">
                <div v-html="highlightReplace(m.proposedMsgstr)"></div>
                <div
                  v-if="m.proposedMsgstrPlural"
                  class="plural-sub"
                  v-html="'Çoğul: ' + highlightReplace(m.proposedMsgstrPlural)"
                ></div>
              </td>
              <td style="text-align: center;">
                <span class="status-badge" :class="'status-' + m.state">
                  {{ m.state }}
                </span>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <!-- Empty State: Has searched but 0 results -->
      <div v-else-if="hasSearched && matches.length === 0" class="empty-state">
        <div class="empty-icon">🔍</div>
        <div class="empty-title">Eşleşen Çeviri Kaydı Bulunamadı</div>
        <div class="empty-desc">
          Girilen arama kriterlerine uygun herhangi bir çeviri dizgesi bulunamadı.
          Büyük/küçük harf duyarlılığını veya kaynak metin filtresini esnetmeyi deneyebilirsiniz.
        </div>
      </div>

      <!-- Welcome State: Not searched yet -->
      <div v-else class="welcome-state">
        <div class="welcome-box">
          <div class="welcome-icon">⚡</div>
          <h2 class="welcome-title">İki Adımlı Güvenli Toplu Değiştirme</h2>
          <div class="welcome-steps">
            <div class="step-item">
              <span class="step-num">1</span>
              <div>
                <strong>Arayın & Önizleyin:</strong> Kaynak filtreyi veya aranan çeviri ifadesini girip "Bul & Önizle" butonuna tıklayın.
              </div>
            </div>
            <div class="step-item">
              <span class="step-num">2</span>
              <div>
                <strong>Güvenle Değiştirin:</strong> İncelediğiniz sonuçlardan yalnızca seçtiklerinizi veya tüm projelerdeki eşleşmeleri tek tıkla güncelleyin.
              </div>
            </div>
          </div>
          <p class="welcome-note">
            💡 Yapılan tüm değişiklikler otomatik olarak kalite kontrolünden geçirilir ve <strong>inceleme (review)</strong> durumuna alınır.
          </p>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.multi-replace-screen {
  display: flex;
  flex-direction: column;
  height: 100%;
  overflow: hidden;
  padding: 24px 32px;
  background: var(--bg-workspace);
}

.screen-header {
  margin-bottom: 20px;
}

.header-title {
  font-size: 20px;
  font-weight: 700;
  color: var(--text-heading);
  margin: 0 0 4px 0;
  display: flex;
  align-items: center;
  gap: 12px;
}

.badge-counter {
  font-size: 13px;
  font-weight: 500;
  color: var(--accent-cyan, #06b6d4);
  background: var(--bg-surface-elevated);
  padding: 2px 10px;
  border-radius: 12px;
  border: 1px solid var(--border-subtle);
}

.header-subtitle {
  font-size: 13px;
  color: var(--text-dim);
  margin: 0;
}

/* Search Panel */
.search-panel {
  background: var(--bg-surface);
  border: 1px solid var(--border-default);
  border-radius: 8px;
  padding: 16px 20px;
  margin-bottom: 16px;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.2);
}

.form-grid {
  display: grid;
  grid-template-columns: 220px 1.2fr 1.2fr 1.2fr;
  gap: 16px;
  margin-bottom: 16px;
}

.form-group {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.form-label {
  font-size: 12px;
  font-weight: 600;
  color: var(--text-heading);
}

.label-hint {
  font-size: 11px;
  font-weight: 400;
  color: var(--text-dim);
}

.label-required {
  font-size: 11px;
  font-weight: 600;
  color: var(--accent-amber, #f59e0b);
}

.form-select,
.form-input {
  padding: 8px 12px;
  font-size: 13px;
  background: var(--bg-surface-elevated);
  border: 1px solid var(--border-default);
  border-radius: 6px;
  color: var(--text-default);
  outline: none;
  transition: border-color 0.15s ease;
}

.form-select:focus,
.form-input:focus {
  border-color: var(--accent-blue, #3b82f6);
}

.panel-actions {
  display: flex;
  align-items: center;
  justify-content: space-between;
  border-top: 1px solid var(--border-subtle);
  padding-top: 12px;
}

.options-group {
  display: flex;
  align-items: center;
  gap: 16px;
}

.checkbox-label {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  color: var(--text-default);
  cursor: pointer;
}

.buttons-group {
  display: flex;
  gap: 10px;
}

.search-btn {
  font-weight: 600;
  padding: 8px 20px;
}

/* Results Section */
.results-container {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
  overflow: hidden;
}

.results-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 16px;
  background: var(--bg-surface);
  border: 1px solid var(--border-default);
  border-bottom: none;
  border-radius: 8px 8px 0 0;
}

.results-summary {
  font-size: 13px;
  color: var(--text-default);
  display: flex;
  align-items: center;
  gap: 8px;
}

.bulk-actions {
  display: flex;
  gap: 10px;
}

.action-btn {
  padding: 6px 14px;
  font-size: 12px;
  font-weight: 600;
}

.replace-all-btn {
  background: var(--accent-emerald, #10b981);
  border-color: var(--accent-emerald, #10b981);
  color: #fff;
}

.replace-all-btn:hover:not(:disabled) {
  filter: brightness(1.1);
}

/* Table */
.table-card {
  flex: 1;
  min-height: 0;
  overflow: auto;
  background: var(--bg-surface);
  border: 1px solid var(--border-default);
  border-radius: 0 0 8px 8px;
}

.replace-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
  text-align: left;
}

.replace-table thead {
  position: sticky;
  top: 0;
  background: var(--bg-surface-elevated);
  z-index: 2;
  border-bottom: 2px solid var(--border-default);
}

.replace-table th {
  padding: 10px 12px;
  font-size: 12px;
  font-weight: 600;
  color: var(--text-dim);
  text-transform: uppercase;
  letter-spacing: 0.03em;
}

.replace-table td {
  padding: 10px 12px;
  border-bottom: 1px solid var(--border-subtle);
  color: var(--text-default);
  vertical-align: top;
}

.replace-table tr:hover {
  background: var(--bg-surface-elevated);
  cursor: pointer;
}

.replace-table tr.selected {
  background: rgba(59, 130, 246, 0.08);
}

.col-project {
  line-height: 1.3;
}

.project-title {
  font-weight: 600;
  color: var(--text-heading);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 160px;
}

.project-slug {
  font-size: 11px;
  color: var(--text-dim);
  font-family: monospace;
}

.text-mono {
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  font-size: 12px;
  line-height: 1.4;
  word-break: break-word;
}

.plural-sub {
  margin-top: 4px;
  font-size: 11px;
  color: var(--text-dim);
}

/* Highlighting in Table */
:deep(.highlight-find) {
  background: rgba(239, 68, 68, 0.25);
  color: #fca5a5;
  border-radius: 3px;
  padding: 1px 3px;
  font-weight: 600;
}

:deep(.highlight-replace) {
  background: rgba(16, 185, 129, 0.25);
  color: #6ee7b7;
  border-radius: 3px;
  padding: 1px 3px;
  font-weight: 600;
}

.status-badge {
  display: inline-block;
  padding: 2px 6px;
  border-radius: 4px;
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
}

.status-review {
  background: rgba(245, 158, 11, 0.15);
  color: #fbbf24;
}

.status-ok {
  background: rgba(16, 185, 129, 0.15);
  color: #34d399;
}

.status-untranslated {
  background: rgba(156, 163, 175, 0.15);
  color: #9ca3af;
}

/* States */
.empty-state,
.welcome-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  flex: 1;
  padding: 40px;
  background: var(--bg-surface);
  border: 1px solid var(--border-default);
  border-radius: 8px;
  text-align: center;
}

.empty-icon {
  font-size: 42px;
  margin-bottom: 12px;
  opacity: 0.6;
}

.empty-title {
  font-size: 16px;
  font-weight: 700;
  color: var(--text-heading);
  margin-bottom: 8px;
}

.empty-desc {
  font-size: 13px;
  color: var(--text-dim);
  max-width: 480px;
  line-height: 1.5;
}

.welcome-box {
  max-width: 520px;
}

.welcome-icon {
  font-size: 36px;
  margin-bottom: 12px;
}

.welcome-title {
  font-size: 18px;
  font-weight: 700;
  color: var(--text-heading);
  margin: 0 0 16px 0;
}

.welcome-steps {
  display: flex;
  flex-direction: column;
  gap: 12px;
  text-align: left;
  background: var(--bg-surface-elevated);
  padding: 16px 20px;
  border-radius: 8px;
  border: 1px solid var(--border-subtle);
  margin-bottom: 16px;
}

.step-item {
  display: flex;
  gap: 12px;
  font-size: 13px;
  color: var(--text-default);
  line-height: 1.4;
}

.step-num {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  background: var(--accent-blue, #3b82f6);
  color: #fff;
  border-radius: 50%;
  font-size: 11px;
  font-weight: 700;
  flex-shrink: 0;
}

.welcome-note {
  font-size: 12px;
  color: var(--text-dim);
  margin: 0;
}

.spinner {
  display: inline-block;
  width: 14px;
  height: 14px;
  border: 2px solid rgba(255, 255, 255, 0.3);
  border-top-color: #fff;
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}
</style>
