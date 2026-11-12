<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { fetchAiSettings, saveAiSettings, type AiAgent } from './api.ts';
import { notify } from './notify.ts';

const agents = ref<AiAgent[]>([]);
const loading = ref(true);
const saving = ref(false);

async function load(): Promise<void> {
  loading.value = true;
  try {
    const res = await fetchAiSettings();
    agents.value = res.agents;
  } catch (err) {
    notify('error', 'AI ayarları yüklenemedi: ' + String(err));
  } finally {
    loading.value = false;
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
        <h1 class="page-title">Genel Ayarlar & AI Çeviri Motorları</h1>
        <p class="page-desc">
          Sistemde kurulu yerel CLI agent'ları (Claude, Codex, OpenCode, Agy) yapılandırın. API gerektirmez; yerel terminal/shell üzerinden çağrılır.
        </p>
      </div>
      <button class="btn primary" :disabled="saving" @click="saveSettings">
        {{ saving ? 'Kaydediliyor…' : 'Ayarları Kaydet' }}
      </button>
    </div>

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
