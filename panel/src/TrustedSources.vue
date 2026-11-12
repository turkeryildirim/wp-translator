<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import {
  addSource,
  bulkDeleteSources,
  bulkTagSources,
  importSourcesToProjects,
  listSources,
  listTags,
  refreshSourcesStats,
  reorderSources,
  type Tag,
  type TrustedSource,
} from './api.ts';
import { notify } from './notify.ts';

const emit = defineEmits<{
  (e: 'open-project', id: number): void;
}>();

const sources = ref<TrustedSource[]>([]);
const tags = ref<Tag[]>([]);
const loading = ref(false);
const refreshingStats = ref(false);

const searchQuery = ref('');
const filterTagId = ref<number | null>(null);

// Multi-selection
const picked = ref(new Set<number>());

// Sorting
type SortField =
  | 'rank'
  | 'project'
  | 'percent'
  | 'translated'
  | 'fuzzy'
  | 'waiting'
  | 'untranslated'
  | 'lastSyncedAt';

const sortField = ref<SortField>('rank');
const sortAsc = ref(true);

function toggleSort(field: SortField): void {
  if (sortField.value === field) {
    sortAsc.value = !sortAsc.value;
  } else {
    sortField.value = field;
    sortAsc.value = field === 'project' || field === 'rank';
  }
}

// Modals
const showAddModal = ref(false);
const newSourceUrl = ref('');
const newSourceLabel = ref('');
const newSourceTagIds = ref<number[]>([]);
const addingSource = ref(false);

const showBulkTagModal = ref<'assign' | 'remove' | null>(null);
const bulkTargetTagId = ref<number | null>(null);


async function load(): Promise<void> {
  loading.value = true;
  try {
    const [sourceList, tagList] = await Promise.all([listSources(), listTags()]);
    sources.value = sourceList;
    tags.value = tagList;
    picked.value = new Set([...picked.value].filter((id) => sourceList.some((s) => s.id === id)));
  } catch (err) {
    notify('error', 'Kaynaklar yüklenemedi: ' + String(err));
  } finally {
    loading.value = false;
  }
}

const filteredAndSortedSources = computed(() => {
  let list = sources.value;

  if (searchQuery.value.trim()) {
    const q = searchQuery.value.toLowerCase().trim();
    list = list.filter(
      (s) =>
        (s.label && s.label.toLowerCase().includes(q)) ||
        s.projectPath.toLowerCase().includes(q) ||
        s.translateUrl.toLowerCase().includes(q),
    );
  }

  if (filterTagId.value !== null) {
    list = list.filter((s) => s.tagIds.includes(filterTagId.value!));
  }

  const sorted = [...list].sort((a, b) => {
    let comparison = 0;
    switch (sortField.value) {
      case 'rank':
        comparison = a.rank - b.rank;
        break;
      case 'project':
        comparison = (a.label ?? a.projectPath).localeCompare(b.label ?? b.projectPath, 'tr');
        break;
      case 'percent':
        comparison = a.percent - b.percent;
        break;
      case 'translated':
        comparison = a.translated - b.translated;
        break;
      case 'fuzzy':
        comparison = a.fuzzy - b.fuzzy;
        break;
      case 'waiting':
        comparison = a.waiting - b.waiting;
        break;
      case 'untranslated':
        comparison = a.untranslated - b.untranslated;
        break;
      case 'lastSyncedAt':
        comparison = (a.lastSyncedAt ?? '').localeCompare(b.lastSyncedAt ?? '');
        break;
    }
    return sortAsc.value ? comparison : -comparison;
  });

  return sorted;
});

const allPicked = computed(
  () =>
    filteredAndSortedSources.value.length > 0 &&
    filteredAndSortedSources.value.every((s) => picked.value.has(s.id)),
);

function toggleAll(): void {
  if (allPicked.value) {
    const next = new Set(picked.value);
    filteredAndSortedSources.value.forEach((s) => next.delete(s.id));
    picked.value = next;
  } else {
    const next = new Set(picked.value);
    filteredAndSortedSources.value.forEach((s) => next.add(s.id));
    picked.value = next;
  }
}

function togglePick(id: number): void {
  const next = new Set(picked.value);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  picked.value = next;
}

// Adding source
function openAddModal(): void {
  newSourceUrl.value = '';
  newSourceLabel.value = '';
  newSourceTagIds.value = tags.value.length > 0 ? [tags.value[0].id] : [];
  showAddModal.value = true;
}

async function handleAddSource(): Promise<void> {
  if (!newSourceUrl.value.trim()) return;
  addingSource.value = true;
  try {
    await addSource(
      newSourceUrl.value.trim(),
      newSourceTagIds.value,
      newSourceLabel.value.trim() || undefined,
    );
    notify('ok', 'Güvenilir proje başarıyla eklendi.');
    showAddModal.value = false;
    await load();
  } catch (err) {
    notify('error', 'Proje eklenemedi: ' + String(err));
  } finally {
    addingSource.value = false;
  }
}

