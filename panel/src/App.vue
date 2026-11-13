<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue';
import {
  addUnitsToGlossary,
  bulkSetState,
  exportPo as fetchExport,
  fetchAiSettings,
  replaceInTranslations,
  listProjects,
  listUnits,
  publishToWporg,
  reloadCost,
  stopTranslation,
  reloadProject,
  removeProject,
  startTranslation,
  translateProgress,
  type AiAgent,
  type BulkAction,
  type Engine,
  type Project,
  type QueueView,
  type TranslateProgress,
  type TranslateScope,
  type Unit,
} from './api.ts';
import ReviewTable from './ReviewTable.vue';
import TrustedSources from './TrustedSources.vue';
import GlossaryBrowser from './GlossaryBrowser.vue';
import TranslationMemoryBrowser from './TranslationMemoryBrowser.vue';
import Toasts from './Toasts.vue';
import TranslateModal from './TranslateModal.vue';
import { notify } from './notify.ts';
import TagsAndStyle from './TagsAndStyle.vue';
import AddProject from './AddProject.vue';
import QueueReview from './QueueReview.vue';
import Settings from './Settings.vue';
import AiMemory from './AiMemory.vue';
import SystemLogs from './SystemLogs.vue';

type Screen = 'review' | 'add' | 'sources' | 'glossary' | 'tm' | 'tags' | 'queue' | 'settings' | 'ai_memory' | 'logs';
const screen = ref<Screen>('review');

const isSidebarCollapsed = ref(localStorage.getItem('wp_translator_sidebar_collapsed') === 'true');

function toggleSidebar(): void {
  isSidebarCollapsed.value = !isSidebarCollapsed.value;
  localStorage.setItem('wp_translator_sidebar_collapsed', String(isSidebarCollapsed.value));
}

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

const showFindReplaceDrawer = ref(false);
const showTranslateDialog = ref(false);

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

const navItems = computed(() => [
  {
    screen: 'review' as const,
    label: 'Çeviri İnceleme',
    icon: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline><line x1="16" y1="13" x2="8" y2="13"></line><line x1="16" y1="17" x2="8" y2="17"></line><polyline points="10 9 9 9 8 9"></polyline></svg>`,
    badge: counts.value.waiting > 0 ? counts.value.waiting.toLocaleString('tr') : undefined,
  },
  {
    screen: 'queue' as const,
    label: 'Kuyruk Tarayıcısı',
    icon: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><polyline points="12 6 12 12 16 14"></polyline></svg>`,
  },
  {
    screen: 'glossary' as const,
    label: 'Sözlük',
    icon: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"></path><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"></path></svg>`,
  },
  {
    screen: 'tm' as const,
    label: 'Terim Bankası',
    icon: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><ellipse cx="12" cy="5" rx="9" ry="3"></ellipse><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"></path><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"></path></svg>`,
  },
  {
    screen: 'sources' as const,
    label: 'Güvenilir Projeler',
    icon: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"></path></svg>`,
  },
  {
    screen: 'tags' as const,
    label: 'Etiketler & Üslup',
    icon: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"></path><line x1="7" y1="7" x2="7.01" y2="7"></line></svg>`,
  },
  {
    screen: 'add' as const,
    label: 'Proje Ekle',
    icon: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="8" x2="12" y2="16"></line><line x1="8" y1="12" x2="16" y2="12"></line></svg>`,
  },
  {
    screen: 'ai_memory' as const,
    label: 'AI Hafızası',
    icon: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2a10 10 0 1 0 10 10H12V2z"></path><path d="M12 12 2.1 12.5"></path><path d="m4.5 4.5 7.5 7.5"></path><path d="M12 12V2a10 10 0 0 1 10 10"></path></svg>`,
  },
  {
    screen: 'logs' as const,
    label: 'Sistem Günlüğü',
    icon: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline><line x1="16" y1="13" x2="8" y2="13"></line><line x1="16" y1="17" x2="8" y2="17"></line><polyline points="10 9 9 9 8 9"></polyline></svg>`,
  },
  {
    screen: 'settings' as const,
    label: 'Genel Ayarlar (AI)',
    icon: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"></path></svg>`,
  },
]);

