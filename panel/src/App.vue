<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue';
import {
  bulkSetState,
  listProjects,
  listUnits,
  startTranslation,
  translateProgress,
  type Project,
  type QueueView,
  type TranslateProgress,
  type TranslateScope,
  type Unit,
} from './api.ts';
import Legend from './Legend.vue';
import Pager from './Pager.vue';
import ReviewTable from './ReviewTable.vue';
import TrustedSources from './TrustedSources.vue';
import GlossaryBrowser from './GlossaryBrowser.vue';
import Toasts from './Toasts.vue';
import { notify } from './notify.ts';
import TagsAndStyle from './TagsAndStyle.vue';
import AddProject from './AddProject.vue';

type Screen = 'review' | 'add' | 'sources' | 'glossary' | 'tags';
const screen = ref<Screen>('review');

const projects = ref<Project[]>([]);
const selected = ref<number | null>(null);
const units = ref<Unit[]>([]);
const total = ref(0);
const counts = ref<Record<QueueView, number>>({
  all: 0,
  untranslated: 0,
  waiting: 0,
  translated: 0,
  blocked: 0,
  upstream: 0,
});
const page = ref(0);
const PAGE = 100;
const filter = ref<QueueView>('waiting');
const picked = ref<number[]>([]);
const search = ref('');
const caseSensitive = ref(false);
const scope = ref<'' | 'source' | 'translation'>('');
const loading = ref(false);
const translating = ref<TranslateProgress | null>(null);
let translatePoll: ReturnType<typeof setInterval> | null = null;

// Everything the glossary could not fill. The button says the number so the
// owner knows what they are starting before they start it.
const pending = computed(() => project.value?.untranslated ?? 0);

const VIEWS: { view: QueueView; label: string; hint: string }[] = [
  { view: 'waiting', label: 'Bekleyen', hint: 'Çevirisi var, sizin onayınızı bekliyor' },
  { view: 'untranslated', label: 'Çevrilmemiş', hint: 'Hiç çevirisi yok' },
  { view: 'blocked', label: 'Bloklanan', hint: 'Kalite kontrolü onaylamaya izin vermiyor' },
  { view: 'upstream', label: 'wp.org’dan', hint: 'Projeyle birlikte gelen, siz dokunmadınız' },
  { view: 'translated', label: 'Çevrilmiş', hint: 'Onaylı; dışa aktarmaya girer' },
  { view: 'all', label: 'Tümü', hint: 'Katalogdaki her dizge' },
];

const translateScope = ref<TranslateScope>('untranslated');

async function translate(): Promise<void> {
  if (selected.value === null) return;
  if (
    translateScope.value === 'all' &&
    !confirm('Çevrilmiş olanlar dahil tüm dizgeler yeniden çevrilecek. Devam edilsin mi?')
  )
    return;

  translating.value = await startTranslation(selected.value, {
    agent: 'wp-translator',
    scope: translateScope.value,
    ...(translateScope.value === 'selected' ? { ids: picked.value } : {}),
  });

  translatePoll ??= setInterval(async () => {
    if (selected.value === null) return;
    translating.value = await translateProgress(selected.value);
    if (!translating.value.running) {
      clearInterval(translatePoll!);
      translatePoll = null;
      projects.value = await listProjects();
      await load();
      // Translation runs in chunks for minutes; its outcome belongs in the
      // corner rather than only in a line the owner has scrolled past.
      const done = translating.value;
      if (done.errors.length)
        notify('error', `Çeviri bitti, ${done.errors.length} küme başarısız oldu.`);
      else
        notify('ok', `Çeviri bitti: ${done.translated} dizge, ${done.flagged} tanesi işaretli.`);
    }
  }, 1500);
}

const project = computed(() => projects.value.find((p) => p.id === selected.value));

/** The filter as the server reads it, shared by the queue and the bulk actions. */
function queryParams(withPaging = true): Record<string, string> {
  const params: Record<string, string> = { view: filter.value };
  if (search.value) params.q = search.value;
  if (caseSensitive.value) params.case = '1';
  if (scope.value) params.in = scope.value;
  if (withPaging) {
    params.limit = String(PAGE);
    params.offset = String(page.value * PAGE);
  }
  return params;
}

/** Which request is the current one; a reply that arrives late is dropped. */
let ticket = 0;

async function load(): Promise<void> {
  if (selected.value === null) return;
  const mine = (ticket += 1);
  loading.value = true;
  try {
    const result = await listUnits(selected.value, queryParams());
    if (mine !== ticket) return;

    units.value = result.rows;
    total.value = result.total;
    counts.value = result.counts;
    await nextTick();
  } finally {
    if (mine === ticket) loading.value = false;
  }
}

function goTo(next: number): void {
  if (loading.value) return;
  page.value = next;
}

function show(view: QueueView): void {
  filter.value = view;
  page.value = 0;
  picked.value = [];
  void load();
}