// Bulk delete
async function dropPicked(): Promise<void> {
  const ids = [...picked.value];
  if (ids.length === 0) return;
  if (!confirm(`${ids.length} güvenilir proje silinsin mi?`)) return;

  try {
    const { removed } = await bulkDeleteSources(ids);
    notify('ok', `${removed} proje kaldırıldı.`);
    picked.value = new Set();
    await load();
  } catch (err) {
    notify('error', 'Projeler kaldırılamadı: ' + String(err));
  }
}

// Single delete
async function dropSingle(source: TrustedSource): Promise<void> {
  if (!confirm(`"${source.label ?? source.projectPath}" projesi listeden kaldırılsın mı?`)) return;
  try {
    await bulkDeleteSources([source.id]);
    notify('ok', 'Proje kaldırıldı.');
    picked.value.delete(source.id);
    await load();
  } catch (err) {
    notify('error', 'Proje kaldırılamadı: ' + String(err));
  }
}

// Bulk tag changes
async function applyBulkTag(): Promise<void> {
  const ids = [...picked.value];
  if (ids.length === 0 || bulkTargetTagId.value === null) return;
  const action = showBulkTagModal.value;
  if (!action) return;

  try {
    const { changed } = await bulkTagSources(
      ids,
      action === 'assign' ? { add: [bulkTargetTagId.value] } : { remove: [bulkTargetTagId.value] },
    );
    const tagName = tags.value.find((t) => t.id === bulkTargetTagId.value)?.name ?? '';
    notify(
      'ok',
      `${changed} projede "${tagName}" etiketi ${action === 'assign' ? 'eklendi' : 'kaldırıldı'}.`,
    );
    showBulkTagModal.value = null;
    bulkTargetTagId.value = null;
    await load();
  } catch (err) {
    notify('error', 'Etiket işlemi başarısız: ' + String(err));
  }
}

// GlotPress Stats Refresh
const refreshingSourceIds = ref(new Set<number>());

export interface RefreshProgress {
  running: boolean;
  done: number;
  total: number;
  current: string | null;
}

const refreshProgress = ref<RefreshProgress>({
  running: false,
  done: 0,
  total: 0,
  current: null,
});

async function refreshStats(ids?: number[]): Promise<void> {
  const targetSources = ids
    ? sources.value.filter((s) => ids.includes(s.id))
    : [...sources.value];

  if (targetSources.length === 0) return;

  refreshingStats.value = true;
  refreshProgress.value = {
    running: true,
    done: 0,
    total: targetSources.length,
    current: targetSources[0].label ?? targetSources[0].projectPath,
  };

  try {
    for (let i = 0; i < targetSources.length; i++) {
      const src = targetSources[i];
      refreshProgress.value.done = i;
      refreshProgress.value.current = src.label ?? src.projectPath;
      refreshingSourceIds.value = new Set([src.id]);

      try {
        await refreshSourcesStats([src.id]);
      } catch (err) {
        console.warn(`İstatistik çekilemedi: ${src.projectPath}`, err);
      }
      refreshProgress.value.done = i + 1;
    }
    await load();
    notify('ok', `${targetSources.length} güvenilir projenin istatistikleri güncellendi.`);
  } catch (err) {
    notify('error', 'İstatistikler güncellenemedi: ' + String(err));
  } finally {
    refreshingStats.value = false;
    refreshingSourceIds.value = new Set();
    refreshProgress.value = {
      running: false,
      done: 0,
      total: 0,
      current: null,
    };
  }
}

async function refreshSingleSource(id: number): Promise<void> {
  refreshingSourceIds.value = new Set(refreshingSourceIds.value).add(id);
  try {
    await refreshSourcesStats([id]);
    await load();
    notify('ok', 'Proje istatistikleri güncellendi.');
  } catch (err) {
    notify('error', 'İstatistikler güncellenemedi: ' + String(err));
  } finally {
    const next = new Set(refreshingSourceIds.value);
    next.delete(id);
    refreshingSourceIds.value = next;
  }
}

// Import to Translation Projects
export interface ImportProgress {
  running: boolean;
  done: number;
  total: number;
  current: string | null;
}

const importProgress = ref<ImportProgress>({
  running: false,
  done: 0,
  total: 0,
  current: null,
});
const importingSourceIds = ref(new Set<number>());

