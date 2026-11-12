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

function toggleTag(id: number): void {
  if (chosen.value.includes(id)) {
    chosen.value = chosen.value.filter((t) => t !== id);
  } else {
    chosen.value.push(id);
  }
}

async function submit(): Promise<void> {
  if (!url.value.trim()) return;
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
  <div class="page-layout">
    <div class="page-header">
      <div>
        <h1 class="page-title">Yeni Proje Ekle</h1>
        <p class="page-desc">
          translate.wordpress.org üzerinden bir eklenti, tema veya WordPress projesinin GlotPress adresini girerek kataloğunu içe aktarın.
        </p>
      </div>
    </div>

    <div class="settings-card" style="max-width: 800px;">
      <!-- Error Message Box -->
      <div v-if="error" class="alert-danger-box" style="margin-bottom: 18px;">
        <div style="font-size: 13px; font-weight: 700; color: #f87171; display: flex; align-items: center; gap: 6px;">
          <span>⚠️ Proje Eklenemedi</span>
        </div>
        <div style="font-size: 13px; color: #cbd5e1; line-height: 1.5;">
          {{ error }}
        </div>
      </div>

      <!-- Success Result Box -->
      <div v-if="result" style="background: rgba(39, 174, 96, 0.15); border: 1px solid rgba(39, 174, 96, 0.4); border-radius: 6px; padding: 14px; margin-bottom: 18px;">
        <div style="font-size: 13px; font-weight: 700; color: #34d399; margin-bottom: 6px;">
          ✓ Proje Başarıyla Eklendi
        </div>
        <div style="font-size: 13px; color: #cbd5e1; line-height: 1.5;">
          {{ result.strings.toLocaleString('tr') }} dizge alındı.
          <b>{{ result.match.filled.toLocaleString('tr') }}</b> tanesi sözlükten dolduruldu,
          <b>{{ result.match.alternatives }}</b> tanesinde alternatif seçenek var.
        </div>
      </div>

      <div style="display: flex; flex-direction: column; gap: 18px;">
        <div>
          <label style="font-size: 12px; font-weight: 700; color: var(--text-subtle); text-transform: uppercase; display: block; margin-bottom: 6px;">
            GlotPress Proje URL Adresi:
          </label>
          <input
            v-model="url"
            class="search-input"
            style="padding: 10px 14px; font-size: 13px;"
            placeholder="Örn: https://translate.wordpress.org/projects/wp-plugins/woocommerce/dev/tr/default/"
            :disabled="busy"
            @keyup.enter="submit"
          />
          <p style="font-size: 12px; color: var(--text-subtle); margin: 6px 0 0; line-height: 1.4;">
            Eklenti veya temanın Türkçeleştirme proje sayfasının URL adresini yapıştırın.
          </p>
        </div>

        <div>
          <label style="font-size: 12px; font-weight: 700; color: var(--text-subtle); text-transform: uppercase; display: block; margin-bottom: 8px;">
            Projeye Atanacak Etiketler:
          </label>
          <div style="display: flex; flex-wrap: wrap; gap: 8px;">
            <button
              v-for="tag in tags"
              :key="tag.id"
              type="button"
              class="chip-btn"
              :class="{ primary: chosen.includes(tag.id) }"
              :style="chosen.includes(tag.id) ? 'background: var(--accent-warm); color: #fff; border-color: var(--accent-warm);' : ''"
              @click="toggleTag(tag.id)"
            >
              <span v-if="chosen.includes(tag.id)">✓</span>
              <span>{{ tag.name }}</span>
            </button>
          </div>
          <p style="font-size: 12px; color: var(--text-subtle); margin: 8px 0 0;">
            Seçilen etiketlerin özel AI üslup kuralları ve sözlük terimleri bu projenin çevirisine otomatik dahil edilir.
          </p>
        </div>

        <div style="border-top: 1px solid var(--border-default); padding-top: 14px; display: flex; justify-content: flex-end;">
          <button
            class="btn primary"
            style="padding: 8px 18px; font-size: 13px;"
            :disabled="busy || !url.trim()"
            @click="submit"
          >
            {{ busy ? 'Proje İçe Aktarılıyor…' : '+ Projeyi İçe Aktar' }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>
