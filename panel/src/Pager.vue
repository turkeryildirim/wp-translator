<script setup lang="ts">
const props = defineProps<{
  page: number;
  total: number;
  pageSize: number;
  /** A page is on its way; the arrows stay dead until it is on screen. */
  busy: boolean;
}>();

const emit = defineEmits<{ (event: 'go', page: number): void }>();

const pages = (): number => Math.max(1, Math.ceil(props.total / props.pageSize));
const atStart = (): boolean => props.page === 0;
const atEnd = (): boolean => (props.page + 1) * props.pageSize >= props.total;
</script>

<template>
  <p class="status pager">
    {{ total.toLocaleString('tr') }} girdi
    <template v-if="total > pageSize">
      · sayfa {{ page + 1 }} / {{ pages() }}
      <button :disabled="busy || atStart()" aria-label="Önceki sayfa" @click="emit('go', page - 1)">
        ◀
      </button>
      <button :disabled="busy || atEnd()" aria-label="Sonraki sayfa" @click="emit('go', page + 1)">
        ▶
      </button>
      <span v-if="busy" class="muted">yükleniyor…</span>
    </template>
  </p>
</template>
