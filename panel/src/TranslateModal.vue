<script setup lang="ts">
import { nextTick, ref, watch } from 'vue';
import type { TranslateProgress } from './api.ts';

const props = defineProps<{ progress: TranslateProgress }>();
const emit = defineEmits<{ stop: [] }>();

const logEl = ref<HTMLElement | null>(null);
const stopping = ref(false);

// Follow the tail, which is where a stalled request shows itself.
watch(
  () => props.progress.log.length,
  async () => {
    await nextTick();
    if (logEl.value) logEl.value.scrollTop = logEl.value.scrollHeight;
  },
);

function stop(): void {
  stopping.value = true;
  emit('stop');
}
</script>

<template>
  <!-- Modal so a run cannot be interrupted by a stray click on the screen
       behind it; there is one run at a time and it owns the window. -->
  <div class="backdrop" role="dialog" aria-modal="true" aria-label="AI çevirisi">
    <div class="modal">
      <h3>AI ile çevriliyor</h3>

      <p class="progress-line">
        <b>{{ progress.done.toLocaleString('tr') }}</b> /
        {{ progress.total.toLocaleString('tr') }} dizge
        <span class="muted">
          · {{ progress.translated }} çevrildi<span v-if="progress.flagged">
            · {{ progress.flagged }} işaretli</span
          ><span v-if="progress.errors.length"> · {{ progress.errors.length }} küme başarısız</span>
        </span>
      </p>
      <progress :value="progress.done" :max="progress.total || 1" />

      <p v-if="progress.errors.length" class="failure-inline">
        {{ progress.errors[progress.errors.length - 1]!.message }}
      </p>

      <pre ref="logEl" class="runlog">{{ progress.log.join('\n') || 'opencode bekleniyor…' }}</pre>

      <div class="editor-actions">
        <button :disabled="stopping" @click="stop">
          {{ stopping ? 'Durduruluyor…' : 'Durdur' }}
        </button>
        <span class="muted">
          Durdurulan küme çevrilmemiş kalır; sonraki çalışma tam olarak kalanı alır.
        </span>
      </div>
    </div>
  </div>
</template>
