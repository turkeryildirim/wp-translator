<script setup lang="ts">
import { ref, onMounted, watch } from 'vue';
import {
  fetchMemory,
  deleteMemoryItem,
  deleteMemoryBulk,
  clearAllMemory,
  type MemoryEntry,
  type MemoryCounts,
} from './api.ts';

const loading = ref(false);
const entries = ref<MemoryEntry[]>([]);
const total = ref(0);
const counts = ref<MemoryCounts>({ translation: 0, judgement: 0, reuses: 0 });

const filterKind = ref<'all' | 'translation' | 'judgement'>('all');
const search = ref('');
const page = ref(1);
const limit = 50;

const selectedIds = ref<Set<number>>(new Set());

async function loadData() {
  loading.value = true;
  selectedIds.value.clear();
  try {
    const res = await fetchMemory({
      kind: filterKind.value === 'all' ? undefined : filterKind.value,
      search: search.value.trim() || undefined,
      limit,
      offset: (page.value - 1) * limit,
    });
    entries.value = res.entries;
    total.value = res.total;
    counts.value = res.counts;
  } catch (err) {
    console.error('Failed to load memory:', err);
  } finally {
    loading.value = false;
  }
}

onMounted(() => {
  loadData();
});

watch([filterKind, page], () => {
  loadData();
});

function handleSearch() {
  page.value = 1;
  loadData();
}

function clearSearch() {
  search.value = '';
  page.value = 1;
  loadData();
}

