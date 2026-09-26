<script setup lang="ts">
import { nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import {
  createEntry,
  deleteEntry,
  entryDetail,
  listTags,
  searchGlossary,
  updateEntry,
  type EntrySource,
  type GlossaryEntry,
  type Tag,
} from './api.ts';
import Pager from './Pager.vue';
import Legend from './Legend.vue';
import Reveal from './Reveal.vue';

const PAGE = 100;

const rows = ref<GlossaryEntry[]>([]);
const total = ref(0);
const tags = ref<Tag[]>([]);
const search = ref('');
const tagId = ref('');
const kind = ref<'' | 'memory' | 'term'>('');
const contested = ref(false);
const caseSensitive = ref(false);
const scope = ref<'' | 'source' | 'translation'>('');
const page = ref(0);
const loading = ref(false);

const selected = ref<GlossaryEntry | null>(null);
const vouchers = ref<EntrySource[]>([]);
const contexts = ref<string[]>([]);
const draft = ref('');
const draftPlural = ref('');
const notice = ref('');

/** The form for an entry of the owner's own, open or not. */
const adding = ref(false);
const fresh = ref({ sourceText: '', sourcePlural: '', translation: '', translationPlural: '' });
const freshTagId = ref('');

/**
 * Which request is the current one, so a reply arriving after a newer request
 * cannot paint an older page over it.
 */
let ticket = 0;

async function load(): Promise<void> {
  const mine = (ticket += 1);
  loading.value = true;
  try {
    const params: Record<string, string> = {
      limit: String(PAGE),
      offset: String(page.value * PAGE),
    };
    if (search.value) params.q = search.value;
    if (tagId.value) params.tag = tagId.value;
    if (kind.value) params.kind = kind.value;
    if (contested.value) params.contested = '1';
    if (caseSensitive.value) params.case = '1';
    if (scope.value) params.in = scope.value;

    const result = await searchGlossary(params);
    if (mine !== ticket) return;

    rows.value = result.rows;
    total.value = result.total;
    // Cleared once the rows are on screen, not a frame before.
    await nextTick();
  } finally {
    if (mine === ticket) loading.value = false;
  }
}

function goTo(next: number): void {
  if (loading.value) return;
  page.value = next;
}

async function select(entry: GlossaryEntry): Promise<void> {
  adding.value = false;
  selected.value = entry;
  draft.value = entry.translation;
  draftPlural.value = entry.translationPlural ?? '';
  notice.value = '';
  vouchers.value = [];
  contexts.value = [];
  if (entry.sources > 0 || entry.contexts > 0) {
    const detail = await entryDetail(entry.id);
    vouchers.value = detail.sources;
    contexts.value = detail.contexts;
  }
}

async function save(): Promise<void> {
  if (!selected.value) return;
  const { entry, sourceWordingReturns } = await updateEntry(
    selected.value.id,
    draft.value,
    selected.value.sourcePlural === null ? undefined : draftPlural.value,
  );

  const index = rows.value.findIndex((row) => row.id === entry.id);
  if (index >= 0) rows.value[index] = entry;
  selected.value = entry;
  draftPlural.value = entry.translationPlural ?? '';

  notice.value = sourceWordingReturns
    ? 'Kaydedildi. Bu sizin girdiniz oldu; kaynağın kendi çevirisi sonraki güncellemede ikinci bir seçenek olarak geri gelecek, ama doldurmada sizinki önde.'
    : 'Kaydedildi.';
}

function applyFilters(): void {
  page.value = 0;
  void load();
}

function openForm(): void {
  selected.value = null;
  notice.value = '';
  fresh.value = { sourceText: '', sourcePlural: '', translation: '', translationPlural: '' };
  freshTagId.value = tagId.value || String(tags.value[0]?.id ?? '');
  adding.value = true;
}

async function add(): Promise<void> {
  const entry = await createEntry({
    sourceText: fresh.value.sourceText,
    ...(fresh.value.sourcePlural ? { sourcePlural: fresh.value.sourcePlural } : {}),
    translation: fresh.value.translation,
    ...(fresh.value.translationPlural ? { translationPlural: fresh.value.translationPlural } : {}),
    tagId: Number(freshTagId.value),
  });

  adding.value = false;
  // Reloaded rather than unshifted: the new entry belongs wherever the current
  // filters and sort put it, which may be off this page entirely.
  await load();
  await select(entry);
}

async function remove(): Promise<void> {
  const entry = selected.value;
  if (!entry) return;
  if (!confirm(`"${entry.sourceText}" → "${entry.translation}" girdisi silinsin mi?`)) return;

  const { returnsOnSync } = await deleteEntry(entry.id);
  selected.value = null;
  await load();

  notice.value = returnsOnSync
    ? 'Silindi. Bu girdiyi bir güvenilir kaynak taşıyor, bu yüzden o kaynağın sonraki güncellemesinde geri gelecek. Kalıcı olarak çıkarmak için kaynağı listeden çıkarın.'
    : 'Silindi.';
}

const screenEl = ref<HTMLElement | null>(null);
/**
 * How tall the pinned detail panel may get. A sticky box taller than what it is
 * pinned inside has an unreachable bottom, so it is bounded by the room below
 * the scrollport's fixed top edge.
 */
const dockMax = ref('100dvh');

function measureDock(): void {
  const el = screenEl.value;
  if (!el) return;
  const styles = getComputedStyle(el);
  const spare = el.getBoundingClientRect().top + parseFloat(styles.paddingBottom || '0');
  dockMax.value = `calc(100dvh - ${Math.round(spare)}px)`;
}

onMounted(() => {
  measureDock();
  window.addEventListener('resize', measureDock);
});
onUnmounted(() => window.removeEventListener('resize', measureDock));

onMounted(async () => {
  tags.value = await listTags();
  await load();
});

watch(page, load);
</script>

<template>
  <section ref="screenEl" class="screen glossary" :style="{ '--dock-max': dockMax }">
    <div class="toolbar">
      <input v-model="search" class="grow" placeholder="Kaynak ya da çeviride ara…" @keyup.enter="applyFilters" />
      <select v-model="tagId" @change="applyFilters">
        <option value="">Tüm etiketler</option>
        <option v-for="tag in tags" :key="tag.id" :value="String(tag.id)">
          {{ tag.name }} ({{ tag.entries.toLocaleString('tr') }})
        </option>
      </select>
      <select v-model="kind" @change="applyFilters">
        <option value="">Bellek + terim</option>
        <option value="memory">Yalnız çeviri belleği</option>
        <option value="term">Yalnız terimler</option>
      </select>
      <label class="check">
        <input v-model="contested" type="checkbox" @change="applyFilters" />
        Kaynaklar çelişiyor
      </label>
      <label class="check" title="Kapalıyken İ/ı/I/i aynı sayılır ve büyük-küçük harf gözetilmez">
        <input v-model="caseSensitive" type="checkbox" @change="applyFilters" />
        Harf duyarlı
      </label>
      <select v-model="scope" aria-label="Nerede aransın" @change="applyFilters">
        <option value="">Kaynak + çeviri</option>
        <option value="source">Yalnızca kaynak</option>
        <option value="translation">Yalnızca çeviri</option>
      </select>
      <button @click="applyFilters">Ara</button>
      <button @click="openForm">Yeni girdi</button>
    </div>

    <Pager :page="page" :total="total" :page-size="PAGE" :busy="loading" @go="goTo" />
    <Legend />

    <!-- Shown here because a removal leaves nothing selected to show it beside. -->
    <p v-if="notice && !selected" class="notice">{{ notice }}</p>

    <div class="split">
      <table class="grid">
        <thead>
          <tr>
            <th>Kaynak</th>
            <th>Çeviri</th>
            <th>Etiket</th>
            <th class="num">Kaynak sayısı</th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="row in rows"
            :key="row.id"
            :class="{ on: selected?.id === row.id, term: row.pos !== null }"
            @click="select(row)"
          >
            <td>
              <div class="clamp">
                <Reveal :value="row.sourceText" />
                <em v-if="row.pos" class="pos">{{ row.pos }}</em>
                <em v-if="row.msgctxt" class="ctx">{{ row.msgctxt }}</em>
              </div>
            </td>
            <td>
              <div class="clamp"><Reveal :value="row.translation" /></div>
            </td>
            <td class="muted">{{ row.tag }}</td>
            <td class="num">{{ row.sources || (row.origin === 'owner' ? '—' : 0) }}</td>
          </tr>
        </tbody>
      </table>

      <aside v-if="adding" class="detail">
        <h3>Yeni girdi</h3>
        <!-- The owner's own entry: translation memory under one tag, no context.
             `msgctxt` is not part of the key and matching never reads it. -->
        <label>
          Kaynak — tekil
          <textarea v-model="fresh.sourceText" rows="2" />
        </label>
        <label>
          Kaynak — çoğul (varsa)
          <textarea v-model="fresh.sourcePlural" rows="2" />
        </label>
        <label>
          Çeviri — tekil
          <textarea v-model="fresh.translation" rows="3" />
        </label>
        <label v-if="fresh.sourcePlural">
          Çeviri — çoğul
          <textarea v-model="fresh.translationPlural" rows="3" />
        </label>
        <label>
          Etiket
          <select v-model="freshTagId">
            <option v-for="tag in tags" :key="tag.id" :value="String(tag.id)">{{ tag.name }}</option>
          </select>
        </label>
        <div class="editor-actions">
          <button
            class="primary"
            :disabled="!fresh.sourceText.trim() || !fresh.translation.trim() || !freshTagId"
            @click="add"
          >
            Ekle
          </button>
          <button @click="adding = false">Vazgeç</button>
        </div>
        <p class="hint">
          Sizin girdiniz olarak eklenir: güvenilir kaynak güncellemeleri silmez. Baştaki ve sondaki
          boşluklar biçim sayılır, saklanmaz.
        </p>
      </aside>

      <aside v-else-if="selected" class="detail">
        <h3><Reveal :value="selected.sourceText" /></h3>
        <p v-if="selected.note" class="note">{{ selected.note }}</p>

        <!-- The box cannot mark invisible characters, so the stored wording is
             shown above it. -->
        <p class="note stored"><Reveal :value="selected.translation" /></p>

        <label>
          {{ selected.sourcePlural ? 'Çeviri — tekil' : 'Çeviri' }}
          <!-- Enter inserts a newline; a translation can legitimately hold one. -->
          <textarea v-model="draft" rows="3" @keydown.ctrl.enter.prevent="save" />
        </label>

        <!-- A source with a plural needs both halves, exactly as a project unit
             does; both are part of the entry's key. -->
        <template v-if="selected.sourcePlural">
          <p class="stored"><Reveal :value="selected.sourcePlural" /></p>
          <label>
            Çeviri — çoğul
            <textarea v-model="draftPlural" rows="3" @keydown.ctrl.enter.prevent="save" />
          </label>
        </template>
        <div class="editor-actions">
          <button class="primary" @click="save">Kaydet</button>
          <button title="Kaynağı çeviri alanına kopyala" @click="draft = selected.sourceText">
            Orijinali kopyala
          </button>
          <button
            class="danger"
            :title="selected.sources > 0
              ? 'Bu girdiyi bir güvenilir kaynak taşıyor; sonraki güncellemede geri gelir'
              : 'Bu girdiyi kalıcı olarak sil'"
            @click="remove"
          >
            Sil
          </button>
        </div>
        <p v-if="notice" class="notice">{{ notice }}</p>

        <template v-if="vouchers.length">
          <h4>Bu girdiyi destekleyen kaynaklar</h4>
          <ul class="vouchers">
            <li v-for="voucher in vouchers" :key="voucher.projectPath">
              <b>{{ voucher.rank }}.</b> {{ voucher.label ?? voucher.projectPath }}
              <span :class="{ differs: voucher.translation !== selected.translation }">
                {{ voucher.translation }}
              </span>
            </li>
          </ul>
        </template>
        <template v-if="contexts.length">
          <h4>Geçtiği bağlamlar</h4>
          <!-- Informational: matching ignores these. -->
          <ul class="vouchers">
            <li v-for="ctx in contexts" :key="ctx"><code>{{ ctx }}</code></li>
          </ul>
        </template>

        <p v-if="selected.readings > 1" class="note">
          Bu kaynağın bu etiket altında <b>{{ selected.readings }}</b> çevirisi var. İncelemede
          hepsi aday olarak çıkar; en çok kaynak tarafından desteklenen doldurulur.
        </p>

        <p v-else-if="selected.origin === 'owner'" class="hint">
          Sizin girdiniz. Güvenilir kaynaklardan gelmiyor, güncellemeler silmez.
        </p>
      </aside>
    </div>

    <!-- Repeated at the foot; a page of rows is further than a screen. -->
    <Pager :page="page" :total="total" :page-size="PAGE" :busy="loading" @go="goTo" />
  </section>
</template>
