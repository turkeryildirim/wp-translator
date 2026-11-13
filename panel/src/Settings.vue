<script setup lang="ts">
import { onMounted, ref } from 'vue';
import {
  fetchAiSettings,
  fetchWporgSettings,
  saveAiSettings,
  saveWporgSettings,
  verifyWporgSession,
  type AiAgent,
  type WporgSessionVerification,
} from './api.ts';
import { notify } from './notify.ts';

const agents = ref<AiAgent[]>([]);
const loading = ref(true);
const saving = ref(false);

const wporgCookie = ref('');
const verifyingWporg = ref(false);
const savingWporg = ref(false);
const wporgVerification = ref<WporgSessionVerification | null>(null);

async function load(): Promise<void> {
  loading.value = true;
  try {
    const [aiRes, wporgRes] = await Promise.all([fetchAiSettings(), fetchWporgSettings()]);
    agents.value = aiRes.agents;
    wporgCookie.value = wporgRes.cookie;
    if (wporgCookie.value.trim()) {
      void runVerification(false);
    }
  } catch (err) {
    notify('error', 'Ayarlar yüklenemedi: ' + String(err));
  } finally {
    loading.value = false;
  }
}

async function runVerification(showToast = true): Promise<void> {
  verifyingWporg.value = true;
  try {
    const res = await verifyWporgSession(wporgCookie.value);
    wporgVerification.value = res;
    if (showToast) {
      if (res.valid) {
        notify('ok', `WordPress.org oturumu geçerli: ${res.displayName || res.username} (@${res.username})`);
      } else {
        notify('error', `Oturum geçersiz: ${res.error}`);
      }
    }
  } catch (err) {
    wporgVerification.value = { valid: false, error: String(err) };
    if (showToast) notify('error', 'Oturum doğrulanamadı: ' + String(err));
  } finally {
    verifyingWporg.value = false;
  }
}

async function handleSaveWporgCookie(): Promise<void> {
  savingWporg.value = true;
  try {
    await saveWporgSettings(wporgCookie.value);
    notify('ok', 'WordPress.org çerezi kaydedildi.');
    await runVerification(true);
  } catch (err) {
    notify('error', 'Çerez kaydedilemedi: ' + String(err));
  } finally {
    savingWporg.value = false;
  }
}

async function saveSettings(): Promise<void> {
  saving.value = true;
  try {
    const res = await saveAiSettings(agents.value);
    agents.value = res.agents;
    notify('ok', 'Genel ayarlar ve AI CLI yapılandırması başarıyla kaydedildi.');
  } catch (err) {
    notify('error', 'Ayarlar kaydedilemedi: ' + String(err));
  } finally {
    saving.value = false;
  }
}

function computeBashSample(agent: AiAgent): string {
  const model = agent.model?.trim() || agent.defaultModel;
  switch (agent.id) {
    case 'claude':
      return `claude -p --tools "" --model ${model} "<prompt>"`;
    case 'codex':
      return `codex exec --sandbox read-only -m ${model} --output-schema schema.json "<prompt>"`;
    case 'opencode':
      return `opencode run --format json --agent wp-translator --model ${model} < /dev/null`;
    case 'agy':
      return `agy -m ${model} --json-schema schema.json -p "<prompt>"`;
    default:
      return `${agent.command} --model ${model}`;
  }
}

onMounted(load);
</script>

