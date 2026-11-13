<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import {
  getQueueWorkerStatus,
  scanQueuePreview,
  startQueueWorker,
  stopQueueWorker,
  type QueueTargetPreview,
  type QueueWorkerConfig,
  type QueueWorkerState,
} from './api.ts';
import { notify } from './notify.ts';

const state = ref<QueueWorkerState>({
  running: false,
  phase: 'idle',
  mode: 'dry_run',
  targetsTotal: 0,
  targetsCompleted: 0,
  currentProject: '',
  currentQueue: '',
  rowsTotal: 0,
  rowsProcessed: 0,
  approved: 0,
  rejected: 0,
  skipped: 0,
  logs: [],
});

const config = ref<QueueWorkerConfig>({
  family: 'all',
  mode: 'dry_run',
  autoApprove: true,
  autoReject: true,
});

const previewTargets = ref<QueueTargetPreview[]>([]);
const scanningPreview = ref(false);
const startingWorker = ref(false);
const stoppingWorker = ref(false);
const logContainer = ref<HTMLElement | null>(null);
let pollTimer: ReturnType<typeof setInterval> | null = null;

watch(
  () => state.value.logs.length,
  async () => {
    await nextTick();
    if (logContainer.value) {
      logContainer.value.scrollTop = logContainer.value.scrollHeight;
    }
  },
);

const isRunning = computed(() => state.value.running);

const progressPercent = computed(() => {
  if (state.value.targetsTotal === 0) return 0;
  return Math.min(100, Math.round((state.value.targetsCompleted / state.value.targetsTotal) * 100));
});

const phaseLabel = computed(() => {
  switch (state.value.phase) {
    case 'scanning':
      return 'Kuyruklar Taranıyor…';
    case 'working':
      return 'İnceleniyor (Çalışıyor)';
    case 'done':
      return 'Tamamlandı';
    case 'stopped':
      return 'Durduruldu';
    case 'error':
      return 'Hata Oluştu';
    default:
      return 'Boşta (Hazır)';
  }
});

const phaseClass = computed(() => {
  switch (state.value.phase) {
    case 'working':
    case 'scanning':
      return 'waiting';
    case 'done':
      return 'ok';
    case 'error':
      return 'danger';
    case 'stopped':
      return 'muted';
    default:
      return 'muted';
  }
});

async function refreshStatus(): Promise<void> {
  try {
    state.value = await getQueueWorkerStatus();
  } catch (err: unknown) {
    // Silent on network poll fail
  }
}

async function handleScanPreview(): Promise<void> {
  scanningPreview.value = true;
  try {
    const res = await scanQueuePreview(config.value.family);
    previewTargets.value = res.targets;
    if (res.targets.length === 0) {
      notify('ok', 'Bekleyen veya fuzzy girdisi olan proje bulunamadı.');
    } else {
      const totalCount = res.targets.reduce((acc, t) => acc + t.count, 0);
      notify('ok', `${res.targets.length} bekleme kuyruğu (${totalCount} bekleyen girdi) bulundu.`);
    }
  } catch (err: unknown) {
    notify('error', 'Kuyruklar taranamadı: ' + (err instanceof Error ? err.message : String(err)));
  } finally {
    scanningPreview.value = false;
  }
}

async function handleStart(): Promise<void> {
  startingWorker.value = true;
  try {
    state.value = await startQueueWorker(config.value);
    notify('ok', `Kuyruk tarayıcısı başlatıldı (${config.value.mode === 'apply' ? 'Canlı Mod' : 'Simülasyon'}).`);
  } catch (err: unknown) {
    notify('error', 'Tarayıcı başlatılamadı: ' + (err instanceof Error ? err.message : String(err)));
  } finally {
    startingWorker.value = false;
  }
}

async function handleStop(): Promise<void> {
  stoppingWorker.value = true;
  try {
    state.value = await stopQueueWorker();
    notify('ok', 'Kuyruk tarayıcısı durduruldu.');
  } catch (err: unknown) {
    notify('error', 'Durdurulamadı: ' + (err instanceof Error ? err.message : String(err)));
  } finally {
    stoppingWorker.value = false;
  }
}

function clearLogs(): void {
  state.value.logs = [];
}

onMounted(() => {
  void refreshStatus();
  pollTimer = setInterval(refreshStatus, 2000);
});

onUnmounted(() => {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
});
</script>