async function importSelectedToProjects(ids?: number[]): Promise<void> {
  const targetSources = ids
    ? sources.value.filter((s) => ids.includes(s.id))
    : sources.value.filter((s) => picked.value.has(s.id));

  if (targetSources.length === 0) return;

  const count = targetSources.length;
  if (!confirm(`${count} güvenilir proje çeviri inceleme ekranına aktarılsın mı?`)) return;

  importProgress.value = {
    running: true,
    done: 0,
    total: targetSources.length,
    current: targetSources[0].label ?? targetSources[0].projectPath,
  };

  const allAdded: Array<{ id: number; name: string }> = [];
  const allSkipped: Array<{ name: string; reason: string }> = [];
  const allErrors: Array<{ name: string; error: string }> = [];

  try {
    for (let i = 0; i < targetSources.length; i++) {
      const src = targetSources[i];
      importProgress.value.done = i;
      importProgress.value.current = src.label ?? src.projectPath;
      importingSourceIds.value = new Set([src.id]);

      try {
        const res = await importSourcesToProjects([src.id]);
        allAdded.push(...res.added);
        allSkipped.push(...res.skipped);
        allErrors.push(...res.errors);
      } catch (err: unknown) {
        allErrors.push({
          name: src.label ?? src.projectPath,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      importProgress.value.done = i + 1;
    }

    await load();

    let msg = `${allAdded.length} proje çeviri incelemeye aktarıldı.`;
    const details: string[] = [];
    if (allSkipped.length > 0) details.push(`${allSkipped.length} tanesi zaten mevcuttu`);
    if (allErrors.length > 0) details.push(`${allErrors.length} tanesinde hata oluştu`);
    if (details.length > 0) msg += ` (${details.join(', ')})`;

    notify(allAdded.length > 0 ? 'ok' : allSkipped.length > 0 ? 'ok' : 'error', msg);

    if (allAdded.length > 0) {
      if (
        confirm(
          `${allAdded.length} proje eklendi. Şimdi Çeviri İnceleme ekranına geçip "${allAdded[0].name}" projesini açmak ister misiniz?`,
        )
      ) {
        emit('open-project', allAdded[0].id);
      }
    }
  } catch (err: unknown) {
    notify('error', 'Projeler aktarılamadı: ' + String(err));
  } finally {
    importingSourceIds.value = new Set();
    importProgress.value = {
      running: false,
      done: 0,
      total: 0,
      current: null,
    };
  }
}

async function handleSingleSourceAction(source: TrustedSource): Promise<void> {
  if (source.existingProjectId) {
    emit('open-project', source.existingProjectId);
    return;
  }

  importingSourceIds.value = new Set([source.id]);
  try {
    const res = await importSourcesToProjects([source.id]);
    if (res.added.length > 0) {
      notify('ok', `"${res.added[0].name}" projesi çeviri incelemeye aktarıldı.`);
      await load();
      if (
        confirm(
          `"${res.added[0].name}" çeviri incelemeye eklendi. Şimdi çeviri ekranına geçmek ister misiniz?`,
        )
      ) {
        emit('open-project', res.added[0].id);
      }
    } else if (res.skipped.length > 0) {
      notify('ok', `"${source.label ?? source.projectPath}" zaten çeviri projelerinde mevcut.`);
      await load();
    } else if (res.errors.length > 0) {
      notify('error', `Aktarma başarısız: ${res.errors[0].error}`);
    }
  } catch (err: unknown) {
    notify('error', 'Aktarma hatası: ' + String(err));
  } finally {
    importingSourceIds.value = new Set();
  }
}

// Inline Row Tag Actions
const activeTagMenuSourceId = ref<number | null>(null);

function toggleTagMenu(sourceId: number): void {
  if (activeTagMenuSourceId.value === sourceId) {
    activeTagMenuSourceId.value = null;
  } else {
    activeTagMenuSourceId.value = sourceId;
  }
}

function availableTagsForSource(source: TrustedSource): Tag[] {
  return tags.value.filter((t) => !source.tagIds.includes(t.id));
}

async function removeTagFromSource(source: TrustedSource, tagId: number): Promise<void> {
  const tagName = tags.value.find((t) => t.id === tagId)?.name ?? '';
  try {
    await bulkTagSources([source.id], { remove: [tagId] });
    source.tagIds = source.tagIds.filter((id) => id !== tagId);
    notify('ok', `"${tagName}" etiketi projeden kaldırıldı.`);
  } catch (err) {
    notify('error', 'Etiket kaldırılamadı: ' + String(err));
    await load();
  }
}

async function addTagToSource(source: TrustedSource, tagId: number): Promise<void> {
  const tagName = tags.value.find((t) => t.id === tagId)?.name ?? '';
  try {
    await bulkTagSources([source.id], { add: [tagId] });
    if (!source.tagIds.includes(tagId)) {
      source.tagIds.push(tagId);
    }
    activeTagMenuSourceId.value = null;
    notify('ok', `"${tagName}" etiketi eklendi.`);
  } catch (err) {
    notify('error', 'Etiket eklenemedi: ' + String(err));
    await load();
  }
}

function onDocumentClick(): void {
  activeTagMenuSourceId.value = null;
}

// Drag & drop reordering
const draggingId = ref<number | null>(null);
const dropTargetId = ref<number | null>(null);

function onDragStart(id: number, event: DragEvent): void {
  draggingId.value = id;
  event.dataTransfer!.effectAllowed = 'move';
  event.dataTransfer!.setData('text/plain', String(id));
}

function onDragOver(id: number, event: DragEvent): void {
  if (draggingId.value === null || draggingId.value === id) return;
  event.preventDefault();
  event.dataTransfer!.dropEffect = 'move';
  dropTargetId.value = id;
}

function onDragLeave(id: number): void {
  if (dropTargetId.value === id) {
    dropTargetId.value = null;
  }
}

async function onDrop(targetId: number): Promise<void> {
  const fromId = draggingId.value;
  draggingId.value = null;
  dropTargetId.value = null;
  if (fromId === null || fromId === targetId) return;

  const fromIndex = sources.value.findIndex((s) => s.id === fromId);
  const toIndex = sources.value.findIndex((s) => s.id === targetId);
  if (fromIndex === -1 || toIndex === -1) return;

  const next = [...sources.value];
  const [moved] = next.splice(fromIndex, 1);
  next.splice(toIndex, 0, moved!);

  // Re-index ranks in memory so the new order reflects immediately in the UI
  next.forEach((s, idx) => {
    s.rank = idx + 1;
  });

  sortField.value = 'rank';
  sortAsc.value = true;
  sources.value = next;

  try {
    await reorderSources(next.map((s) => s.id));
    notify('ok', 'Yeni sıra kaydedildi.');
  } catch (err) {
    notify('error', 'Sıra kaydedilemedi: ' + String(err));
    await load();
  }
}

function formatRelativeTime(dateStr: string | null): string {
  if (!dateStr) return 'Henüz güncellenmedi';
  try {
    const d = new Date(dateStr.endsWith('Z') ? dateStr : dateStr + 'Z');
    if (isNaN(d.getTime())) return dateStr;
    const diffSec = Math.floor((Date.now() - d.getTime()) / 1000);
    if (diffSec < 60) return 'Az önce';
    if (diffSec < 3600) return `${Math.floor(diffSec / 60)} dk önce`;
    if (diffSec < 86400) return `${Math.floor(diffSec / 3600)} saat önce`;
    if (diffSec < 604800) return `${Math.floor(diffSec / 86400)} gün önce`;
    return d.toLocaleDateString('tr-TR', { day: 'numeric', month: 'short' });
  } catch {
    return dateStr;
  }
}

function percentClass(percent: number): string {
  if (percent >= 100) return 'text-success';
  if (percent >= 80) return 'text-warning';
  return 'text-danger';
}

onMounted(() => {
  load();
  window.addEventListener('click', onDocumentClick);
});

onUnmounted(() => {
  window.removeEventListener('click', onDocumentClick);
});
</script>

<template>
  <div class="page-layout">
    <div class="page-header">
      <div>
        <h1 class="page-title">Güvenilir Projeler (Trusted Sources)</h1>
        <p class="page-desc">
          translate.wordpress.org üzerindeki canlı durumları (çevrilmiş, fuzzy, waiting, untranslated)
          anlık olarak izlenir. Projelerden yalnızca seçtiğiniz doğrulanmış girdiler sözlüğe aktarılır.
        </p>
      </div>
      <div style="display: flex; gap: 10px;">
        <button
          class="btn"
          :disabled="refreshingStats"
          title="Tüm güvenilir projelerin 5 istatistik sütununu GlotPress'ten güncelle"
          @click="refreshStats()"
        >
          <span v-if="refreshingStats" class="inline-spinner" style="margin-right: 4px;"></span>
          <span v-else style="margin-right: 4px;">🔄</span>
          {{ refreshingStats ? `Güncelleniyor… (${refreshProgress.done}/${refreshProgress.total})` : 'Tümünü Güncelle' }}
        </button>
        <button class="btn primary" :disabled="refreshingStats" @click="openAddModal">
          + Güvenilir Proje Ekle
        </button>
      </div>
    </div>

    <!-- Filter & Bulk Actions Bar -->
    <div class="filter-card">
      <div class="search-box" style="flex: 1;">
        <span class="search-icon">🔍</span>
        <input
          v-model="searchQuery"
          class="search-input"
          placeholder="Projelerde veya URL'de ara..."
        />
      </div>

      <select
        :value="filterTagId === null ? '' : filterTagId"
        class="btn"
        aria-label="Etikete göre filtrele"
        @change="filterTagId = ($event.target as HTMLSelectElement).value === '' ? null : Number(($event.target as HTMLSelectElement).value)"
      >
        <option value="">Tüm Etiketler</option>
        <option v-for="tag in tags" :key="tag.id" :value="tag.id">
          {{ tag.name }} ({{ tag.entries.toLocaleString('tr') }})
        </option>
      </select>

      <!-- Multi-select Bulk Actions -->
      <div
        v-if="picked.size > 0"
        style="display: flex; gap: 8px; align-items: center; border-left: 1px solid var(--border-default); padding-left: 12px;"
      >
        <span style="font-size: 12px; color: var(--text-muted); font-weight: 600;">
          {{ picked.size }} proje seçili:
        </span>
        <button
          class="btn primary"
          style="font-size: 11px;"
          :disabled="refreshingStats || importProgress.running"
          title="Seçili güvenilir projeleri Çeviri İnceleme ekranına yeni proje olarak aktar"
          @click="importSelectedToProjects()"
        >
          📥 Çeviri İncelemeye Aktar
        </button>
        <button class="btn" style="font-size: 11px;" :disabled="refreshingStats || importProgress.running" @click="showBulkTagModal = 'assign'">
          🏷️ Toplu Etikete Ata
        </button>
        <button class="btn" style="font-size: 11px;" :disabled="refreshingStats || importProgress.running" @click="showBulkTagModal = 'remove'">
          🏷️ Etiketten Kaldır
        </button>
        <button
          class="btn"
          style="font-size: 11px;"
          :disabled="refreshingStats || importProgress.running"
          @click="refreshStats([...picked])"
        >
          🔄 Seçilenleri Güncelle
        </button>
        <button
          class="btn"
          style="font-size: 11px; color: #f87171;"
          :disabled="refreshingStats || importProgress.running"
          @click="dropPicked"
        >
          🗑️ Toplu Sil
        </button>
      </div>
    </div>

    <!-- Importing Progress Alert Strip -->
    <div
      v-if="importProgress.running"
      class="filter-card"
      style="background: rgba(56, 189, 248, 0.08); border-color: rgba(56, 189, 248, 0.3); margin-bottom: 12px; display: flex; align-items: center; justify-content: space-between; gap: 12px;"
    >
      <div style="display: flex; align-items: center; gap: 10px;">
        <span class="inline-spinner"></span>
        <span style="font-size: 13px; font-weight: 600; color: #38bdf8;">
          Projeler çeviri incelemeye aktarılıyor: {{ importProgress.done }} / {{ importProgress.total }} · {{ importProgress.current }}
        </span>
      </div>
      <div style="font-size: 12px; color: var(--text-subtle); font-weight: 600;">
        %{{ Math.round((importProgress.done / (importProgress.total || 1)) * 100) }}
      </div>
    </div>

    <!-- Refreshing Progress Alert Strip -->
    <div
      v-if="refreshProgress.running"
      class="filter-card"
      style="background: rgba(94, 234, 212, 0.08); border-color: rgba(94, 234, 212, 0.3); margin-bottom: 12px; display: flex; align-items: center; justify-content: space-between; gap: 12px;"
    >
      <div style="display: flex; align-items: center; gap: 10px;">
        <span class="inline-spinner"></span>
        <span style="font-size: 13px; font-weight: 600; color: var(--accent-mint);">
          İstatistikler güncelleniyor: {{ refreshProgress.done }} / {{ refreshProgress.total }} · {{ refreshProgress.current }}
        </span>
      </div>
      <div style="font-size: 12px; color: var(--text-subtle); font-weight: 600;">
        %{{ Math.round((refreshProgress.done / (refreshProgress.total || 1)) * 100) }}
      </div>
    </div>

    <!-- GlotPress-style Data Table -->
    <div class="data-table-container" :class="{ 'is-refreshing-all': refreshingStats || importProgress.running }">
      <table class="data-table">
        <thead>
          <tr>
            <th style="width: 38px; text-align: center;">
              <input
                type="checkbox"
                :checked="allPicked"
                :disabled="refreshingStats || importProgress.running"
                title="Tümünü Seç / Seçimi Bırak"
                @change="toggleAll"
              />
            </th>
            <th class="sortable" style="width: 50px;" @click="refreshingStats ? undefined : toggleSort('rank')">
              Sıra {{ sortField === 'rank' ? (sortAsc ? '▲' : '▼') : '' }}
            </th>
            <th class="sortable" @click="refreshingStats ? undefined : toggleSort('project')">
              Proje / Alt Proje {{ sortField === 'project' ? (sortAsc ? '▲' : '▼') : '' }}
            </th>
            <th>Etiketler</th>
            <th
              class="sortable"
              style="text-align: right;"
              @click="refreshingStats ? undefined : toggleSort('percent')"
            >
              Tamamlanma (%) {{ sortField === 'percent' ? (sortAsc ? '▲' : '▼') : '' }}
            </th>
            <th
              class="sortable"
              style="text-align: right;"
              @click="refreshingStats ? undefined : toggleSort('translated')"
            >
              Çevrilmiş {{ sortField === 'translated' ? (sortAsc ? '▲' : '▼') : '' }}
            </th>
            <th
              class="sortable"
              style="text-align: right;"
              @click="refreshingStats ? undefined : toggleSort('fuzzy')"
            >
              Fuzzy {{ sortField === 'fuzzy' ? (sortAsc ? '▲' : '▼') : '' }}
            </th>
            <th
              class="sortable"
              style="text-align: right;"
              @click="refreshingStats ? undefined : toggleSort('waiting')"
            >
              Bekleyen {{ sortField === 'waiting' ? (sortAsc ? '▲' : '▼') : '' }}
            </th>
            <th
              class="sortable"
              style="text-align: right;"
              @click="refreshingStats ? undefined : toggleSort('untranslated')"
            >
              Çevrilmemiş {{ sortField === 'untranslated' ? (sortAsc ? '▲' : '▼') : '' }}
            </th>
            <th
              class="sortable"
              style="text-align: right;"
              @click="refreshingStats ? undefined : toggleSort('lastSyncedAt')"
            >
              Son Güncelleme {{ sortField === 'lastSyncedAt' ? (sortAsc ? '▲' : '▼') : '' }}
            </th>
            <th style="text-align: center; width: 180px;">İşlemler</th>
          </tr>
        </thead>
        <tbody>
          <tr v-if="filteredAndSortedSources.length === 0">
            <td colspan="11" style="text-align: center; padding: 32px; color: var(--text-muted);">
              Eşleşen güvenilir proje bulunamadı.
            </td>
          </tr>
          <tr
            v-for="(source, index) in filteredAndSortedSources"
            :key="source.id"
            :class="{
              active: picked.has(source.id),
              dragging: draggingId === source.id,
              dropinto: dropTargetId === source.id && draggingId !== source.id,
              'row-disabled': refreshingStats || importProgress.running,
            }"
            @dragover.prevent="refreshingStats || importProgress.running ? undefined : onDragOver(source.id, $event)"
            @dragleave="refreshingStats || importProgress.running ? undefined : onDragLeave(source.id)"
            @drop.prevent="refreshingStats || importProgress.running ? undefined : onDrop(source.id)"
          >
            <td style="text-align: center;" @click.stop>
              <input
                type="checkbox"
                :checked="picked.has(source.id)"
                :disabled="refreshingStats || importProgress.running"
                @change="togglePick(source.id)"
              />
            </td>
            <td
              style="color: var(--text-subtle); font-weight: 700;"
              :style="{ cursor: refreshingStats || importProgress.running ? 'not-allowed' : 'grab' }"
              :draggable="!refreshingStats && !importProgress.running"
              :title="refreshingStats || importProgress.running ? 'İşlem sırasında sıralama değiştirilemez' : 'Sürükleyerek sırasını değiştirin'"
              @dragstart="refreshingStats || importProgress.running ? undefined : onDragStart(source.id, $event)"
              @dragend="draggingId = null; dropTargetId = null;"
            >
              {{ index + 1 }} ☰
            </td>
            <td>
              <div style="display: flex; align-items: center; gap: 8px; flex-wrap: wrap;">
                <span style="font-weight: 700; color: #fff;">
                  {{ source.label ?? source.projectPath }}
                </span>
                <span
                  v-if="source.existingProjectId"
                  class="status-pill ok"
                  style="font-size: 10px; padding: 1px 6px; cursor: pointer;"
                  title="Bu proje çeviri projelerinde ekli. İnceleme ekranında açmak için tıklayın"
                  @click.stop="emit('open-project', source.existingProjectId)"
                >
                  📝 Çeviride Ekli
                </span>
              </div>
              <div style="font-size: 11px; color: var(--text-subtle);">
                <a
                  :href="source.translateUrl"
                  target="_blank"
                  rel="noreferrer"
                  :style="refreshingStats ? { pointerEvents: 'none', color: 'inherit', textDecoration: 'none' } : { color: 'inherit', textDecoration: 'none' }"
                >
                  {{ source.translateUrl }}
                </a>
              </div>
            </td>
            <td>
              <div class="row-tags-wrapper">
                <span
                  v-for="tag in tags.filter((t) => source.tagIds.includes(t.id))"
                  :key="tag.id"
                  class="status-pill ok tag-pill"
                >
                  {{ tag.name }}
                  <button
                    type="button"
                    class="tag-del-btn"
                    :disabled="refreshingStats"
                    title="Etiketi bu projeden kaldır"
                    @click.stop="refreshingStats ? undefined : removeTagFromSource(source, tag.id)"
                  >
                    ×
                  </button>
                </span>
                <span
                  v-if="source.tagIds.length === 0"
                  class="status-pill untranslated"
                >
                  etiketsiz
                </span>

                <!-- Add Tag button and inline popover -->
                <div class="add-tag-wrapper" @click.stop>
                  <button
                    type="button"
                    class="add-tag-trigger-btn"
                    :disabled="refreshingStats"
                    title="Bu projeye etiket ekle"
                    @click="refreshingStats ? undefined : toggleTagMenu(source.id)"
                  >
                    +
                  </button>

                  <div
                    v-if="!refreshingStats && activeTagMenuSourceId === source.id"
                    class="tag-dropdown-menu"
                  >
                    <div class="tag-dropdown-header">Etiket Ekle</div>
                    <div v-if="availableTagsForSource(source).length === 0" class="tag-dropdown-empty">
                      Tüm etiketler ekli
                    </div>
                    <div v-else class="tag-dropdown-list">
                      <button
                        v-for="availTag in availableTagsForSource(source)"
                        :key="availTag.id"
                        type="button"
                        class="tag-dropdown-item"
                        @click="addTagToSource(source, availTag.id)"
                      >
                        {{ availTag.name }}
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            </td>
            <td style="text-align: right; font-weight: 700;" :class="percentClass(source.percent)">
              %{{ source.percent }}
            </td>
            <td style="text-align: right; font-weight: 600; color: #34d399;">
              {{ source.translated.toLocaleString('tr') }}
            </td>
            <td
              style="text-align: right;"
              :style="{ color: source.fuzzy > 0 ? '#fbbf24' : 'var(--text-subtle)' }"
            >
              {{ source.fuzzy.toLocaleString('tr') }}
            </td>
            <td
              style="text-align: right;"
              :style="{ color: source.waiting > 0 ? '#fbbf24' : 'var(--text-subtle)' }"
            >
              {{ source.waiting.toLocaleString('tr') }}
            </td>
            <td
              style="text-align: right;"
              :style="{ color: source.untranslated > 0 ? '#f87171' : 'var(--text-subtle)' }"
            >
              {{ source.untranslated.toLocaleString('tr') }}
            </td>
            <td style="text-align: right; font-size: 11px; color: var(--text-muted);">
              {{ formatRelativeTime(source.lastSyncedAt) }}
            </td>
            <td style="text-align: center;" @click.stop>
              <div style="display: flex; gap: 6px; justify-content: center; align-items: center;">
                <button
                  class="btn"
                  :class="{ primary: !source.existingProjectId }"
                  style="padding: 3px 8px; font-size: 11px; display: inline-flex; align-items: center; gap: 4px;"
                  :disabled="refreshingStats || importProgress.running || importingSourceIds.has(source.id)"
                  :title="source.existingProjectId ? 'Bu projeyi Çeviri İnceleme ekranında aç' : 'Bu projeyi Çeviri İnceleme ekranına yeni proje olarak aktar'"
                  @click="handleSingleSourceAction(source)"
                >
                  <span v-if="importingSourceIds.has(source.id)" class="inline-spinner"></span>
                  <span v-else>{{ source.existingProjectId ? '🔍 Aç' : '📥 Aktar' }}</span>
                </button>
                <button
                  class="btn"
                  style="padding: 3px 8px; font-size: 11px; display: inline-flex; align-items: center; gap: 4px;"
                  :disabled="refreshingStats || importProgress.running || refreshingSourceIds.has(source.id)"
                  title="Bu projenin canlı GlotPress sayılarını yenile"
                  @click="refreshSingleSource(source.id)"
                >
                  <span v-if="refreshingSourceIds.has(source.id)" class="inline-spinner"></span>
                  <span v-else>🔄</span>
                  {{ refreshingSourceIds.has(source.id) ? 'Yenileniyor…' : 'Yenile' }}
                </button>
                <button
                  class="btn"
                  style="padding: 3px 6px; font-size: 11px; color: #f87171;"
                  :disabled="refreshingStats || importProgress.running"
                  title="Projeyi listeden sil"
                  @click="dropSingle(source)"
                >
                  🗑️
                </button>
              </div>
            </td>
          </tr>
          </tbody>
        </table>
      </div>

    <!-- Modal: Proje Ekle -->
    <div v-if="showAddModal" class="backdrop" @click.self="showAddModal = false">
      <div class="modal" style="max-width: 540px;">
        <div style="display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid var(--border-default); padding-bottom: 10px;">
          <h3 style="margin: 0; color: #fff; font-size: 16px;">Güvenilir Proje Ekle</h3>
          <button class="btn" style="padding: 2px 8px;" @click="showAddModal = false">✕</button>
        </div>

        <div style="display: flex; flex-direction: column; gap: 14px; margin-top: 10px;">
          <div>
            <label style="font-size: 11px; font-weight: 700; color: var(--text-subtle); text-transform: uppercase;">
              GlotPress Proje Adresi (URL):
            </label>
            <input
              v-model="newSourceUrl"
              class="search-input"
              style="margin-top: 4px;"
              placeholder="https://translate.wordpress.org/projects/wp-plugins/wconvert/stable/tr/default/"
              @keyup.enter="handleAddSource"
            />
          </div>

          <div>
            <label style="font-size: 11px; font-weight: 700; color: var(--text-subtle); text-transform: uppercase;">
              Görünecek Etiket / Başlık (Opsiyonel):
            </label>
            <input
              v-model="newSourceLabel"
              class="search-input"
              style="margin-top: 4px;"
              placeholder="Örn: wconvert / stable"
            />
          </div>

          <div>
            <label style="font-size: 11px; font-weight: 700; color: var(--text-subtle); text-transform: uppercase; margin-bottom: 6px; display: block;">
              Atanacak Etiketler:
            </label>
            <div style="display: flex; gap: 8px; flex-wrap: wrap;">
              <label
                v-for="tag in tags"
                :key="tag.id"
                style="display: flex; align-items: center; gap: 6px; font-size: 12px; cursor: pointer; background: var(--bg-surface); padding: 4px 8px; border-radius: 4px; border: 1px solid var(--border-default);"
              >
                <input
                  type="checkbox"
                  :value="tag.id"
                  :checked="newSourceTagIds.includes(tag.id)"
                  @change="
                    newSourceTagIds.includes(tag.id)
                      ? newSourceTagIds = newSourceTagIds.filter(id => id !== tag.id)
                      : newSourceTagIds.push(tag.id)
                  "
                />
                {{ tag.name }}
              </label>
            </div>
          </div>
        </div>

        <div style="display: flex; justify-content: flex-end; gap: 8px; margin-top: 16px; border-top: 1px solid var(--border-default); padding-top: 12px;">
          <button class="btn" @click="showAddModal = false">İptal</button>
          <button class="btn primary" :disabled="addingSource || !newSourceUrl.trim()" @click="handleAddSource">
            {{ addingSource ? 'Kontrol Ediliyor…' : 'Projeyi Ekle' }}
          </button>
        </div>
      </div>
    </div>

    <!-- Modal: Toplu Etiket Ata / Kaldır -->
    <div v-if="showBulkTagModal" class="backdrop" @click.self="showBulkTagModal = null">
      <div class="modal" style="max-width: 440px;">
        <div style="display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid var(--border-default); padding-bottom: 10px;">
          <h3 style="margin: 0; color: #fff; font-size: 16px;">
            {{ showBulkTagModal === 'assign' ? 'Toplu Etikete Ata' : 'Toplu Etiketten Kaldır' }}
          </h3>
          <button class="btn" style="padding: 2px 8px;" @click="showBulkTagModal = null">✕</button>
        </div>

        <p style="font-size: 13px; color: var(--text-muted); margin: 12px 0 6px;">
          Seçilen <b>{{ picked.size }}</b> proje için işlem yapılacak:
        </p>

        <div style="margin: 10px 0;">
          <label style="font-size: 11px; font-weight: 700; color: var(--text-subtle); text-transform: uppercase;">
            Hedef Etiket:
          </label>
          <select
            v-model="bulkTargetTagId"
            class="search-input"
            style="margin-top: 4px; padding: 6px 10px;"
          >
            <option :value="null">Bir etiket seçin…</option>
            <option v-for="tag in tags" :key="tag.id" :value="tag.id">
              {{ tag.name }} ({{ tag.entries.toLocaleString('tr') }})
            </option>
          </select>
        </div>

        <div style="display: flex; justify-content: flex-end; gap: 8px; margin-top: 16px; border-top: 1px solid var(--border-default); padding-top: 12px;">
          <button class="btn" @click="showBulkTagModal = null">İptal</button>
          <button
            class="btn primary"
            :disabled="bulkTargetTagId === null"
            @click="applyBulkTag"
          >
            {{ showBulkTagModal === 'assign' ? 'Etikete Ata' : 'Etiketten Kaldır' }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.text-success { color: #34d399 !important; }
.text-warning { color: #fbbf24 !important; }
.text-danger { color: #f87171 !important; }

/* Global Refreshing State */
.data-table-container.is-refreshing-all {
  position: relative;
  pointer-events: none;
}

.data-table-container.is-refreshing-all table.data-table {
  opacity: 0.55;
  user-select: none;
  cursor: not-allowed;
  transition: opacity 0.25s ease;
}

tr.row-disabled {
  opacity: 0.6;
  cursor: not-allowed !important;
}

tr.row-disabled button,
tr.row-disabled input {
  cursor: not-allowed !important;
  pointer-events: none;
}

/* Inline Spinner */
.inline-spinner {
  display: inline-block;
  width: 12px;
  height: 12px;
  border: 2px solid rgba(255, 255, 255, 0.25);
  border-radius: 50%;
  border-top-color: var(--accent-mint, #5eead4);
  animation: spin 0.7s linear infinite;
  flex-shrink: 0;
}
@keyframes spin {
  to { transform: rotate(360deg); }
}

/* Row Tags & Add Tag Popover */
.row-tags-wrapper {
  display: flex;
  gap: 4px;
  flex-wrap: wrap;
  align-items: center;
}

.tag-pill {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding-right: 4px;
}

.tag-del-btn {
  background: transparent;
  border: none;
  color: inherit;
  cursor: pointer;
  padding: 0 3px;
  font-size: 13px;
  font-weight: 700;
  line-height: 1;
  border-radius: 3px;
  opacity: 0.65;
  transition: opacity 0.15s, background-color 0.15s;
}

.tag-del-btn:hover {
  opacity: 1;
  background-color: rgba(0, 0, 0, 0.25);
}

.add-tag-wrapper {
  position: relative;
  display: inline-flex;
  align-items: center;
}

.add-tag-trigger-btn {
  width: 20px;
  height: 20px;
  border-radius: 4px;
  border: 1px dashed var(--border-default, #2a3a37);
  background: var(--bg-surface, #141f1d);
  color: var(--text-subtle, #627b75);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  font-size: 13px;
  font-weight: 700;
  line-height: 1;
  transition: all 0.15s ease;
  padding: 0;
}

.add-tag-trigger-btn:hover {
  border-color: var(--accent-mint, #5eead4);
  color: var(--accent-mint, #5eead4);
  background: var(--bg-hover, #1d2d2a);
}

.tag-dropdown-menu {
  position: absolute;
  top: 100%;
  left: 0;
  margin-top: 4px;
  min-width: 150px;
  max-height: 180px;
  overflow-y: auto;
  background: var(--bg-surface-elevated, #1b2624);
  border: 1px solid var(--border-default, #2a3a37);
  border-radius: 6px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.5);
  padding: 4px;
  z-index: 100;
}

.tag-dropdown-header {
  font-size: 10px;
  font-weight: 700;
  color: var(--text-muted, #93a9a4);
  text-transform: uppercase;
  padding: 4px 8px;
  border-bottom: 1px solid var(--border-default, #2a3a37);
  margin-bottom: 4px;
}

.tag-dropdown-empty {
  font-size: 11px;
  color: var(--text-muted, #93a9a4);
  padding: 8px;
  text-align: center;
}

.tag-dropdown-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.tag-dropdown-item {
  width: 100%;
  text-align: left;
  background: none;
  border: none;
  padding: 6px 8px;
  border-radius: 4px;
  color: var(--text-default, #d9e6e3);
  font-size: 12px;
  cursor: pointer;
  transition: background-color 0.15s, color 0.15s;
}

.tag-dropdown-item:hover {
  background-color: var(--bg-hover, #1d2d2a);
  color: var(--accent-mint, #5eead4);
}
</style>