async function bulk(action: 'approve' | 'reject'): Promise<void> {
  if (selected.value === null || total.value === 0) return;
  const what = action === 'approve' ? 'onaylansın' : 'reddedilsin';
  if (!confirm(`Filtredeki ${total.value.toLocaleString('tr')} dizgenin tamamı ${what} mı?`)) return;

  const result = await bulkSetState(selected.value, action, queryParams(false));
  notify(
    'ok',
    result.skipped > 0
      ? `${result.changed} dizge işlendi, ${result.skipped} tanesi kalite kontrolüne takıldı.`
      : `${result.changed} dizge işlendi.`,
  );
  projects.value = await listProjects();
  await load();
}

function exportPo(): void {
  if (selected.value !== null) window.location.href = `/api/projects/${selected.value}/export`;
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
          v-for="option in VIEWS"
          :key="option.view"
          :class="{ on: filter === option.view }"
          :title="option.hint"
          @click="show(option.view)"
        >
          {{ option.label }}
          <b>{{ counts[option.view].toLocaleString('tr') }}</b>
        </button>
      </nav>

      <input v-model="search" placeholder="Ara…" @keyup.enter="load" />
      <select v-model="scope" aria-label="Nerede aransın" @change="load">
        <option value="">Kaynak + çeviri</option>
        <option value="source">Yalnızca kaynak</option>
        <option value="translation">Yalnızca çeviri</option>
      </select>
      <label class="check" title="Kapalıyken İ/ı/I/i aynı sayılır ve büyük-küçük harf gözetilmez">
        <input v-model="caseSensitive" type="checkbox" @change="load" />
        Harf duyarlı
      </label>

      <select v-model="translateScope" aria-label="Neler çevrilsin" :disabled="translating?.running">
        <option value="untranslated">Çevrilmemişler ({{ counts.untranslated }})</option>
        <option value="waiting">Bekleyenler ({{ counts.waiting }})</option>
        <option value="selected">Seçililer ({{ picked.length }})</option>
        <option value="all">Tümü, baştan ({{ counts.all }})</option>
      </select>
      <button
        class="translate"
        :disabled="translating?.running || (translateScope === 'selected' && picked.length === 0)"
        @click="translate"
      >
        {{
          translating?.running
            ? `Çevriliyor — ${translating.done} / ${translating.total}`
            : 'AI ile çevir'
        }}
      </button>

      <button :disabled="counts.translated === 0" title="Onaylı dizgeleri PO olarak indir"
        @click="exportPo">
        PO indir
      </button>

      <span v-if="project" class="progress">
        {{ project.ok }} / {{ project.total }} tamam
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
    <div class="toolbar">
      <Pager :page="page" :total="total" :page-size="PAGE" :busy="loading" @go="goTo" />
      <button :disabled="total === 0 || loading" @click="bulk('approve')">
        Filtredekilerin tümünü onayla
      </button>
      <button :disabled="total === 0 || loading" @click="bulk('reject')">
        Tümünü reddet (boşalt)
      </button>
    </div>

    <Legend />
    <p class="legend">
      <span class="muted">Satır:</span>
      <span><i class="ghost">✓</i> onaylı</span>
      <span><i class="ghost">!</i> kalite kontrolü engelliyor</span>
      <span><i class="ghost">·</i> bekliyor</span>
      <span class="muted">Kısayollar:</span>
      <span><kbd>Ctrl</kbd>+<kbd>Enter</kbd> onayla, ilerle</span>
      <span><kbd>Shift</kbd>+<kbd>Enter</kbd> reddet, ilerle</span>
      <span><kbd>Ctrl</kbd>+<kbd>↑</kbd>/<kbd>↓</kbd> satır</span>
      <span><kbd>e</kbd> düzenle</span>
      <span><kbd>x</kbd> seç</span>
      <span><kbd>boşluk</kbd> ayrıntı</span>
    </p>

    <p v-if="loading" class="status">Yükleniyor…</p>
    <p v-else-if="!units.length" class="status">
      Bu filtrede bir şey yok. Dışa aktarmaya hazır olabilirsiniz.
    </p>
    <ReviewTable
      v-else
      :units="units"
      @changed="onChanged"
      @bulk="load"
      @picked="picked = $event"
      @page="goTo(page + 1)"
    />

    <Pager :page="page" :total="total" :page-size="PAGE" :busy="loading" @go="goTo" />
    </template>

    <footer v-if="screen === 'review'">
      <kbd>j</kbd>/<kbd>k</kbd> gez · <kbd>Enter</kbd> onayla · <kbd>e</kbd> düzenle ·
      <kbd>Ctrl+Enter</kbd> kaydet ve onayla · <kbd>boşluk</kbd> ayrıntı ·
      <kbd>1</kbd>–<kbd>9</kbd> aday seç · <kbd>x</kbd> toplu seçim
    </footer>
    <Toasts />
  </div>
</template>
