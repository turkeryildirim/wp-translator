<script setup lang="ts">
import { dismiss, notes } from './notify.ts';
</script>

<template>
  <!-- aria-live rather than role="alert" on each: the region is announced as it
       changes, so a run of saves does not interrupt the screen reader once per
       write. -->
  <div class="toasts" aria-live="polite">
    <p v-for="note in notes" :key="note.id" :class="['toast', note.kind]">
      <span>{{ note.text }}<b v-if="note.count > 1"> ×{{ note.count }}</b></span>
      <button :aria-label="`Kapat: ${note.text}`" @click="dismiss(note.id)">×</button>
    </p>
  </div>
</template>
