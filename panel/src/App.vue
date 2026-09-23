<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import {
  listProjects,
  listUnits,
  startTranslation,
  translateProgress,
  type Project,
  type TranslateProgress,
  type Unit,
} from './api.ts';
import ReviewTable from './ReviewTable.vue';
import TrustedSources from './TrustedSources.vue';
import GlossaryBrowser from './GlossaryBrowser.vue';
import TagsAndStyle from './TagsAndStyle.vue';
import AddProject from './AddProject.vue';

type Screen = 'review' | 'add' | 'sources' | 'glossary' | 'tags';
const screen = ref<Screen>('review');

const projects = ref<Project[]>([]);
const selected = ref<number | null>(null);
const units = ref<Unit[]>([]);
const filter = ref<'review' | 'blocked' | 'ambiguous' | 'all'>('review');
const search = ref('');
const loading = ref(false);
const translating = ref<TranslateProgress | null>(null);
let translatePoll: ReturnType<typeof setInterval> | null = null;

// Everything the glossary could not fill. The button says the number so the
// owner knows what they are starting before they start it.
const pending = computed(() => project.value?.untranslated ?? 0);

async function translate(): Promise<void> {
  if (selected.value === null) return;
  translating.value = await startTranslation(selected.value, { agent: 'wp-translator' });

  translatePoll ??= setInterval(async () => {
    if (selected.value === null) return;
    translating.value = await translateProgress(selected.value);
    if (!translating.value.running) {
      clearInterval(translatePoll!);
      translatePoll = null;
      projects.value = await listProjects();
      await load();
    }
  }, 1500);
}

const project = computed(() => projects.value.find((p) => p.id === selected.value));

async function load(): Promise<void> {
  if (selected.value === null) return;
  loading.value = true;
  try {
    const params: Record<string, string> = {};
    if (filter.value === 'review') params.state = 'review';
    if (filter.value === 'blocked') params.blocked = '1';
    if (filter.value === 'ambiguous') params.ambiguous = '1';
    if (search.value) params.q = search.value;
    units.value = await listUnits(selected.value, params);
  } finally {
    loading.value = false;
  }
}

function onChanged(saved: Unit): void {
  const index = units.value.findIndex((u) => u.id === saved.id);
  // Replace in place. Re-fetching would move every row under the cursor.
  if (index >= 0) units.value[index] = saved;
  const summary = project.value;
  if (summary && saved.state === 'ok') {
    summary.ok += 1;
    summary.review = Math.max(0, summary.review - 1);
  }
}

async function onProjectAdded(id: number): Promise<void> {
  projects.value = await listProjects();
  selected.value = id;
  screen.value = 'review';
}

onMounted(async () => {
  projects.value = await listProjects();
  selected.value = projects.value[0]?.id ?? null;
});

watch([selected, filter], load);
</script>

<template>
  <div class="app">
    <nav class="screens">
      <button
        v-for="option in (['review', 'add', 'sources', 'glossary', 'tags'] as const)"
        :key="option"
        :class="{ on: screen === option }"
        @click="screen = option"
      >
        {{
          {
            review: 'İnceleme',
            add: 'Proje ekle',
            sources: 'Güvenilir kaynaklar',
            glossary: 'Sözlük',
            tags: 'Etiket ve üslup',
          }[option]
        }}
      </button>
    </nav>

    <TrustedSources v-if="screen === 'sources'" />
    <GlossaryBrowser v-else-if="screen === 'glossary'" />
    <TagsAndStyle v-else-if="screen === 'tags'" />
    <AddProject v-else-if="screen === 'add'" @added="onProjectAdded" />

    <template v-else>
    <header>
      <select v-model="selected">
        <option v-for="p in projects" :key="p.id" :value="p.id">
          {{ p.name ?? p.projectPath }}
        </option>
      </select>

      <nav>
        <button
          v-for="option in (['review', 'blocked', 'ambiguous', 'all'] as const)"
          :key="option"
          :class="{ on: filter === option }"
          @click="filter = option"
        >
          {{
            { review: 'İncelenecek', blocked: 'Bloklanan', ambiguous: 'Aday bekleyen', all: 'Tümü' }[
              option
            ]
          }}
        </button>
      </nav>

      <input v-model="search" placeholder="Ara…" @keyup.enter="load" />

      <button
        v-if="pending > 0"
        class="translate"
        :disabled="translating?.running"
        @click="translate"
      >
        {{
          translating?.running
            ? `Çevriliyor — ${translating.done} / ${translating.total}`
            : `${pending.toLocaleString('tr')} string'i AI ile çevir`
        }}
      </button>

      <span v-if="project" class="progress">
        {{ project.ok }} / {{ project.total }} tamam · {{ project.review }} incelenecek
      </span>
    </header>

    <p v-if="translating && !translating.running && translating.finishedAt" class="status">
      Çeviri bitti: {{ translating.translated }} string incelemeye hazır<span
        v-if="translating.flagged"
        >, {{ translating.flagged }} tanesi kalite kontrolünden kaldı</span
      >.
      <span v-if="translating.errors.length" class="failure-inline">
        {{ translating.errors.length }} parça başarısız — yeniden çalıştırmak kaldığı yerden devam
        eder.
      </span>
    </p>
    <p v-if="loading" class="status">Yükleniyor…</p>
    <p v-else-if="!units.length" class="status">
      Bu filtrede bir şey yok. Dışa aktarmaya hazır olabilirsiniz.
    </p>
    <ReviewTable v-else :units="units" @changed="onChanged" @bulk="load" />
    </template>

    <footer v-if="screen === 'review'">
      <kbd>j</kbd>/<kbd>k</kbd> gez · <kbd>Enter</kbd> onayla · <kbd>e</kbd> düzenle ·
      <kbd>Ctrl+Enter</kbd> kaydet ve onayla · <kbd>boşluk</kbd> ayrıntı ·
      <kbd>1</kbd>–<kbd>9</kbd> aday seç · <kbd>x</kbd> toplu seçim
    </footer>
  </div>
</template>
