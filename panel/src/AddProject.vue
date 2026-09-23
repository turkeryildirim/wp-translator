<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { addProject, listTags, type AddProjectResult, type Tag } from './api.ts';

const emit = defineEmits<{ added: [number] }>();

const tags = ref<Tag[]>([]);
const url = ref('');
const chosen = ref<number[]>([]);
const busy = ref(false);
const error = ref('');
const result = ref<AddProjectResult | null>(null);

async function submit(): Promise<void> {
  error.value = '';
  result.value = null;
  busy.value = true;
  try {
    result.value = await addProject(url.value.trim(), chosen.value);
    url.value = '';
    emit('added', result.value.projectId);
  } catch (problem) {
    error.value = problem instanceof Error ? problem.message : String(problem);
  } finally {
    busy.value = false;
  }
}

onMounted(async () => {
  tags.value = await listTags();
});
</script>

<template>
  <section class="screen">
    <h3>Çevrilecek proje ekle</h3>
    <div class="toolbar">
      <input
        v-model="url"
        class="grow"
        placeholder="https://translate.wordpress.org/projects/wp-plugins/…/dev/tr/default/"
        @keyup.enter="submit"
      />
      <select v-model="chosen" multiple size="1">
        <option v-for="tag in tags" :key="tag.id" :value="tag.id">{{ tag.name }}</option>
      </select>
      <button class="primary" :disabled="busy" @click="submit">
        {{ busy ? 'Ekleniyor…' : 'Ekle' }}
      </button>
    </div>

    <p class="hint">
      Eklenti ve temalarda ad, sürüm ve açıklama wordpress.org'dan alınır. Core, apps, meta ve
      patterns projelerinde böyle bir kaynak yok; etiketleri siz verirsiniz.
    </p>

    <p v-if="error" class="failure">{{ error }}</p>

    <template v-if="result">
      <p class="status">
        {{ result.strings.toLocaleString('tr') }} string alındı.
        <b>{{ result.match.filled.toLocaleString('tr') }}</b> tanesi sözlükten dolduruldu,
        <b>{{ result.match.ambiguous }}</b> tanesi aday bekliyor,
        {{ result.match.unmatched.toLocaleString('tr') }} tanesi AI'ya kalacak.
      </p>
      <p v-if="result.suggestedTags.length" class="hint">
        wordpress.org etiketleri: {{ result.suggestedTags.join(', ') }}
      </p>
    </template>
  </section>
</template>
