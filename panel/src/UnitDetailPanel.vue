<script setup lang="ts">
import { ref, watch } from 'vue';
import { unitDetail, type UnitDetail } from './api.ts';

const props = defineProps<{ unitId: number }>();
const detail = ref<UnitDetail | null>(null);

watch(
  () => props.unitId,
  async (id) => {
    detail.value = null;
    detail.value = await unitDetail(id);
  },
  { immediate: true },
);
</script>

<template>
  <div v-if="detail" class="unit-detail">
    <dl>
      <template v-if="detail.usageSurface">
        <dt>Nerede</dt>
        <dd>{{ detail.usageSurface }}</dd>
      </template>
      <template v-if="detail.extractedComments">
        <dt>Geliştirici notu</dt>
        <dd>{{ detail.extractedComments }}</dd>
      </template>
      <template v-if="detail.refs">
        <dt>Kaynak</dt>
        <dd class="refs">{{ detail.refs }}</dd>
      </template>
    </dl>

    <template v-if="detail.terms.length">
      <h4>AI'ya gönderilen terimler</h4>
      <ul class="terms">
        <li v-for="term in detail.terms" :key="term.source">
          <b>{{ term.source }}</b>
          <span v-for="(reading, i) in term.readings" :key="i">
            {{ i ? ' | ' : ' = ' }}{{ reading.translation
            }}<em v-if="reading.pos"> ({{ reading.pos }})</em>
          </span>
        </li>
      </ul>
    </template>
  </div>
</template>
