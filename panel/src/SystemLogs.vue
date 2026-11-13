<script setup lang="ts">
import { ref, onMounted, watch } from 'vue';
import { fetchLogs, clearLogs, type SystemLog } from './api.ts';

const loading = ref(false);
const logs = ref<SystemLog[]>([]);
const total = ref(0);

const filterLevel = ref<'all' | 'error' | 'warn' | 'info'>('all');
const filterCategory = ref('all');
const search = ref('');
const page = ref(1);
const limit = 50;

const expandedLogId = ref<number | null>(null);

async function loadLogs() {
  loading.value = true;
  try {
    const res = await fetchLogs({
      level: filterLevel.value === 'all' ? undefined : filterLevel.value,
      category: filterCategory.value === 'all' ? undefined : filterCategory.value,
      search: search.value.trim() || undefined,
      limit,
      offset: (page.value - 1) * limit,
    });
    logs.value = res.entries;
    total.value = res.total;
  } catch (err) {
    console.error('Failed to load logs:', err);
  } finally {
    loading.value = false;
  }
}

onMounted(() => {
  loadLogs();
});

watch([filterLevel, filterCategory, page], () => {
  loadLogs();
});

function handleSearch() {
  page.value = 1;
  loadLogs();
}

function clearSearch() {
  search.value = '';
  page.value = 1;
  loadLogs();
}

function toggleExpand(id: number) {
  expandedLogId.value = expandedLogId.value === id ? null : id;
}

async function handleClearLogs() {
  if (!confirm('Tüm sistem günlük kayıtlarını silmek istediğinize emin misiniz?')) return;
  await clearLogs();
  await loadLogs();
}

