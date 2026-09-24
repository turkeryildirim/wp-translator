<script setup lang="ts">
import { computed } from 'vue';
import { reveal } from './invisible.ts';

const props = defineProps<{ value: string }>();
const segments = computed(() => reveal(props.value));
</script>

<template>
  <span class="reveal"
    ><template v-for="(segment, at) in segments" :key="at"
      ><i v-if="segment.mark" class="ghost" :title="segment.title">{{ segment.text }}</i
      ><template v-else>{{ segment.text }}</template></template
    ></span
  >
</template>
