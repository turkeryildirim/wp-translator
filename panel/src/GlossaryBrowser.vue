<script setup lang="ts">
import { nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import {
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
const page = ref(0);
const loading = ref(false);

const selected = ref<GlossaryEntry | null>(null);
const vouchers = ref<EntrySource[]>([]);
const contexts = ref<string[]>([]);
const draft = ref('');
const notice = ref('');

/**
 * Which request is the current one.
 *
 * Holding the arrows down fires a page per click, and every one of them is a
 * scan of the glossary on a synchronous database. The arrows going dead while a
 * page is in flight is the real guard; this is the second one, so that a reply
 * that arrives after a newer request cannot paint an older page over it.
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

    const result = await searchGlossary(params);
    if (mine !== ticket) return;

    rows.value = result.rows;
    total.value = result.total;
    // Cleared only once the rows are on screen, so the arrows do not come back
    // to life a frame before the page they loaded.
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
  selected.value = entry;
  draft.value = entry.translation;
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
  const { entry, sourceWordingReturns } = await updateEntry(selected.value.id, draft.value);

  const index = rows.value.findIndex((row) => row.id === entry.id);
  if (index >= 0) rows.value[index] = entry;
  selected.value = entry;

  notice.value = sourceWordingReturns
    ? 'Kaydedildi. Bu sizin girdiniz oldu; kaynağın kendi çevirisi sonraki güncellemede ikinci bir seçenek olarak geri gelecek, ama doldurmada sizinki önde.'
    : 'Kaydedildi.';
}

function applyFilters(): void {
  page.value = 0;
  void load();
}

const screenEl = ref<HTMLElement | null>(null);
/**
 * How tall the pinned detail panel is allowed to get.
 *
 * It is sticky, and a sticky box taller than what it is pinned inside has an
 * unreachable bottom — the Kaydet button disappeared below the window once an
 * entry had enough vouchers. The scrollport here is `.screen`, whose top is
 * fixed by the layout, so the room below it is what the panel may use.
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
      <button @click="applyFilters">Ara</button>
    </div>

    <Pager :page="page" :total="total" :page-size="PAGE" :busy="loading" @go="goTo" />
    <Legend />

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

      <aside v-if="selected" class="detail">
        <h3><Reveal :value="selected.sourceText" /></h3>
        <p v-if="selected.sourcePlural" class="note">
          çoğul: <Reveal :value="selected.sourcePlural" />
        </p>
        <p v-if="selected.note" class="note">{{ selected.note }}</p>

        <!-- The box cannot show what it holds, so the stored wording is shown
             above it. Whitespace is exactly what an edit gets wrong. -->
        <p class="note stored"><Reveal :value="selected.translation" /></p>

        <label>
          Çeviri
          <!-- Enter inserts a newline here rather than saving: a translation can
               legitimately contain one, and losing it to a shortcut is worse
               than one extra click on Kaydet. -->
          <textarea v-model="draft" rows="3" @keydown.ctrl.enter.prevent="save" />
        </label>
        <button class="primary" @click="save">Kaydet</button>
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
          <!-- Informational: matching ignores these. They answer why the same
               string has more than one translation in the glossary. -->
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

    <!-- Repeated at the foot: a hundred rows is further than a screen, and
         paging from the bottom should not mean scrolling back up first. -->
    <Pager :page="page" :total="total" :page-size="PAGE" :busy="loading" @go="goTo" />
  </section>
</template>