const translateScope = ref<TranslateScope>('untranslated');
const engine = ref<Engine>('opencode');
const aiAgents = ref<AiAgent[]>([]);

async function loadAiAgents(): Promise<void> {
  try {
    const res = await fetchAiSettings();
    aiAgents.value = res.agents;
  } catch {
    // Keep silent if server is restarting or offline
  }
}

const activeAiAgents = computed(() => aiAgents.value.filter((a) => a.enabled));

watch(
  activeAiAgents,
  (list) => {
    if (list.length > 0 && !list.some((a) => a.id === engine.value)) {
      engine.value = list[0].id as Engine;
    }
  },
  { immediate: true },
);

async function translate(): Promise<void> {
  if (selected.value === null) return;
  if (
    translateScope.value === 'all' &&
    !confirm('Çevrilmiş olanlar dahil tüm dizgeler yeniden çevrilecek. Devam edilsin mi?')
  )
    return;

  const currentAgent = aiAgents.value.find((a) => a.id === engine.value);
  const modelToUse = currentAgent?.model?.trim() || currentAgent?.defaultModel?.trim() || undefined;

  translating.value = await startTranslation(selected.value, {
    engine: engine.value,
    model: modelToUse,
    agent: engine.value === 'opencode' ? 'wp-translator' : undefined,
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

const findText = ref('');
const replaceText = ref('');
const replaceCaseSensitive = ref(true);
const replacing = ref(false);

/**
 * What a replacement would act on: the rows picked, or everything the current
 * filter and search select — never merely the page on screen.
 */
const replaceScopeCount = computed(() => (picked.value.length > 0 ? picked.value.length : total.value));
const replaceScope = computed(() =>
  picked.value.length > 0
    ? `${picked.value.length.toLocaleString('tr')} seçili satırda`
    : `${VIEWS.find((view) => view.view === filter.value)?.label ?? filter.value} filtresindeki ${total.value.toLocaleString('tr')} kaydın tümünde`,
);

/**
 * Replace inside translations only, literally and with case respected.
 *
 * Counted first and confirmed with the real number: the scope is a filter, so it
 * is routinely thousands of rows and the word being replaced is rarely unique.
 */
async function runReplace(): Promise<void> {
  if (selected.value === null || !findText.value) return;
  const target = picked.value.length > 0 ? { ids: picked.value } : { params: queryParams(false) };

  replacing.value = true;
  try {
    const { matched } = await replaceInTranslations(
      selected.value, findText.value, replaceText.value, target, true, replaceCaseSensitive.value,
    );
    if (matched === 0) {
      notify('error', `"${findText.value}" bu kapsamda hiçbir çeviride geçmiyor.`);
      return;
    }
    if (
      !confirm(
        `${matched.toLocaleString('tr')} çeviride "${findText.value}" → "${replaceText.value}" ` +
          `değişikliği yapılacak. Bunlar incelemeye geri döner. Devam edilsin mi?`,
      )
    )
      return;

    const done = await replaceInTranslations(
      selected.value, findText.value, replaceText.value, target, false, replaceCaseSensitive.value,
    );
    notify(
      done.blocked > 0 ? 'error' : 'ok',
      done.blocked > 0
        ? `${done.changed.toLocaleString('tr')} çeviri değişti, ${done.blocked.toLocaleString('tr')} tanesi kontrollere takıldı.`
        : `${done.changed.toLocaleString('tr')} çeviri değişti.`,
    );
    projects.value = await listProjects();
    await load();
  } finally {
    replacing.value = false;
  }
}

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

type BulkChoice = BulkAction | 'translate' | 'publish_to_wporg';

const bulkAction = ref<BulkChoice | ''>('');
const bulkPos = ref('auto');
/** True while the owner means "the whole filter", not the rows on this page. */
const wholeFilter = ref(false);

const bulkCount = computed(() => (wholeFilter.value ? total.value : picked.value.length));

const BULK_LABEL: Record<BulkChoice, string> = {
  approve: 'Onayla',
  clear: 'Çeviriyi sil',
  glossary: 'Sözlükten doldur',
  translate: 'AI ile çevir',
  add_to_glossary: 'Sözlüğe ekle',
  publish_to_wporg: "wp.org'a Gönder",
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
    const currentAgent = aiAgents.value.find((a) => a.id === engine.value);
    const modelToUse = currentAgent?.model?.trim() || currentAgent?.defaultModel?.trim() || undefined;
    const ids = wholeFilter.value ? undefined : picked.value;
    translating.value = await startTranslation(selected.value, {
      engine: engine.value,
      model: modelToUse,
      agent: engine.value === 'opencode' ? 'wp-translator' : undefined,
      scope: ids ? 'selected' : filter.value === 'waiting' ? 'waiting' : 'untranslated',
      ...(ids ? { ids } : {}),
    });
    pollTranslation();
    return;
  }

  if (action === 'add_to_glossary') {
    const res = await addUnitsToGlossary(selected.value, target, bulkPos.value);
    let msg = `${res.added} dizge sözlüğe eklendi.`;
    const details: string[] = [];
    if (res.skipped > 0) details.push(`${res.skipped} tanesi zaten mevcuttu (korundu)`);
    if (res.empty > 0) details.push(`${res.empty} tanesinin çevirisi boş olduğu için atlandı`);
    if (details.length > 0) msg += ` (${details.join(', ')})`;
    notify(res.added > 0 ? 'ok' : 'error', msg);
    clearSelection();
    return;
  }

  if (action === 'publish_to_wporg') {
    publishing.value = true;
    try {
      const res = await publishToWporg(selected.value, {
        ids: wholeFilter.value ? undefined : picked.value,
        filter: wholeFilter.value ? queryParams(false) : undefined,
      });
      notify('ok', res.message || `${res.exported.toLocaleString('tr')} çeviri wp.org'a başarıyla yüklendi.`);
      clearSelection();
      projects.value = await listProjects();
      await load();
    } catch (err: unknown) {
      notify('error', "wp.org'a gönderilemedi: " + (err instanceof Error ? err.message : String(err)));
    } finally {
      publishing.value = false;
    }
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

function formatProjectName(p: Project): string {
  const sub = p.subProject || (p.projectPath.split('/').pop()?.match(/^(dev|stable|dev-readme|stable-readme|release-notes)$/)?.[0]);
  const baseName = p.name ?? (sub && p.projectPath.endsWith(`/${sub}`) ? p.projectPath.slice(0, -(sub.length + 1)) : p.projectPath);
  return sub ? `${baseName} (${sub})` : baseName;
}

async function dropProject(): Promise<void> {
  const current = project.value;
  if (!current) return;
  if (!confirm(`"${formatProjectName(current)}" ve tüm çevirileri silinsin mi?`)) return;

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

const publishing = ref(false);

async function publishToWpOrg(): Promise<void> {
  if (selected.value === null || !project.value) return;

  const count = project.value.ok;
  if (count === 0) {
    notify('error', 'Onaylanmış çeviri yok. Önce dizgeleri onaylayın.');
    return;
  }

  const projName = project.value.name || project.value.projectPath;
  if (
    !confirm(
      `"${projName}" projesine ait ${count.toLocaleString('tr')} adet onaylı çeviri doğrudan translate.wordpress.org üzerine yüklenecek ve yayınlanacak.\n\nDevam edilsin mi?`,
    )
  ) {
    return;
  }

  publishing.value = true;
  try {
    const res = await publishToWporg(selected.value);
    notify('ok', res.message || `${res.exported.toLocaleString('tr')} çeviri wp.org'a başarıyla yüklendi.`);
  } catch (err: unknown) {
    notify('error', 'wp.org’a gönderilemedi: ' + (err instanceof Error ? err.message : String(err)));
  } finally {
    publishing.value = false;
  }
}

function onChanged(saved: Unit): void {
  const index = units.value.findIndex((u) => u.id === saved.id);
  const previous = index >= 0 ? units.value[index] : null;

  // Replace in place. Re-fetching would move every row under the cursor.
  if (index >= 0) units.value[index] = saved;

  if (previous) {
    // 1. Decrement old state
    if (previous.state === 'untranslated') counts.value.untranslated = Math.max(0, counts.value.untranslated - 1);
    else if (previous.state === 'review') counts.value.waiting = Math.max(0, counts.value.waiting - 1);
    else if (previous.state === 'ok') counts.value.translated = Math.max(0, counts.value.translated - 1);

    // 2. Increment new state
    if (saved.state === 'untranslated') counts.value.untranslated += 1;
    else if (saved.state === 'review') counts.value.waiting += 1;
    else if (saved.state === 'ok') counts.value.translated += 1;

    // 3. Blocked status change
    const prevBlocked = previous.blocked === 1 || previous.failures.length > 0;
    const newBlocked = saved.blocked === 1 || saved.failures.length > 0;
    if (prevBlocked && !newBlocked) counts.value.blocked = Math.max(0, counts.value.blocked - 1);
    else if (!prevBlocked && newBlocked) counts.value.blocked += 1;
  }

  const summary = project.value;
  if (summary && previous) {
    if (previous.state === 'untranslated') summary.untranslated = Math.max(0, summary.untranslated - 1);
    else if (previous.state === 'review') summary.review = Math.max(0, summary.review - 1);
    else if (previous.state === 'ok') summary.ok = Math.max(0, summary.ok - 1);

    if (saved.state === 'untranslated') summary.untranslated += 1;
    else if (saved.state === 'review') summary.review += 1;
    else if (saved.state === 'ok') summary.ok += 1;
  }
}

async function onProjectAdded(id: number): Promise<void> {
  projects.value = await listProjects();
  selected.value = id;
  screen.value = 'review';
}

onMounted(async () => {
  await loadAiAgents();
  projects.value = await listProjects();
  selected.value = projects.value[0]?.id ?? null;
});

watch(screen, async (s) => {
  if (s === 'review') {
    await loadAiAgents();
  }
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
  <div class="app-layout" :class="{ 'sidebar-is-collapsed': isSidebarCollapsed }">
    <main class="workspace" :class="{ 'review-screen': screen === 'review' }">
      <TrustedSources v-if="screen === 'sources'" @open-project="onProjectAdded" />
      <GlossaryBrowser v-else-if="screen === 'glossary'" />
      <TranslationMemoryBrowser v-else-if="screen === 'tm'" />
      <TagsAndStyle v-else-if="screen === 'tags'" />
      <AddProject v-else-if="screen === 'add'" @added="onProjectAdded" />
      <QueueReview v-else-if="screen === 'queue'" />
      <Settings v-else-if="screen === 'settings'" />
      <AiMemory v-else-if="screen === 'ai_memory'" />
      <SystemLogs v-else-if="screen === 'logs'" />

      <template v-else>
        <!-- Top Contextual Bar -->
        <header class="review-topbar">
          <div class="project-selector-wrap">
            <label style="font-size: 11px; font-weight: 700; color: var(--text-subtle); text-transform: uppercase;">PROJE:</label>
            <select v-model="selected" class="project-select" aria-label="Proje">
              <option v-for="p in projects" :key="p.id" :value="p.id">
                {{ formatProjectName(p) }}
              </option>
            </select>
            <button
              class="btn"
              style="padding: 4px 8px; font-size: 11px;"
              :disabled="!project || reloading"
              title="Kataloğu wp.org'dan yeniden al"
              @click="reload"
            >
              {{ reloading ? 'Yenileniyor…' : '🔄 Yenile' }}
            </button>
            <button
              class="btn"
              style="padding: 4px 8px; font-size: 11px; color: #f87171;"
              :disabled="!project"
              title="Projeyi ve çevirilerini sil"
              @click="dropProject"
            >
              🗑️
            </button>
            <div v-if="project" class="progress-summary">
              <span>İlerleme:</span>
              <div
                class="progress-track"
                :title="`%${Math.round((project.ok / (project.total || 1)) * 100)} Tamamlandı`"
              >
                <div
                  class="progress-fill"
                  :style="{ width: `${Math.min(100, Math.round((project.ok / (project.total || 1)) * 100))}%` }"
                ></div>
              </div>
              <span style="font-weight: 700; color: #fff;">
                {{ project.ok.toLocaleString('tr') }} / {{ project.total.toLocaleString('tr') }}
                (%{{ Math.round((project.ok / (project.total || 1)) * 100) }})
              </span>
            </div>
          </div>

          <div style="display: flex; align-items: center; gap: 8px;">
            <a
              v-if="project"
              class="btn"
              :href="project.translateUrl"
              target="_blank"
              rel="noreferrer"
              :title="project.translateUrl"
            >
              🌐 wp.org’da Aç
            </a>
            <button
              class="btn"
              :class="{ primary: showFindReplaceDrawer }"
              title="Çeviriler içinde bul ve değiştir panelini aç/kapat"
              @click="showFindReplaceDrawer = !showFindReplaceDrawer"
            >
              🔍 Bul & Değiştir
            </button>
            <button
              class="btn success"
              :disabled="!project || project.ok === 0"
              :title="
                !project || project.ok === 0
                  ? 'Onaylanmış dizge yok; PO yalnızca onaylananları taşır'
                  : `${project.ok} onaylı dizgeyi PO olarak indir`
              "
              @click="downloadPo"
            >
              ⬇️ PO İndir ({{ project?.ok ?? 0 }})
            </button>
            <button
              class="btn primary"
              :disabled="!project || project.ok === 0 || publishing"
              :title="
                !project || project.ok === 0
                  ? 'Onaylanmış dizge yok'
                  : `${project.ok} onaylı çeviriyi doğrudan translate.wordpress.org üzerine yükle`
              "
              style="background: #2563eb; border-color: #3b82f6;"
              @click="publishToWpOrg"
            >
              <span v-if="publishing" class="inline-spinner" style="margin-right: 4px;"></span>
              <span v-else style="margin-right: 4px;">🚀</span>
              {{ publishing ? 'Gönderiliyor…' : `wp.org'a Gönder (${project?.ok ?? 0})` }}
            </button>
            <button
              class="btn primary"
              :disabled="translating?.running || !project"
              title="Toplu AI çevirisi yap"
              @click="showTranslateDialog = true"
            >
              ⚡ AI ile Çevir ({{ pending }})
            </button>
          </div>
        </header>

        <!-- Unified Control Deck -->
        <div class="unified-toolbar">
          <div class="filter-tabs">
            <button
              v-for="option in VIEWS"
              :key="option.view"
              class="filter-tab"
              :class="{
                active: filter === option.view,
                danger: option.view === 'blocked' && counts.blocked > 0
              }"
              :title="option.hint"
              @click="show(option.view)"
            >
              <span>{{ option.view === 'blocked' && counts.blocked > 0 ? '⛔ ' : '' }}{{ option.label }}</span>
              <span class="badge">{{ counts[option.view].toLocaleString('tr') }}</span>
            </button>
          </div>

          <div class="filter-controls-row">
            <div class="search-box">
              <span class="search-icon">🔍</span>
              <input
                v-model="search"
                class="search-input"
                placeholder="Dizgelerde ara... (Enter ile filtrele, boş karakterler aranabilir)"
                @keyup.enter="show(filter)"
              />
            </div>
            <select
              v-model="scope"
              class="btn"
              style="padding: 6px 10px; font-size: 12px;"
              aria-label="Nerede aransın"
              @change="show(filter)"
            >
              <option value="">Kaynak + Çeviri</option>
              <option value="source">Yalnızca Kaynak</option>
              <option value="translation">Yalnızca Çeviri</option>
            </select>
            <label
              class="check"
              style="font-size: 12px; cursor: pointer;"
              title="Kapalıyken İ/ı/I/i aynı sayılır ve büyük-küçük harf gözetilmez"
            >
              <input v-model="caseSensitive" type="checkbox" @change="show(filter)" />
              Harf duyarlı
            </label>
            <div style="margin-left: auto; display: flex; align-items: center; gap: 8px;">
              <span v-if="translating?.running" class="status-pill waiting" style="font-size: 11px;">
                AI Çevirisi Sürüyor ({{ translating.done }}/{{ translating.total }})
              </span>
              <span v-else-if="translating && !translating.running && translating.finishedAt" class="muted" style="font-size: 11px;">
                Son çeviri: {{ translating.translated }} dizge
              </span>
            </div>
          </div>
        </div>

        <!-- Collapsible Drawer 1: Bul & Değiştir -->
        <div v-if="showFindReplaceDrawer" class="drawer-panel">
          <span style="font-size: 11px; font-weight: 700; color: var(--text-subtle); text-transform: uppercase;">
            Bul & Değiştir:
          </span>
          <input
            v-model="findText"
            class="search-input"
            style="flex: 1; min-width: 180px;"
            :placeholder="replaceCaseSensitive ? 'Çevirilerde bul (harf duyarlı)…' : 'Çevirilerde bul (harf gözetilmez)…'"
          />
          <input
            v-model="replaceText"
            class="search-input"
            style="flex: 1; min-width: 180px;"
            placeholder="Şununla değiştir…"
          />
          <label class="check" style="font-size: 12px; cursor: pointer; display: inline-flex; align-items: center; gap: 6px;" title="İşaretliyken büyük-küçük harf birebir eşleşmeli, kapalıyken harf farkı gözetilmez">
            <input v-model="replaceCaseSensitive" type="checkbox" />
            Harf duyarlı
          </label>
          <button
            class="btn primary"
            :disabled="!findText || replacing"
            @click="runReplace"
          >
            {{ replacing ? 'Değiştiriliyor…' : `Değiştir (${replaceScopeCount.toLocaleString('tr')})` }}
          </button>
          <span class="muted" style="font-size: 11px;">{{ replaceScope }}</span>
          <button class="btn" style="padding: 2px 8px; margin-left: auto;" @click="showFindReplaceDrawer = false">✕</button>
        </div>

        <!-- Toplu İşlemler Şeridi (Kalıcı / Always visible) -->
        <div class="bulk-actions-bar">
          <span style="font-size: 11px; font-weight: 700; color: var(--text-subtle); text-transform: uppercase; letter-spacing: 0.5px;">
            Toplu İşlem:
          </span>
          <select v-model="bulkAction" class="btn" style="padding: 5px 10px; font-size: 12px;" aria-label="Toplu işlem">
            <option value="">İşlem seçin…</option>
            <option v-for="(label, key) in BULK_LABEL" :key="key" :value="key">{{ label }}</option>
          </select>
          <select
            v-if="bulkAction === 'add_to_glossary'"
            v-model="bulkPos"
            class="btn"
            style="padding: 5px 8px; font-size: 12px;"
            title="Sözlüğe eklenecek kelime türü"
          >
            <option value="auto">✨ Otomatik Belirle</option>
            <option value="noun">İsim (Noun)</option>
            <option value="verb">Fiil (Verb)</option>
            <option value="adjective">Sıfat (Adjective)</option>
            <option value="adverb">Zarf (Adverb)</option>
            <option value="expression">Deyim (Expression)</option>
            <option value="abbreviation">Kısaltma (Abbreviation)</option>
          </select>
          <button
            class="btn primary"
            :disabled="!bulkAction || bulkCount === 0 || publishing"
            @click="runBulk"
          >
            <span v-if="publishing && bulkAction === 'publish_to_wporg'" class="inline-spinner" style="margin-right: 4px;"></span>
            {{ publishing && bulkAction === 'publish_to_wporg' ? 'Gönderiliyor…' : `Uygula${bulkCount ? ` (${bulkCount.toLocaleString('tr')})` : ''}` }}
          </button>
          <label class="check" style="font-size: 12px; cursor: pointer; display: inline-flex; align-items: center; gap: 6px;">
            <input type="checkbox" :checked="allOnPage" @change="togglePage" />
            Sayfadakiler
          </label>
          <label class="check" style="font-size: 12px; cursor: pointer; display: inline-flex; align-items: center; gap: 6px;">
            <input v-model="wholeFilter" type="checkbox" />
            Filtredeki {{ total.toLocaleString('tr') }} kaydın tümü
          </label>
          <span v-if="bulkCount > 0" class="status-pill waiting" style="font-size: 11px;">
            {{ bulkCount.toLocaleString('tr') }} satır seçili
          </span>
          <button v-if="picked.length || wholeFilter" class="btn" style="font-size: 11px; padding: 3px 8px;" @click="clearSelection">
            Seçimi bırak
          </button>
        </div>

        <!-- Batch Translation Dialog Modal -->
        <div v-if="showTranslateDialog" class="backdrop" @click.self="showTranslateDialog = false">
          <div class="modal" style="max-width: 480px;">
            <div style="display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid var(--border-default); padding-bottom: 10px;">
              <h3 style="margin: 0; color: #fff; font-size: 16px;">Toplu AI Çevirisi Başlat</h3>
              <button class="btn" style="padding: 2px 8px;" @click="showTranslateDialog = false">✕</button>
            </div>

            <div style="margin: 14px 0; display: flex; flex-direction: column; gap: 12px;">
              <div>
                <label style="font-size: 11px; font-weight: 700; color: var(--text-subtle); text-transform: uppercase; display: block; margin-bottom: 6px;">
                  CLI AI Motoru & Model:
                </label>
                <select v-model="engine" class="search-input" style="padding: 8px 10px;">
                  <option
                    v-for="agent in (activeAiAgents.length ? activeAiAgents : aiAgents)"
                    :key="agent.id"
                    :value="agent.id"
                  >
                    {{ agent.name }} · {{ agent.model || agent.defaultModel }}
                  </option>
                </select>
              </div>

              <div>
                <label style="font-size: 11px; font-weight: 700; color: var(--text-subtle); text-transform: uppercase; display: block; margin-bottom: 6px;">
                  Çevrilecek Kapsam:
                </label>
                <select v-model="translateScope" class="search-input" style="padding: 8px 10px;">
                  <option value="untranslated">Çevrilmemişler ({{ counts.untranslated }})</option>
                  <option value="waiting">Bekleyenler ({{ counts.waiting }})</option>
                  <option value="selected">Seçililer ({{ picked.length }})</option>
                  <option value="all">Tümü, baştan ({{ counts.all }})</option>
                </select>
              </div>
            </div>

            <div style="display: flex; justify-content: flex-end; gap: 8px; border-top: 1px solid var(--border-default); padding-top: 12px;">
              <button class="btn" @click="showTranslateDialog = false">İptal</button>
              <button
                class="btn primary"
                :disabled="translateScope === 'selected' && picked.length === 0"
                @click="showTranslateDialog = false; translate();"
              >
                Çeviriyi Başlat
              </button>
            </div>
          </div>
        </div>

        <!-- Table and Inspector -->
        <p v-if="loading" class="status">Yükleniyor…</p>
        <p v-else-if="!units.length && total > 0" class="status">
          Bu sayfa boş — filtrede {{ total.toLocaleString('tr') }} kayıt var.
          <button class="btn" style="margin-left: 8px;" @click="goTo(0)">Başa dön</button>
        </p>
        <p v-else-if="!units.length" class="status">
          Bu filtrede bir şey yok. Dışa aktarmaya hazır olabilirsiniz.
        </p>
        <ReviewTable
          v-else
          v-model:picked="picked"
          :project-id="selected!"
          :units="units"
          :project-path="project?.projectPath"
          :active-engine="engine"
          @changed="onChanged"
          @bulk="load"
          @page="goTo(page + 1)"
        />

        <!-- Pager Footer -->
        <div class="pager-footer">
          <div>
            Toplam <b>{{ total.toLocaleString('tr') }}</b> dizgeden
            <b>{{ Math.min(page * PAGE + 1, total) }} - {{ Math.min((page + 1) * PAGE, total) }}</b> arası
          </div>
          <div style="display: flex; align-items: center; gap: 8px;">
            <button class="btn" :disabled="page === 0" @click="goTo(page - 1)">« Önceki</button>
            <span style="font-weight: 700; color: #fff;">
              Sayfa {{ page + 1 }} / {{ Math.max(1, Math.ceil(total / PAGE)) }}
            </span>
            <button class="btn" :disabled="(page + 1) * PAGE >= total" @click="goTo(page + 1)">Sonraki »</button>
          </div>
          <div style="font-size: 11px; color: var(--text-subtle);">
            Kısayollar: <kbd style="background: var(--bg-elevated); padding: 2px 5px; border-radius: 3px;">J/K</kbd> Gezin · <kbd style="background: var(--bg-elevated); padding: 2px 5px; border-radius: 3px;">Enter</kbd> Onayla · <kbd style="background: var(--bg-elevated); padding: 2px 5px; border-radius: 3px;">E</kbd> Düzenle · <kbd style="background: var(--bg-elevated); padding: 2px 5px; border-radius: 3px;">R</kbd> Reddet · <kbd style="background: var(--bg-elevated); padding: 2px 5px; border-radius: 3px;">X</kbd> Seç
          </div>
        </div>
      </template>
    </main>

    <!-- ── Right-Side Collapsible Navigation Sidebar ── -->
    <aside class="sidebar" :class="{ collapsed: isSidebarCollapsed }">
      <div class="sidebar-header">
        <button
          class="collapse-btn"
          :title="isSidebarCollapsed ? 'Menüyü Genişlet' : 'Menüyü Daralt'"
          @click="toggleSidebar"
        >
          <svg v-if="isSidebarCollapsed" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="15 18 9 12 15 6"></polyline>
          </svg>
          <svg v-else width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="9 18 15 12 9 6"></polyline>
          </svg>
        </button>
        <div class="brand-icon">WP</div>
        <div class="brand-text">
          <span class="brand-name">wp-translator</span>
          <span class="brand-sub">GlotPress & AI</span>
        </div>
      </div>

      <div class="nav-section-title">Navigasyon</div>
      <nav class="nav-list">
        <button
          v-for="item in navItems"
          :key="item.screen"
          class="nav-item"
          :class="{ active: screen === item.screen }"
          :title="item.label"
          @click="screen = item.screen"
        >
          <span class="nav-icon" v-html="item.icon"></span>
          <span class="nav-label">{{ item.label }}</span>
          <span v-if="item.badge" class="nav-badge">{{ item.badge }}</span>
        </button>
      </nav>

      <div class="sidebar-footer">
        <div
          class="agent-status-badge"
          :title="`${activeAiAgents.length} CLI Motoru Aktif: ${activeAiAgents.map((a) => a.id).join(', ')}`"
        >
          <span class="agent-dot"></span>
          <span class="sidebar-footer-info">CLI AI: {{ activeAiAgents.length }} Aktif</span>
        </div>
      </div>
    </aside>

    <TranslateModal
      v-if="translating?.running"
      :progress="translating"
      @stop="stopRun"
    />
    <Toasts />
  </div>
</template>
