<script setup lang="ts">
import { LEGEND } from './invisible.ts';
</script>

<template>
  <p class="legend">
    <span class="muted">Görünmez karakterler:</span>
    <span v-for="marker in LEGEND" :key="marker.text">
      <i class="ghost">{{ marker.text }}</i> {{ marker.label }}
      <em>{{ marker.note }}</em>
    </span>
  </p>
</template>