function toggleSelectAll(event: Event) {
  const checked = (event.target as HTMLInputElement).checked;
  if (checked) {
    for (const e of entries.value) {
      selectedIds.value.add(e.id);
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

async function handleDelete(id: number) {
  if (!confirm('Bu hafıza kaydını silmek istediğinize emin misiniz?')) return;
  await deleteMemoryItem(id);
  await loadData();
}

async function handleDeleteSelected() {
  const ids = Array.from(selectedIds.value);
  if (ids.length === 0) return;
  if (!confirm(`Seçilen ${ids.length} hafıza kaydını silmek istediğinize emin misiniz?`)) return;
  await deleteMemoryBulk(ids);
  selectedIds.value.clear();
  await loadData();
}

async function handleClearAll() {
  const label = filterKind.value === 'all' ? 'tüm' : filterKind.value === 'translation' ? 'tüm çeviri' : 'tüm değerlendirme';
  if (!confirm(`Hafızadaki ${label} kayıtları kalıcı olarak silmek istediğinize emin misiniz?`)) return;
  await clearAllMemory(filterKind.value === 'all' ? undefined : filterKind.value);
  selectedIds.value.clear();
  await loadData();
}

function formatAnswer(entry: MemoryEntry): string {
  if (!entry.answer) return '';
  if (entry.kind === 'translation') {
    if (typeof entry.answer === 'string') return entry.answer;
    if (typeof entry.answer === 'object' && 'translation' in entry.answer) {
      return String(entry.answer.translation);
    }
    return JSON.stringify(entry.answer);
  }
  if (entry.kind === 'judgement') {
    if (typeof entry.answer === 'object') {
      const v = (entry.answer.verdict ?? '').toUpperCase();
      const r = entry.answer.reason ? ` - ${entry.answer.reason}` : '';
      return `${v}${r}`;
    }
    return String(entry.answer);
  }
  return String(entry.answer);
}
</script>

<template>
  <div class="workspace-screen" style="display: flex; flex-direction: column; height: 100%; overflow: hidden; padding: 24px 32px; background: var(--bg-workspace);">
    <!-- Top Header -->
    <header style="margin-bottom: 20px;">
      <div style="display: flex; align-items: center; justify-content: space-between;">
        <div>
          <h1 style="font-size: 20px; font-weight: 700; color: var(--text-heading); margin: 0 0 4px 0; display: flex; align-items: center; gap: 8px;">
            <span>AI Belleği (Memory)</span>
            <span style="font-size: 13px; font-weight: 500; color: var(--text-dim); background: var(--bg-surface-elevated); padding: 2px 8px; border-radius: 12px; border: 1px solid var(--border-subtle);">
              {{ total.toLocaleString('tr') }} Kayıt
            </span>
          </h1>
          <p style="font-size: 13px; color: var(--text-dim); margin: 0;">
            Modelin ürettiği ve yeniden kullanılan çeviri ve değerlendirme önbelleği. İstenmeyen veya hatalı cevapları buradan temizleyebilirsiniz.
          </p>
        </div>

        <!-- Stat Badges -->
        <div style="display: flex; gap: 12px;">
          <div class="stat-card" style="padding: 8px 14px; background: var(--bg-surface); border: 1px solid var(--border-default); border-radius: 8px;">
            <div style="font-size: 11px; text-transform: uppercase; color: var(--text-dim); font-weight: 600;">Çeviriler</div>
            <div style="font-size: 16px; font-weight: 700; color: var(--accent-emerald);">{{ counts.translation.toLocaleString('tr') }}</div>
          </div>
          <div class="stat-card" style="padding: 8px 14px; background: var(--bg-surface); border: 1px solid var(--border-default); border-radius: 8px;">
            <div style="font-size: 11px; text-transform: uppercase; color: var(--text-dim); font-weight: 600;">Değerlendirmeler</div>
            <div style="font-size: 16px; font-weight: 700; color: var(--accent-cyan, #06b6d4);">{{ counts.judgement.toLocaleString('tr') }}</div>
          </div>
          <div class="stat-card" style="padding: 8px 14px; background: var(--bg-surface); border: 1px solid var(--border-default); border-radius: 8px;">
            <div style="font-size: 11px; text-transform: uppercase; color: var(--text-dim); font-weight: 600;">Tasarruf (Kullanım)</div>
            <div style="font-size: 16px; font-weight: 700; color: #a855f7;">{{ counts.reuses.toLocaleString('tr') }}</div>
          </div>
        </div>
      </div>
    </header>

    <!-- Toolbar: Search & Filters -->
    <div style="display: flex; align-items: center; justify-content: space-between; gap: 16px; margin-bottom: 16px; background: var(--bg-surface); padding: 12px 16px; border-radius: 8px; border: 1px solid var(--border-default);">
      <!-- Filter Tabs -->
      <div style="display: flex; gap: 4px; background: var(--bg-surface-elevated); padding: 3px; border-radius: 6px; border: 1px solid var(--border-subtle);">
        <button
          class="btn-tab"
          :class="{ active: filterKind === 'all' }"
          @click="filterKind = 'all'; page = 1"
          style="padding: 4px 12px; font-size: 12px; border-radius: 4px; border: none; background: transparent; cursor: pointer; color: var(--text-default);"
        >
          Tümü ({{ (counts.translation + counts.judgement).toLocaleString('tr') }})
        </button>
        <button
          class="btn-tab"
          :class="{ active: filterKind === 'translation' }"
          @click="filterKind = 'translation'; page = 1"
          style="padding: 4px 12px; font-size: 12px; border-radius: 4px; border: none; background: transparent; cursor: pointer; color: var(--text-default);"
        >
          Çeviriler ({{ counts.translation.toLocaleString('tr') }})
        </button>
        <button
          class="btn-tab"
          :class="{ active: filterKind === 'judgement' }"
          @click="filterKind = 'judgement'; page = 1"
          style="padding: 4px 12px; font-size: 12px; border-radius: 4px; border: none; background: transparent; cursor: pointer; color: var(--text-default);"
        >
          Değerlendirmeler ({{ counts.judgement.toLocaleString('tr') }})
        </button>
      </div>

      <!-- Search Box -->
      <div style="display: flex; align-items: center; gap: 8px; flex: 1; max-width: 420px;">
        <input
          v-model="search"
          type="text"
          placeholder="İngilizce metin veya Türkçe çeviri ara..."
          @keydown.enter="handleSearch"
          style="flex: 1; padding: 6px 12px; font-size: 13px; background: var(--bg-surface-elevated); border: 1px solid var(--border-default); border-radius: 6px; color: var(--text-default);"
        />
        <button class="btn btn-secondary" style="padding: 6px 12px; font-size: 12px;" @click="handleSearch">
          Ara
        </button>
        <button v-if="search" class="btn btn-ghost" style="padding: 6px 8px; font-size: 12px;" @click="clearSearch">
          ✕
        </button>
      </div>

      <!-- Actions -->
      <div style="display: flex; gap: 8px; align-items: center;">
        <button
          v-if="selectedIds.size > 0"
          class="btn btn-danger"
          style="padding: 6px 12px; font-size: 12px; background: #dc2626; color: white; border: none; border-radius: 6px; cursor: pointer;"
          @click="handleDeleteSelected"
        >
          Seçilenleri Sil ({{ selectedIds.size }})
        </button>
        <button
          class="btn btn-secondary"
          style="padding: 6px 12px; font-size: 12px; border: 1px solid var(--border-default); border-radius: 6px; background: transparent; color: var(--text-dim); cursor: pointer;"
          @click="handleClearAll"
        >
          Hafızayı Temizle
        </button>
      </div>
    </div>

    <!-- Memory Table -->
    <div style="flex: 1; overflow: auto; background: var(--bg-surface); border: 1px solid var(--border-default); border-radius: 8px;">
      <table style="width: 100%; border-collapse: collapse; font-size: 13px; text-align: left;">
        <thead>
          <tr style="background: var(--bg-surface-elevated); border-bottom: 1px solid var(--border-default); color: var(--text-dim); font-size: 11px; text-transform: uppercase;">
            <th style="width: 36px; padding: 10px 12px; text-align: center;">
              <input
                type="checkbox"
                :checked="entries.length > 0 && selectedIds.size === entries.length"
                @change="toggleSelectAll"
              />
            </th>
            <th style="width: 110px; padding: 10px 12px;">Tür</th>
            <th style="padding: 10px 12px; width: 35%;">Kaynak Metin</th>
            <th style="padding: 10px 12px; width: 35%;">AI Yanıtı / Kararı</th>
            <th style="width: 140px; padding: 10px 12px;">Model / Kullanım</th>
            <th style="width: 80px; padding: 10px 12px; text-align: right;">İşlem</th>
          </tr>
        </thead>
        <tbody>
          <tr v-if="loading">
            <td colspan="6" style="padding: 32px; text-align: center; color: var(--text-dim);">
              Bellek verileri yükleniyor...
            </td>
          </tr>
          <tr v-else-if="entries.length === 0">
            <td colspan="6" style="padding: 32px; text-align: center; color: var(--text-dim);">
              Bellekte kayıt bulunamadı.
            </td>
          </tr>
          <tr
            v-for="e in entries"
            :key="e.id"
            :style="{ background: selectedIds.has(e.id) ? 'var(--bg-selection, rgba(16, 185, 129, 0.08))' : 'transparent' }"
            style="border-bottom: 1px solid var(--border-subtle);"
          >
            <td style="padding: 10px 12px; text-align: center;">
              <input
                type="checkbox"
                :checked="selectedIds.has(e.id)"
                @change="toggleSelect(e.id)"
              />
            </td>
            <td style="padding: 10px 12px;">
              <span
                v-if="e.kind === 'translation'"
                style="display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: 11px; font-weight: 600; background: rgba(16, 185, 129, 0.15); color: #10b981;"
              >
                Çeviri
              </span>
              <span
                v-else
                style="display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: 11px; font-weight: 600; background: rgba(168, 85, 247, 0.15); color: #c084fc;"
              >
                Karar
              </span>
            </td>
            <td style="padding: 10px 12px; color: var(--text-heading); font-family: inherit; word-break: break-word;">
              {{ e.sourceText }}
            </td>
            <td style="padding: 10px 12px; color: var(--text-default); word-break: break-word;">
              <span v-if="e.kind === 'judgement' && typeof e.answer === 'object'" style="display: flex; align-items: center; gap: 6px;">
                <span
                  :style="{
                    background: e.answer.verdict === 'exact' ? '#10b981' : e.answer.verdict === 'agreed' ? '#3b82f6' : '#ef4444',
                    color: 'white',
                    padding: '1px 6px',
                    borderRadius: '3px',
                    fontSize: '10px',
                    fontWeight: '700'
                  }"
                >
                  {{ (e.answer.verdict ?? '').toUpperCase() }}
                </span>
                <span>{{ e.answer.reason || '' }}</span>
              </span>
              <span v-else>
                {{ formatAnswer(e) }}
              </span>
            </td>
            <td style="padding: 10px 12px; font-size: 12px; color: var(--text-dim);">
              <div style="font-weight: 500; color: var(--text-default);">{{ e.model || 'Bilinmiyor' }}</div>
              <div style="font-size: 11px;">{{ e.uses }} kez kullanıldı</div>
            </td>
            <td style="padding: 10px 12px; text-align: right;">
              <button
                class="btn-icon"
                title="Sil"
                style="background: transparent; border: none; cursor: pointer; color: var(--text-dim); padding: 4px 6px; border-radius: 4px;"
                @click="handleDelete(e.id)"
              >
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <polyline points="3 6 5 6 21 6"></polyline>
                  <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
                </svg>
              </button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <!-- Pagination Footer -->
    <div style="display: flex; align-items: center; justify-content: space-between; margin-top: 14px;">
      <div style="font-size: 12px; color: var(--text-dim);">
        Toplam {{ total.toLocaleString('tr') }} kayıttan {{ Math.min(total, (page - 1) * limit + 1) }} - {{ Math.min(total, page * limit) }} arası gösteriliyor
      </div>
      <div style="display: flex; gap: 8px;">
        <button
          class="btn btn-secondary"
          style="padding: 4px 12px; font-size: 12px;"
          :disabled="page <= 1"
          @click="page--"
        >
          Önceki
        </button>
        <span style="font-size: 12px; color: var(--text-default); display: flex; align-items: center; padding: 0 4px;">
          Sayfa {{ page }} / {{ Math.max(1, Math.ceil(total / limit)) }}
        </span>
        <button
          class="btn btn-secondary"
          style="padding: 4px 12px; font-size: 12px;"
          :disabled="page >= Math.ceil(total / limit)"
          @click="page++"
        >
          Sonraki
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.btn-tab.active {
  background: var(--bg-surface) !important;
  color: var(--text-heading) !important;
  font-weight: 600;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.2);
}
.btn-icon:hover {
  color: #ef4444 !important;
  background: rgba(239, 68, 68, 0.1) !important;
}
</style>
