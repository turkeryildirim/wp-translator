<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue';
import {
  bulkSetState,
  exportPo as fetchExport,
  listProjects,
  listUnits,
  reloadCost,
  stopTranslation,
  reloadProject,
  removeProject,
  startTranslation,
  translateProgress,
  type BulkAction,
  type Engine,
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
import TranslateModal from './TranslateModal.vue';
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
// A GTE opens a project to review what is there, not only to fill what is missing.
const filter = ref<QueueView>('translated');
const picked = ref<number[]>([]);
const search = ref('');
const caseSensitive = ref(false);
const scope = ref<'' | 'source' | 'translation'>('');
const loading = ref(false);
const translating = ref<TranslateProgress | null>(null);
let translatePoll: ReturnType<typeof setInterval> | null = null;

// Everything the glossary could not fill.
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
const engine = ref<Engine>('opencode');

/** Each CLI is configured its own way, so the agent only means anything to one. */
/**
 * Which CLI is asked, and with what.
 *
 * opencode's own default is one of its free models, and those refuse CLI requests
 * without warning — the owner's z.ai plan is asked for by name instead.
 */
const ENGINE_ARGS: Record<Engine, { agent?: string; model?: string }> = {
  opencode: { agent: 'wp-translator', model: 'zai-coding-plan/glm-5.3-flash' },
  agy: { model: 'gemini-3.8-flash-low' },
};

async function translate(): Promise<void> {
  if (selected.value === null) return;
  if (
    translateScope.value === 'all' &&
    !confirm('Çevrilmiş olanlar dahil tüm dizgeler yeniden çevrilecek. Devam edilsin mi?')
  )
    return;

  translating.value = await startTranslation(selected.value, {
    engine: engine.value,
    ...ENGINE_ARGS[engine.value],
    scope: translateScope.value,
    ...(translateScope.value === 'selected' ? { ids: picked.value } : {}),
  });
  pollTranslation();
}

async function stopRun(): Promise<void> {
  if (selected.value === null) return;
  translating.value = await stopTranslation(selected.value);
}

function pollTranslation(): void {
  translatePoll ??= setInterval(async () => {
    if (selected.value === null) return;
    translating.value = await translateProgress(selected.value);
    if (!translating.value.running) {
      clearInterval(translatePoll!);
      translatePoll = null;
      projects.value = await listProjects();
      await load();
      // A run takes minutes, so its outcome goes to the corner.
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

type BulkChoice = BulkAction | 'translate';

const bulkAction = ref<BulkChoice | ''>('');
/** True while the owner means "the whole filter", not the rows on this page. */
const wholeFilter = ref(false);

const bulkCount = computed(() => (wholeFilter.value ? total.value : picked.value.length));

const BULK_LABEL: Record<BulkChoice, string> = {
  approve: 'Onayla',
  clear: 'Çeviriyi sil',
  glossary: 'Sözlükten doldur',
  translate: 'AI ile çevir',
};

/**
 * Apply the chosen action to the selection, or to the whole filter. Nothing
 * runs without a target, and the confirmation names the count.
 */
async function runBulk(): Promise<void> {
  const action = bulkAction.value;
  if (selected.value === null || !action || bulkCount.value === 0) return;

  const what = bulkCount.value.toLocaleString('tr');
  if (!confirm(`${what} dizgeye "${BULK_LABEL[action]}" uygulansın mı?`)) return;

  const target = wholeFilter.value ? { params: queryParams(false) } : { ids: picked.value };

  if (action === 'translate') {
    const ids = wholeFilter.value ? undefined : picked.value;
    translating.value = await startTranslation(selected.value, {
      engine: engine.value,
      ...ENGINE_ARGS[engine.value],
      scope: ids ? 'selected' : filter.value === 'waiting' ? 'waiting' : 'untranslated',
      ...(ids ? { ids } : {}),
    });
    pollTranslation();
    return;
  }

  const result = await bulkSetState(selected.value, action, target);
  notify(
    'ok',
    result.skipped > 0
      ? `${result.changed} dizge işlendi, ${result.skipped} tanesi dışarıda kaldı.`
      : `${result.changed} dizge işlendi.`,
  );
  clearSelection();
  projects.value = await listProjects();
  await load();
}

const allOnPage = computed(
  () => units.value.length > 0 && units.value.every((unit) => picked.value.includes(unit.id)),
);

function togglePage(): void {
  const ids = units.value.map((unit) => unit.id);
  picked.value = allOnPage.value
    ? picked.value.filter((id) => !ids.includes(id))
    : [...new Set([...picked.value, ...ids])];
}

function clearSelection(): void {
  picked.value = [];
  wholeFilter.value = false;
}

const reloading = ref(false);

/**
 * Fetch the project again and take what the service has, discarding local work.
 * The warning names how many strings go, asked of the server so it is current.
 */
async function reload(): Promise<void> {
  const current = project.value;
  if (!current || reloading.value) return;

  const { discards } = await reloadCost(current.id);
  const warning =
    discards > 0
      ? `wp.org'dan yeniden alınacak.\n\nBu projede sizin ya da AI'ın ürettiği ` +
        `${discards.toLocaleString('tr')} dizge var ve hepsi silinecek. Dışa aktarmadıysanız ` +
        `geri getirilemez.\n\nDevam edilsin mi?`
      : `wp.org'dan yeniden alınacak.\n\nSilinecek kendi çalışmanız yok.\n\nDevam edilsin mi?`;
  if (!confirm(warning)) return;

  reloading.value = true;
  try {
    const result = await reloadProject(current.id);
    notify(
      'ok',
      `${result.strings.toLocaleString('tr')} dizge alındı, ` +
        `${result.match.filled.toLocaleString('tr')} tanesi sözlükten dolduruldu.`,
    );
    clearSelection();
    projects.value = await listProjects();
    page.value = 0;
    await load();
  } finally {
    reloading.value = false;
  }
}

async function dropProject(): Promise<void> {
  const current = project.value;
  if (!current) return;
  if (!confirm(`"${current.name ?? current.projectPath}" ve tüm çevirileri silinsin mi?`)) return;

  await removeProject(current.id);
  projects.value = await listProjects();
  selected.value = projects.value[0]?.id ?? null;
  await load();
}

/**
 * Download the project's PO, and say what went into it.
 *
 * Only approved translations are exported, so a project nobody has approved yet
 * gives a file with nothing in it — which used to download without a word.
 */
async function downloadPo(): Promise<void> {
  if (selected.value === null) return;

  const { po, exported, withheld } = await fetchExport(selected.value);
  if (exported === 0) {
    notify(
      'error',
      `Onaylanmış dizge yok, indirilecek bir şey de yok. PO yalnızca onaylananları taşır; ` +
        `${withheld.toLocaleString('tr')} dizge incelemede bekliyor.`,
    );
    return;
  }

  const url = URL.createObjectURL(po);
  const link = Object.assign(document.createElement('a'), {
    href: url,
    download: `${project.value?.projectPath.replace(/\//g, '-') ?? 'tr'}.po`,
  });
  link.click();
  URL.revokeObjectURL(url);

  notify(
    'ok',
    withheld > 0
      ? `${exported.toLocaleString('tr')} dizge indirildi, ${withheld.toLocaleString('tr')} onaysız olduğu için dışarıda kaldı.`
      : `${exported.toLocaleString('tr')} dizge indirildi.`,
  );
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

// A different project starts at the beginning with nothing selected: carrying a
// page number across means asking the new project for an offset it may not
// reach, which answers with counts but no rows.
watch(selected, () => {
  page.value = 0;
  clearSelection();
  void load();
});

// Watching `page` is what makes the pager work; `goTo` only moves the number.
// A filter change also loads explicitly, and the ticket drops the stale reply.
watch(page, load);
</script>

<template>
  <div class="app" :class="{ 'review-screen': screen === 'review' }">
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
    <!-- Reading order: what the markers mean, what the project is, what to run
         on it, what to look at, what to do with the selection, then the rows. -->
    <Legend />
    <p class="legend">
      <span class="muted">Satır:</span>
      <span><b>✓</b> onaylı</span>
      <span><b>!</b> kalite kontrolü engelliyor</span>
      <span><b>·</b> bekliyor</span>
      <span class="muted">Kısayol:</span>
      <span><kbd>Ctrl</kbd>+<kbd>Enter</kbd> onayla, ilerle</span>
      <span><kbd>Shift</kbd>+<kbd>Enter</kbd> reddet, ilerle</span>
      <span><kbd>Ctrl</kbd>+<kbd>↑</kbd>/<kbd>↓</kbd> satır</span>
      <span><kbd>j</kbd>/<kbd>k</kbd> gez</span>
      <span><kbd>e</kbd> düzenle</span>
      <span><kbd>x</kbd> seç</span>
      <span><kbd>1</kbd>–<kbd>9</kbd> aday seç</span>
    </p>

    <div class="toolbar">
      <select v-model="selected" class="grow" aria-label="Proje">
        <option v-for="p in projects" :key="p.id" :value="p.id">
          {{ p.name ?? p.projectPath }}
        </option>
      </select>
      <button :disabled="!project" title="Projeyi ve çevirilerini sil" @click="dropProject">
        Projeyi sil
      </button>
      <button
        :disabled="!project || reloading"
        title="Kataloğu wp.org'dan yeniden al"
        @click="reload"
      >
        {{ reloading ? 'Yenileniyor…' : 'Yenile' }}
      </button>
      <!-- Gated on approved, not on translated: the file carries only approved
           strings, so a project mid-review would otherwise download empty. -->
      <button
        :disabled="!project || project.ok === 0"
        :title="
          !project || project.ok === 0
            ? 'Onaylanmış dizge yok; PO yalnızca onaylananları taşır'
            : `${project.ok} onaylı dizgeyi PO olarak indir`
        "
        @click="downloadPo"
      >
        PO indir
      </button>
      <a
        v-if="project"
        class="button"
        :href="project.translateUrl"
        target="_blank"
        rel="noreferrer"
        :title="project.translateUrl"
      >
        wp.org’da aç
      </a>
      <span v-if="project" class="progress">{{ project.ok }} / {{ project.total }} tamam</span>
    </div>

    <div class="toolbar">
      <select v-model="engine" aria-label="Hangi CLI" :disabled="translating?.running">
        <option value="opencode">opencode · GLM 5.3 Flash</option>
        <option value="agy">agy · Gemini 3.8 Flash (low)</option>
      </select>
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
      <!-- Failures are shown while the run is going, not only at the end: a
           stalled chunk costs minutes, and the owner has to know it is
           happening to decide whether to let it continue. -->
      <span v-if="translating?.running && translating.errors.length" class="failure-inline">
        {{ translating.errors.length }} küme başarısız —
        {{ translating.errors[translating.errors.length - 1]!.message }}
      </span>
      <span v-else-if="translating && !translating.running && translating.finishedAt" class="muted">
        Son çeviri: {{ translating.translated }} dizge<span v-if="translating.flagged">
          , {{ translating.flagged }} tanesi işaretli</span
        ><span v-if="translating.errors.length">
          , {{ translating.errors.length }} küme başarısız</span
        >.
      </span>
    </div>

    <div class="toolbar">
      <nav>
        <button
          v-for="option in VIEWS"
          :key="option.view"
          :class="{ on: filter === option.view }"
          :title="option.hint"
          @click="show(option.view)"
        >
          {{ option.label }} <b>{{ counts[option.view].toLocaleString('tr') }}</b>
        </button>
      </nav>
      <input v-model="search" class="grow" placeholder="Ara…" @keyup.enter="show(filter)" />
      <select v-model="scope" aria-label="Nerede aransın" @change="show(filter)">
        <option value="">Kaynak + çeviri</option>
        <option value="source">Yalnızca kaynak</option>
        <option value="translation">Yalnızca çeviri</option>
      </select>
      <label class="check" title="Kapalıyken İ/ı/I/i aynı sayılır ve büyük-küçük harf gözetilmez">
        <input v-model="caseSensitive" type="checkbox" @change="show(filter)" />
        Harf duyarlı
      </label>
    </div>

    <div class="toolbar">
      <select v-model="bulkAction" aria-label="Toplu işlem">
        <option value="">Toplu işlem…</option>
        <option v-for="(label, key) in BULK_LABEL" :key="key" :value="key">{{ label }}</option>
      </select>
      <!-- Dead until both a target and an action exist. -->
      <button class="primary" :disabled="!bulkAction || bulkCount === 0" @click="runBulk">
        Uygula{{ bulkCount ? ` (${bulkCount.toLocaleString('tr')})` : '' }}
      </button>
      <label class="check">
        <input type="checkbox" :checked="allOnPage" @change="togglePage" />
        Sayfadakiler
      </label>
      <label class="check">
        <input v-model="wholeFilter" type="checkbox" />
        Filtredeki {{ total.toLocaleString('tr') }} kaydın tümü
      </label>
      <span v-if="picked.length && !wholeFilter" class="muted">{{ picked.length }} satır seçili</span>
      <button v-if="picked.length || wholeFilter" @click="clearSelection">Seçimi bırak</button>
    </div>

    <Pager :page="page" :total="total" :page-size="PAGE" :busy="loading" @go="goTo" />

    <p v-if="loading" class="status">Yükleniyor…</p>
    <p v-else-if="!units.length && total > 0" class="status">
      Bu sayfa boş — filtrede {{ total.toLocaleString('tr') }} kayıt var.
      <button @click="goTo(0)">Başa dön</button>
    </p>
    <p v-else-if="!units.length" class="status">
      Bu filtrede bir şey yok. Dışa aktarmaya hazır olabilirsiniz.
    </p>
    <ReviewTable
      v-else
      v-model:picked="picked"
      :units="units"
      @changed="onChanged"
      @bulk="load"
      @page="goTo(page + 1)"
    />

    <Pager :page="page" :total="total" :page-size="PAGE" :busy="loading" @go="goTo" />
    </template>

    <TranslateModal
      v-if="translating?.running"
      :progress="translating"
      @stop="stopRun"
    />
    <Toasts />
  </div>
</template>