function formatDate(dateStr: string): string {
  try {
    const d = new Date(dateStr);
    return d.toLocaleString('tr-TR', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  } catch {
    return dateStr;
  }
}
</script>

<template>
  <div class="workspace-screen" style="display: flex; flex-direction: column; height: 100%; overflow: hidden; padding: 24px 32px; background: var(--bg-workspace);">
    <!-- Header -->
    <header style="margin-bottom: 20px;">
      <div style="display: flex; align-items: center; justify-content: space-between;">
        <div>
          <h1 style="font-size: 20px; font-weight: 700; color: var(--text-heading); margin: 0 0 4px 0; display: flex; align-items: center; gap: 8px;">
            <span>Sistem Günlüğü & Hatalar</span>
            <span style="font-size: 13px; font-weight: 500; color: var(--text-dim); background: var(--bg-surface-elevated); padding: 2px 8px; border-radius: 12px; border: 1px solid var(--border-subtle);">
              {{ total.toLocaleString('tr') }} Kayıt
            </span>
          </h1>
          <p style="font-size: 13px; color: var(--text-dim); margin: 0;">
            GlotPress şablon uyuşmazlıkları, model kota/hata durumları ve arka plan işlemlerinin detaylı günlüğü (Son 7 gün otomatik saklanır).
          </p>
        </div>

        <div style="display: flex; gap: 8px;">
          <button class="btn btn-secondary" style="padding: 6px 12px; font-size: 12px;" @click="loadLogs">
            ↻ Yenile
          </button>
          <button
            class="btn btn-secondary"
            style="padding: 6px 12px; font-size: 12px; border: 1px solid var(--border-default); border-radius: 6px; background: transparent; color: var(--text-dim); cursor: pointer;"
            @click="handleClearLogs"
          >
            Günlükleri Temizle
          </button>
        </div>
      </div>
    </header>

    <!-- Toolbar Filters -->
    <div style="display: flex; align-items: center; justify-content: space-between; gap: 16px; margin-bottom: 16px; background: var(--bg-surface); padding: 12px 16px; border-radius: 8px; border: 1px solid var(--border-default);">
      <!-- Level Tabs -->
      <div style="display: flex; gap: 4px; background: var(--bg-surface-elevated); padding: 3px; border-radius: 6px; border: 1px solid var(--border-subtle);">
        <button
          class="btn-tab"
          :class="{ active: filterLevel === 'all' }"
          @click="filterLevel = 'all'; page = 1"
          style="padding: 4px 12px; font-size: 12px; border-radius: 4px; border: none; background: transparent; cursor: pointer; color: var(--text-default);"
        >
          Tümü
        </button>
        <button
          class="btn-tab"
          :class="{ active: filterLevel === 'error' }"
          @click="filterLevel = 'error'; page = 1"
          style="padding: 4px 12px; font-size: 12px; border-radius: 4px; border: none; background: transparent; cursor: pointer; color: #ef4444;"
        >
          Hatalar
        </button>
        <button
          class="btn-tab"
          :class="{ active: filterLevel === 'warn' }"
          @click="filterLevel = 'warn'; page = 1"
          style="padding: 4px 12px; font-size: 12px; border-radius: 4px; border: none; background: transparent; cursor: pointer; color: #f59e0b;"
        >
          Uyarılar
        </button>
        <button
          class="btn-tab"
          :class="{ active: filterLevel === 'info' }"
          @click="filterLevel = 'info'; page = 1"
          style="padding: 4px 12px; font-size: 12px; border-radius: 4px; border: none; background: transparent; cursor: pointer; color: #3b82f6;"
        >
          Bilgi
        </button>
      </div>

      <!-- Category Filter -->
      <div style="display: flex; align-items: center; gap: 8px;">
        <label style="font-size: 12px; color: var(--text-dim);">Kategori:</label>
        <select
          v-model="filterCategory"
          style="padding: 6px 10px; font-size: 12px; background: var(--bg-surface-elevated); border: 1px solid var(--border-default); border-radius: 6px; color: var(--text-default);"
        >
          <option value="all">Tüm Kategoriler</option>
          <option value="glotpress">GlotPress & Web</option>
          <option value="queue_worker">Kuyruk Denetimi</option>
          <option value="engine">AI Motoru</option>
          <option value="system">Sistem</option>
          <option value="sync">Senkronizasyon</option>
        </select>
      </div>

      <!-- Search Box -->
      <div style="display: flex; align-items: center; gap: 8px; flex: 1; max-width: 380px;">
        <input
          v-model="search"
          type="text"
          placeholder="Hata mesajı veya detaylarda ara..."
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
    </div>

    <!-- Logs Table -->
    <div style="flex: 1; overflow: auto; background: var(--bg-surface); border: 1px solid var(--border-default); border-radius: 8px;">
      <table style="width: 100%; border-collapse: collapse; font-size: 13px; text-align: left;">
        <thead>
          <tr style="background: var(--bg-surface-elevated); border-bottom: 1px solid var(--border-default); color: var(--text-dim); font-size: 11px; text-transform: uppercase;">
            <th style="width: 90px; padding: 10px 12px;">Düzey</th>
            <th style="width: 160px; padding: 10px 12px;">Zaman</th>
            <th style="width: 130px; padding: 10px 12px;">Kategori</th>
            <th style="padding: 10px 12px;">Mesaj</th>
            <th style="width: 80px; padding: 10px 12px; text-align: right;">Detay</th>
          </tr>
        </thead>
        <tbody>
          <tr v-if="loading">
            <td colspan="5" style="padding: 32px; text-align: center; color: var(--text-dim);">
              Günlük kayıtları yükleniyor...
            </td>
          </tr>
          <tr v-else-if="logs.length === 0">
            <td colspan="5" style="padding: 32px; text-align: center; color: var(--text-dim);">
              Filtreye uygun günlük kaydı bulunamadı.
            </td>
          </tr>
          <template v-for="l in logs" :key="l.id">
            <tr style="border-bottom: 1px solid var(--border-subtle);">
              <td style="padding: 10px 12px;">
                <span
                  v-if="l.level === 'error'"
                  style="display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: 11px; font-weight: 700; background: rgba(239, 68, 68, 0.15); color: #ef4444;"
                >
                  HATA
                </span>
                <span
                  v-else-if="l.level === 'warn'"
                  style="display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: 11px; font-weight: 700; background: rgba(245, 158, 11, 0.15); color: #f59e0b;"
                >
                  UYARI
                </span>
                <span
                  v-else
                  style="display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: 11px; font-weight: 700; background: rgba(59, 130, 246, 0.15); color: #3b82f6;"
                >
                  BİLGİ
                </span>
              </td>
              <td style="padding: 10px 12px; font-family: monospace; font-size: 12px; color: var(--text-dim);">
                {{ formatDate(l.createdAt) }}
              </td>
              <td style="padding: 10px 12px;">
                <span style="font-size: 12px; color: var(--text-default); background: var(--bg-surface-elevated); padding: 2px 6px; border-radius: 4px; border: 1px solid var(--border-subtle);">
                  {{ l.category }}
                </span>
              </td>
              <td style="padding: 10px 12px; color: var(--text-heading); word-break: break-word;">
                {{ l.message }}
              </td>
              <td style="padding: 10px 12px; text-align: right;">
                <button
                  v-if="l.details"
                  class="btn btn-secondary"
                  style="padding: 3px 8px; font-size: 11px;"
                  @click="toggleExpand(l.id)"
                >
                  {{ expandedLogId === l.id ? 'Gizle' : 'Göster' }}
                </button>
              </td>
            </tr>
            <tr v-if="expandedLogId === l.id && l.details" style="background: var(--bg-surface-elevated); border-bottom: 1px solid var(--border-default);">
              <td colspan="5" style="padding: 12px 16px;">
                <pre style="margin: 0; font-family: monospace; font-size: 12px; color: var(--text-default); white-space: pre-wrap; word-break: break-all; max-height: 240px; overflow: auto; background: var(--bg-workspace); padding: 12px; border-radius: 6px; border: 1px solid var(--border-subtle);">{{ l.details }}</pre>
              </td>
            </tr>
          </template>
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
  font-weight: 700;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.2);
}
</style>
