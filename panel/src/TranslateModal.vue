<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import type { TranslateProgress } from './api.ts';

const props = defineProps<{ progress: TranslateProgress }>();
const emit = defineEmits<{ stop: [] }>();

const logEl = ref<HTMLElement | null>(null);
const stopping = ref(false);

/**
 * Seconds the request in flight has been out.
 *
 * opencode delivers an answer in one piece rather than streaming it, so between
 * "sent" and the answer there is nothing to show but the clock — and the clock
 * is what says the difference between working and stuck.
 */
const now = ref(Date.now());
let tick: ReturnType<typeof setInterval> | null = null;
onMounted(() => {
  tick = setInterval(() => (now.value = Date.now()), 500);
});
onUnmounted(() => {
  if (tick) clearInterval(tick);
});

const waited = computed(() =>
  props.progress.waitingSince === null
    ? null
    : Math.floor((now.value - props.progress.waitingSince) / 1000),
);
const limit = computed(() => Math.round(props.progress.timeoutMs / 1000));

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
      <!-- Named because a run's log does not say which CLI produced it, and
           "it used the engine I did not pick" is otherwise unanswerable. -->
      <h3>
        AI ile çevriliyor
        <span class="engine">{{ progress.engine }}<span v-if="progress.model"> · {{ progress.model }}</span></span>
      </h3>

      <p class="progress-line">
        <b>{{ progress.done.toLocaleString('tr') }}</b> /
        {{ progress.total.toLocaleString('tr') }} dizge
        <span class="muted">
          · {{ progress.translated }} çevrildi<span v-if="progress.reused">
            · {{ progress.reused }} hafızadan</span
          ><span v-if="progress.flagged">
            · {{ progress.flagged }} işaretli</span
          ><span v-if="progress.errors.length"> · {{ progress.errors.length }} küme başarısız</span>
        </span>
      </p>
      <progress :value="progress.done" :max="progress.total || 1" />

      <p class="waiting">
        <template v-if="waited === null">Küme hazırlanıyor…</template>
        <template v-else>
          <b>{{ progress.inFlight }}</b> istek havada, en eskisi
          <b>{{ waited }}</b> / {{ limit }} sn
          <span class="muted">
            · yanıt parça parça değil tek seferde gelir, bu yüzden bir istek
            cevaplanana kadar ondan başka işaret olmaz.
          </span>
        </template>
      </p>

      <p v-if="progress.errors.length" class="failure-inline">
        {{ progress.errors[progress.errors.length - 1]!.message }}
      </p>

      <pre ref="logEl" class="runlog">{{ progress.log.join('\n') || `${progress.engine} bekleniyor…` }}</pre>

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