<template>
  <div class="page-layout">
    <div class="page-header">
      <div>
        <h1 class="page-title">Genel Ayarlar & Entegrasyonlar</h1>
        <p class="page-desc">
          WordPress.org doğrudan içe aktarma oturumunu ve yerel CLI AI çeviri motorlarını (Claude, Codex, OpenCode, Agy) yapılandırın.
        </p>
      </div>
      <button class="btn primary" :disabled="saving" @click="saveSettings">
        {{ saving ? 'Kaydediliyor…' : 'AI Ayarlarını Kaydet' }}
      </button>
    </div>

    <!-- WordPress.org Entegrasyonu -->
    <div class="agent-card" style="margin-bottom: 24px; border: 1px solid var(--border-default); background: var(--bg-surface);">
      <div class="agent-card-header" style="border-bottom: 1px solid var(--border-default); padding-bottom: 12px; margin-bottom: 14px;">
        <div class="agent-name-wrap">
          <span style="font-size:24px;">🌐</span>
          <div>
            <div class="agent-name" style="font-size: 15px;">WordPress.org (GlotPress) Entegrasyonu</div>
            <div style="font-size:12px; color:var(--text-muted);">
              Çevirileri doğrudan translate.wordpress.org üzerine tek tıkla yüklemek ve onaylamak için oturum çerezini yapılandırın.
            </div>
          </div>
        </div>
        <div v-if="wporgVerification" style="display: flex; align-items: center; gap: 8px;">
          <span v-if="wporgVerification.valid" class="status-pill ok" style="font-size: 11px; padding: 3px 8px;">
            ✓ Bağlantı Aktif: {{ wporgVerification.displayName || wporgVerification.username }} (@{{ wporgVerification.username }})
          </span>
          <span v-else class="status-pill danger" style="font-size: 11px; padding: 3px 8px;">
            ✕ {{ wporgVerification.error || 'Oturum Geçersiz' }}
          </span>
        </div>
      </div>

      <div style="display: flex; flex-direction: column; gap: 12px;">
        <div>
          <label style="font-size:11px; font-weight:700; color:var(--text-subtle); text-transform:uppercase; display: block; margin-bottom: 6px;">
            Oturum Çerezleri (Cookies):
          </label>
          <textarea
            v-model="wporgCookie"
            class="search-input"
            rows="3"
            style="width: 100%; font-family: monospace; font-size: 12px; resize: vertical;"
            placeholder="wporg_logged_in=...; wporg_sec=...;"
          ></textarea>
          <p style="font-size: 11px; color: var(--text-subtle); margin-top: 4px; margin-bottom: 0;">
            Tarayıcınızda translate.wordpress.org açıkken kopyalayacağınız <code>wporg_logged_in</code> ve <code>wporg_sec</code> çerezlerini buraya yapıştırın.
          </p>
        </div>

        <div style="display: flex; justify-content: flex-end; gap: 10px;">
          <button
            class="btn"
            :disabled="verifyingWporg || !wporgCookie.trim()"
            @click="runVerification(true)"
          >
            <span v-if="verifyingWporg" class="inline-spinner" style="margin-right: 4px;"></span>
            <span v-else style="margin-right: 4px;">🔍</span>
            {{ verifyingWporg ? 'Kontrol Ediliyor…' : 'Oturumu Doğrula' }}
          </button>
          <button
            class="btn primary"
            :disabled="savingWporg"
            @click="handleSaveWporgCookie"
          >
            {{ savingWporg ? 'Kaydediliyor…' : 'Çerezi Kaydet' }}
          </button>
        </div>
      </div>
    </div>

    <!-- AI CLI Agents -->
    <h2 style="font-size: 16px; font-weight: 700; margin-bottom: 12px; color: #fff;">Yerel AI CLI Çeviri Motorları</h2>
    <div class="settings-grid">
      <div v-for="agent in agents" :key="agent.id" class="agent-card">
        <div class="agent-card-header">
          <div class="agent-name-wrap">
            <span style="font-size:20px;">{{ agent.icon }}</span>
            <div>
              <div class="agent-name">{{ agent.name }}</div>
              <div style="font-size:11px; color:var(--text-muted);">Komut: <code>{{ agent.command }}</code></div>
            </div>
          </div>
          <label class="toggle-switch">
            <input v-model="agent.enabled" type="checkbox" />
            <span class="toggle-slider"></span>
          </label>
        </div>

        <div>
          <label style="font-size:11px; font-weight:700; color:var(--text-subtle); text-transform:uppercase;">Model Adı (Opsiyonel):</label>
          <input
            v-model="agent.model"
            class="search-input"
            style="margin-top:4px;"
            :placeholder="`Varsayılan: ${agent.defaultModel}`"
            :disabled="!agent.enabled"
          />
        </div>

        <div>
          <label style="font-size:11px; font-weight:700; color:var(--text-subtle); text-transform:uppercase;">Çalıştırılan Bash Komut Örneği:</label>
          <div class="bash-snippet">{{ computeBashSample(agent) }}</div>
        </div>
      </div>
    </div>
  </div>
</template>