<template>
  <div class="page-layout">
    <div class="page-header">
      <div>
        <h1 class="page-title">WP.org Bekleyen Kuyruk Tarayıcısı</h1>
        <p class="page-desc">
          translate.wordpress.org üzerindeki birikmiş bekleyen (waiting) ve belirsiz (fuzzy) önerileri yerel sözlük, terim bankası, üslup kuralları ve AI ile arka planda inceler.
        </p>
      </div>
      <div style="display: flex; align-items: center; gap: 10px;">
        <span class="status-pill" :class="phaseClass" style="font-size: 13px; padding: 6px 12px;">
          <span v-if="isRunning" class="inline-spinner" style="margin-right: 6px;"></span>
          {{ phaseLabel }}
        </span>
        <button
          v-if="isRunning"
          class="btn danger"
          :disabled="stoppingWorker"
          @click="handleStop"
        >
          {{ stoppingWorker ? 'Durduruluyor…' : '⏹️ Taramayı Durdur' }}
        </button>
      </div>
    </div>

    <!-- Yapılandırma Kartı -->
    <div class="agent-card" style="margin-bottom: 24px; border: 1px solid var(--border-default); background: var(--bg-surface);">
      <div class="agent-card-header" style="border-bottom: 1px solid var(--border-default); padding-bottom: 12px; margin-bottom: 16px;">
        <div class="agent-name-wrap">
          <span style="font-size: 24px;">⚙️</span>
          <div>
            <div class="agent-name" style="font-size: 15px;">Tarama & Karar Parametreleri</div>
            <div style="font-size: 12px; color: var(--text-muted);">
              Tarayıcının hangi projeleri ele alacağını ve kararların nasıl uygulanacağını belirleyin.
            </div>
          </div>
        </div>
      </div>

      <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 20px;">
        <!-- Kapsam -->
        <div>
          <label style="font-size: 12px; font-weight: 600; display: block; margin-bottom: 6px; color: var(--text-subtle);">
            TARAMA KAPSAMI
          </label>
          <div style="display: flex; gap: 8px;">
            <label class="check" style="font-size: 13px; cursor: pointer; display: inline-flex; align-items: center; gap: 6px;">
              <input v-model="config.family" type="radio" value="all" :disabled="isRunning" />
              Tümü (Eklenti + Tema)
            </label>
            <label class="check" style="font-size: 13px; cursor: pointer; display: inline-flex; align-items: center; gap: 6px;">
              <input v-model="config.family" type="radio" value="plugin" :disabled="isRunning" />
              Eklentiler
            </label>
            <label class="check" style="font-size: 13px; cursor: pointer; display: inline-flex; align-items: center; gap: 6px;">
              <input v-model="config.family" type="radio" value="theme" :disabled="isRunning" />
              Temalar
            </label>
          </div>
        </div>

        <!-- Çalışma Modu -->
        <div>
          <label style="font-size: 12px; font-weight: 600; display: block; margin-bottom: 6px; color: var(--text-subtle);">
            ÇALIŞMA MODU
          </label>
          <div style="display: flex; gap: 12px;">
            <label class="check" style="font-size: 13px; cursor: pointer; display: inline-flex; align-items: center; gap: 6px;">
              <input v-model="config.mode" type="radio" value="dry_run" :disabled="isRunning" />
              🛡️ Simülasyon (Dry-Run)
            </label>
            <label class="check" style="font-size: 13px; cursor: pointer; display: inline-flex; align-items: center; gap: 6px;">
              <input v-model="config.mode" type="radio" value="apply" :disabled="isRunning" />
              🚀 Canlı Uygula (WP.org'a Yaz)
            </label>
          </div>
        </div>
      </div>

      <!-- İşlem Seçenekleri -->
      <div style="margin-top: 16px; padding-top: 14px; border-top: 1px dashed var(--border-default); display: flex; flex-wrap: wrap; gap: 20px; align-items: center;">
        <label class="check" style="font-size: 13px; cursor: pointer; display: inline-flex; align-items: center; gap: 6px;">
          <input v-model="config.autoApprove" type="checkbox" :disabled="isRunning" />
          Sözlük/AI onay verdiklerini onayla (<code>current</code>)
        </label>
        <label class="check" style="font-size: 13px; cursor: pointer; display: inline-flex; align-items: center; gap: 6px;">
          <input v-model="config.autoReject" type="checkbox" :disabled="isRunning" />
          Kural/kalite ihlali olanları reddet (<code>rejected</code>)
        </label>
        <span style="font-size: 11px; color: var(--text-muted); margin-left: auto;">
          ℹ️ Kararsız veya şüpheli kalan dizgeler hiçbir zaman otomatik reddedilmez; kuyrukta bırakılır.
        </span>
      </div>

      <!-- Eylem Butonları -->
      <div style="margin-top: 18px; display: flex; gap: 10px; align-items: center;">
        <button
          class="btn primary"
          :disabled="isRunning || startingWorker"
          style="background: #2563eb; border-color: #3b82f6; padding: 7px 16px; font-weight: 600;"
          @click="handleStart"
        >
          <span v-if="startingWorker" class="inline-spinner" style="margin-right: 6px;"></span>
          <span v-else style="margin-right: 6px;">▶️</span>
          {{ config.mode === 'apply' ? 'Canlı Taramayı Başlat' : 'Simülasyonu Başlat (Dry-Run)' }}
        </button>

        <button
          class="btn"
          :disabled="isRunning || scanningPreview"
          style="padding: 7px 14px;"
          @click="handleScanPreview"
        >
          <span v-if="scanningPreview" class="inline-spinner" style="margin-right: 6px;"></span>
          <span v-else style="margin-right: 6px;">🔍</span>
          Kuyrukları Önizle / Tara
        </button>
      </div>
    </div>

    <!-- Önizleme Listesi (Varsa) -->
    <div v-if="previewTargets.length > 0 && !isRunning" class="agent-card" style="margin-bottom: 24px; border: 1px solid var(--border-default); background: var(--bg-surface);">
      <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px;">
        <div style="font-weight: 600; font-size: 14px;">
          Tespit Edilen Bekleme Kuyrukları ({{ previewTargets.length }} Proje)
        </div>
        <button class="btn" style="padding: 2px 8px; font-size: 11px;" @click="previewTargets = []">Kapat</button>
      </div>
      <table class="table" style="width: 100%; font-size: 12px;">
        <thead>
          <tr style="text-align: left; color: var(--text-muted); border-bottom: 1px solid var(--border-default);">
            <th style="padding: 6px 8px;">Tür</th>
            <th style="padding: 6px 8px;">Proje Adı</th>
            <th style="padding: 6px 8px;">Alt Proje</th>
            <th style="padding: 6px 8px;">Kuyruk Tipi</th>
            <th style="padding: 6px 8px;">Girdi Sayısı</th>
            <th style="padding: 6px 8px; text-align: right;">Bağlantı</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="t in previewTargets" :key="t.queueUrl" style="border-bottom: 1px solid var(--border-subtle);">
            <td style="padding: 6px 8px; text-transform: uppercase; font-weight: 600; color: var(--text-subtle);">
              {{ t.family === 'plugin' ? 'Eklenti' : 'Tema' }}
            </td>
            <td style="padding: 6px 8px; font-weight: 500;">{{ t.name }}</td>
            <td style="padding: 6px 8px; color: var(--text-muted);">{{ t.subProject || 'Ana Proje' }}</td>
            <td style="padding: 6px 8px;">
              <span class="status-pill" :class="t.status === 'waiting' ? 'waiting' : 'muted'" style="font-size: 11px; padding: 2px 6px;">
                {{ t.status }}
              </span>
            </td>
            <td style="padding: 6px 8px; font-weight: 600;">{{ t.count.toLocaleString('tr') }}</td>
            <td style="padding: 6px 8px; text-align: right;">
              <a :href="t.queueUrl" target="_blank" rel="noopener" style="color: #3b82f6; text-decoration: none;">
                wp.org ↗
              </a>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <!-- Canlı Durum ve İstatistik Kartları -->
    <div v-if="state.phase !== 'idle'" class="agent-card" style="margin-bottom: 24px; border: 1px solid var(--border-default); background: var(--bg-surface);">
      <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 14px;">
        <div style="font-weight: 600; font-size: 15px;">
          İnceleme Durumu
          <span style="font-size: 12px; font-weight: 400; color: var(--text-muted); margin-left: 8px;">
            Mod: {{ state.mode === 'apply' ? 'Canlı Uygulama' : 'Simülasyon (Dry-Run)' }}
          </span>
        </div>
        <div style="font-size: 13px; font-weight: 600;">
          {{ progressPercent }}%
        </div>
      </div>

      <!-- İlerleme Çubuğu -->
      <div style="width: 100%; height: 8px; background: var(--bg-canvas, #1f2937); border-radius: 4px; overflow: hidden; margin-bottom: 16px;">
        <div
          style="height: 100%; background: #3b82f6; transition: width 0.3s ease;"
          :style="{ width: `${progressPercent}%` }"
        ></div>
      </div>

      <!-- İstatistik Sayaçları -->
      <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(130px, 1fr)); gap: 12px; margin-bottom: 14px;">
        <div style="padding: 10px; background: var(--bg-subtle, #1a202c); border-radius: 6px; text-align: center;">
          <div style="font-size: 11px; color: var(--text-muted); text-transform: uppercase;">Kuyruklar</div>
          <div style="font-size: 20px; font-weight: 700; margin-top: 2px;">
            {{ state.targetsCompleted }} / {{ state.targetsTotal }}
          </div>
        </div>

        <div style="padding: 10px; background: var(--bg-subtle, #1a202c); border-radius: 6px; text-align: center;">
          <div style="font-size: 11px; color: var(--text-muted); text-transform: uppercase;">İşlenen Dizge</div>
          <div style="font-size: 20px; font-weight: 700; margin-top: 2px;">
            {{ state.rowsProcessed.toLocaleString('tr') }}
          </div>
        </div>

        <div style="padding: 10px; background: rgba(34, 197, 94, 0.1); border: 1px solid rgba(34, 197, 94, 0.2); border-radius: 6px; text-align: center;">
          <div style="font-size: 11px; color: #22c55e; text-transform: uppercase; font-weight: 600;">
            {{ state.mode === 'apply' ? 'Onaylanan' : 'Onay Adayı' }}
          </div>
          <div style="font-size: 20px; font-weight: 700; color: #22c55e; margin-top: 2px;">
            {{ state.approved.toLocaleString('tr') }}
          </div>
        </div>

        <div style="padding: 10px; background: rgba(239, 68, 68, 0.1); border: 1px solid rgba(239, 68, 68, 0.2); border-radius: 6px; text-align: center;">
          <div style="font-size: 11px; color: #ef4444; text-transform: uppercase; font-weight: 600;">
            {{ state.mode === 'apply' ? 'Reddedilen' : 'Ret Adayı' }}
          </div>
          <div style="font-size: 20px; font-weight: 700; color: #ef4444; margin-top: 2px;">
            {{ state.rejected.toLocaleString('tr') }}
          </div>
        </div>

        <div style="padding: 10px; background: var(--bg-subtle, #1a202c); border-radius: 6px; text-align: center;">
          <div style="font-size: 11px; color: var(--text-muted); text-transform: uppercase;">Atlanan / Kararsız</div>
          <div style="font-size: 20px; font-weight: 700; color: var(--text-muted); margin-top: 2px;">
            {{ state.skipped.toLocaleString('tr') }}
          </div>
        </div>
      </div>

      <!-- Şu anki proje -->
      <div v-if="state.currentProject" style="font-size: 12px; color: var(--text-muted); display: flex; align-items: center; gap: 8px;">
        <span style="font-weight: 600; color: var(--text-default);">Aktif Proje:</span>
        <span>{{ state.currentProject }}</span>
        <a v-if="state.currentQueue" :href="state.currentQueue" target="_blank" rel="noopener" style="color: #3b82f6; text-decoration: none;">
          [Kuyruğu Aç ↗]
        </a>
      </div>
    </div>

    <!-- Canlı İşlem Günlüğü (Console Log) -->
    <div class="agent-card" style="border: 1px solid var(--border-default); background: var(--bg-surface);">
      <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px;">
        <div style="font-weight: 600; font-size: 14px; display: flex; align-items: center; gap: 8px;">
          <span>📋 Canlı İşlem Akışı</span>
          <span v-if="state.logs.length > 0" class="status-pill muted" style="font-size: 10px; padding: 1px 6px;">
            {{ state.logs.length }} kayıt
          </span>
        </div>
        <button
          class="btn"
          style="padding: 2px 8px; font-size: 11px;"
          :disabled="state.logs.length === 0"
          @click="clearLogs"
        >
          Temizle
        </button>
      </div>

      <div
        ref="logContainer"
        style="
          height: 320px;
          overflow-y: auto;
          background: #0d1117;
          border: 1px solid var(--border-default);
          border-radius: 6px;
          padding: 10px;
          font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
          font-size: 12px;
          line-height: 1.5;
        "
      >
        <div v-if="state.logs.length === 0" style="color: #6e7681; font-style: italic; padding: 20px; text-align: center;">
          Henüz işlem kaydı yok. "Taramayı Başlat" ile işlem akışını buradan izleyebilirsiniz.
        </div>
        <div
          v-for="(log, idx) in state.logs"
          :key="idx"
          style="margin-bottom: 4px; display: flex; gap: 8px;"
        >
          <span style="color: #6e7681; flex-shrink: 0;">[{{ log.time }}]</span>
          <span
            :style="{
              color:
                log.level === 'success'
                  ? '#3fb950'
                  : log.level === 'warn'
                    ? '#d29922'
                    : log.level === 'error'
                      ? '#f85149'
                      : '#8b949e',
            }"
          >
            {{ log.text }}
          </span>
        </div>
      </div>
    </div>
  </div>
</template>
