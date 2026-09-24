<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref } from 'vue';
import {
  addSource,
  bulkDeleteSources,
  bulkTagSources,
  createTag,
  listSources,
  listTags,
  reorderSources,
  searchGlossary,
  setSourceTags,
  startSync,
  syncProgress,
  type SyncProgress,
  type Tag,
  type TrustedSource,
} from './api.ts';
import { notify } from './notify.ts';

const sources = ref<TrustedSource[]>([]);
const tags = ref<Tag[]>([]);
const glossaryTotal = ref(0);
const url = ref('');
const newTag = ref('');
const error = ref('');
const notice = ref('');
const adding = ref(false);
const progress = ref<SyncProgress | null>(null);
let poll: ReturnType<typeof setInterval> | null = null;

const picked = ref(new Set<number>());
const dragging = ref<number | null>(null);
const dropTarget = ref<number | null>(null);
const openTagMenu = ref<number | null>(null);

const allPicked = computed(
  () => sources.value.length > 0 && picked.value.size === sources.value.length,
);
const pickedIds = computed(() => [...picked.value]);

/**
 * Sum of the column: one source vouching for one entry.
 *
 * Larger than the glossary, because sources overlap — `Save` is in core and in
 * most plugins, and each of them vouches for the same entry.
 */
const totalVouches = computed(() => sources.value.reduce((sum, s) => sum + s.entries, 0));

async function load(): Promise<void> {
  const [list, tagList, glossary] = await Promise.all([
    listSources(),
    listTags(),
    searchGlossary({ limit: '1' }),
  ]);
  sources.value = list;
  tags.value = tagList;
  glossaryTotal.value = glossary.total;
  picked.value = new Set([...picked.value].filter((id) => list.some((s) => s.id === id)));
}

async function add(): Promise<void> {
  error.value = '';
  notice.value = '';
  adding.value = true;
  try {
    // The server normalises the address and checks the project really exports
    // before storing it: a typo otherwise sits in the list looking fine and
    // fails on every Update.
    await addSource(url.value, []);
    url.value = '';
    await load();
  } catch (problem) {
    error.value = problem instanceof Error ? problem.message : String(problem);
  } finally {
    adding.value = false;
  }
}

function togglePick(id: number): void {
  const next = new Set(picked.value);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  picked.value = next;
}

function toggleAll(): void {
  picked.value = allPicked.value ? new Set() : new Set(sources.value.map((s) => s.id));
}

function pickByTag(tagId: number): void {
  picked.value = new Set(
    sources.value.filter((source) => source.tagIds.includes(tagId)).map((source) => source.id),
  );
}

async function dropPicked(): Promise<void> {
  const count = pickedIds.value.length;
  if (
    !confirm(
      `${count} kaynak kaldırılsın mı?\n\nYalnızca bunların desteklediği sözlük girdileri de silinir.`,
    )
  )
    return;

  const { removed } = await bulkDeleteSources(pickedIds.value);
  notice.value = `${removed} kaynak kaldırıldı.`;
  picked.value = new Set();
  await load();
}

async function tagPicked(tagId: number, action: 'add' | 'remove'): Promise<void> {
  const { changed } = await bulkTagSources(
    pickedIds.value,
    action === 'add' ? { add: [tagId] } : { remove: [tagId] },
  );
  const name = tags.value.find((tag) => tag.id === tagId)?.name ?? '';
  notice.value =
    changed === 0
      ? 'Değişen bir şey yok.'
      : `${changed} kaynakta "${name}" etiketi ${action === 'add' ? 'eklendi' : 'kaldırıldı'}.`;
  await load();
}

async function addTag(): Promise<void> {
  if (!newTag.value.trim()) return;
  await createTag(newTag.value);
  newTag.value = '';
  await load();
}

async function toggleTag(source: TrustedSource, tagId: number): Promise<void> {
  const next = source.tagIds.includes(tagId)
    ? source.tagIds.filter((id) => id !== tagId)
    : [...source.tagIds, tagId];
  await setSourceTags(source.id, next);
  await load();
}

async function moveTo(from: number, to: number): Promise<void> {
  if (to < 0 || to >= sources.value.length || from === to) return;

  const next = [...sources.value];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved!);

  sources.value = next;
  await reorderSources(next.map((source) => source.id));
}

function onDragStart(index: number, event: DragEvent): void {
  dragging.value = index;
  event.dataTransfer!.effectAllowed = 'move';
  event.dataTransfer!.setData('text/plain', String(index));
}

function onDragOver(index: number, event: DragEvent): void {
  if (dragging.value === null) return;
  event.preventDefault();
  event.dataTransfer!.dropEffect = 'move';
  dropTarget.value = index;
}

async function onDrop(index: number): Promise<void> {
  const from = dragging.value;
  dragging.value = null;
  dropTarget.value = null;
  if (from !== null) await moveTo(from, index);
}

async function onHandleKey(index: number, event: KeyboardEvent): Promise<void> {
  const delta = event.key === 'ArrowUp' ? -1 : event.key === 'ArrowDown' ? 1 : 0;
  if (delta === 0) return;

  event.preventDefault();
  await moveTo(index, index + delta);
  // Keep focus on the handle that moved, so a run of presses keeps working.
  await nextTick();
  (document.querySelectorAll('.draghandle')[index + delta] as HTMLElement | undefined)?.focus();
}

async function sync(): Promise<void> {
  progress.value = await startSync();
  poll ??= setInterval(async () => {
    progress.value = await syncProgress();
    if (!progress.value.running) {
      clearInterval(poll!);
      poll = null;
      await load();
      // The update runs for over a minute in the background, so the corner is
      // where its result is reported — the owner has usually looked away.
      report(progress.value);
    }
  }, 700);
}

function report(done: SyncProgress): void {
  if (done.errors.length) {
    notify('error', `Güncelleme bitti, ${done.errors.length} kaynak hata verdi.`);
    return;
  }
  const merged = done.collapsed ? `, ${done.collapsed} yinelenen girdi birleştirildi` : '';
  notify('ok', `Güncelleme bitti: ${done.done - 1} kaynak${merged}.`);
}

onMounted(load);
onUnmounted(() => {
  if (poll) clearInterval(poll);
});
</script>

<template>
  <section class="screen" @click="openTagMenu = null">
    <div class="toolbar">
      <input
        v-model="url"
        class="grow"
        placeholder="translate.wordpress.org/projects/… (https:// isteğe bağlı)"
        @keyup.enter="add"
      />
      <button :disabled="adding" @click="add">{{ adding ? 'Denetleniyor…' : 'Ekle' }}</button>
      <button class="primary" :disabled="progress?.running" @click="sync">
        {{ progress?.running ? 'Güncelleniyor…' : 'Güncelle' }}
      </button>
    </div>

    <div class="toolbar">
      <input v-model="newTag" placeholder="Yeni etiket" @keyup.enter="addTag" />
      <button @click="addTag">Etiket oluştur</button>
      <span class="muted">Etikete göre seç:</span>
      <button v-for="tag in tags" :key="tag.id" @click="pickByTag(tag.id)">{{ tag.name }}</button>
    </div>

    <p v-if="error" class="failure">{{ error }}</p>
    <p v-if="notice" class="notice">{{ notice }}</p>

    <div v-if="picked.size" class="bulkbar">
      <b>{{ picked.size }} seçili</b>
      <button @click="dropPicked">Kaldır</button>
      <span class="muted">Etiket ekle:</span>
      <button v-for="tag in tags" :key="'a' + tag.id" @click="tagPicked(tag.id, 'add')">
        + {{ tag.name }}
      </button>
      <span class="muted">Çıkar:</span>
      <button v-for="tag in tags" :key="'r' + tag.id" @click="tagPicked(tag.id, 'remove')">
        − {{ tag.name }}
      </button>
      <button @click="picked = new Set()">Seçimi temizle</button>
    </div>

    <p v-if="progress?.running" class="status">
      {{ progress.done }} / {{ progress.total }} · {{ progress.current }}
    </p>
    <p v-else-if="progress?.finishedAt" class="status">
      Güncelleme bitti: {{ progress.done - 1 }} kaynak<span v-if="progress.glossaryTerms">
        + resmî sözlükten {{ progress.glossaryTerms }} terim</span
      ><span v-if="progress.collapsed">
        · {{ progress.collapsed }} yinelenen girdi birleştirildi</span
      >.
      <span v-if="progress.errors.length" class="failure-inline">
        {{ progress.errors.length }} hata
      </span>
    </p>
    <ul v-if="progress?.errors.length" class="errors">
      <li v-for="problem in progress.errors" :key="problem.source">
        <b>{{ problem.source }}</b> — {{ problem.message }}
      </li>
    </ul>

    <table class="grid">
      <thead>
        <tr>
          <th><input type="checkbox" :checked="allPicked" @change="toggleAll" /></th>
          <th>Sıra</th>
          <th>Proje</th>
          <th>Aile</th>
          <th>Etiket</th>
          <th class="num">Girdi</th>
          <th>Son güncelleme</th>
        </tr>
      </thead>
      <tbody>
        <tr
          v-for="(source, index) in sources"
          :key="source.id"
          :class="{
            dragging: dragging === index,
            dropinto: dropTarget === index && dragging !== index,
            on: picked.has(source.id),
          }"
          @dragover="onDragOver(index, $event)"
          @drop.prevent="onDrop(index)"
        >
          <td>
            <input
              type="checkbox"
              :checked="picked.has(source.id)"
              @change="togglePick(source.id)"
            />
          </td>
          <td class="rank">
            <span
              class="draghandle"
              draggable="true"
              tabindex="0"
              role="button"
              :aria-label="`Sıra ${index + 1}. Sürükleyin ya da ok tuşlarını kullanın.`"
              @dragstart="onDragStart(index, $event)"
              @dragend="
                dragging = null;
                dropTarget = null;
              "
              @keydown="onHandleKey(index, $event)"
              >⠿</span
            >
            {{ index + 1 }}
          </td>
          <td>
            <a :href="source.translateUrl" target="_blank" rel="noreferrer">
              {{ source.label ?? source.projectPath }}
            </a>
          </td>
          <td class="muted">{{ source.family }}</td>
          <td class="tagcell">
            <button
              v-for="tag in tags.filter((t) => source.tagIds.includes(t.id))"
              :key="tag.id"
              class="chip"
              :title="`${tag.name} etiketini kaldır`"
              @click.stop="toggleTag(source, tag.id)"
            >
              {{ tag.name }} ×
            </button>
            <button
              class="chip add"
              title="Etiket ekle"
              @click.stop="openTagMenu = openTagMenu === source.id ? null : source.id"
            >
              +
            </button>
            <span v-if="openTagMenu === source.id" class="tagmenu" @click.stop>
              <button
                v-for="tag in tags.filter((t) => !source.tagIds.includes(t.id))"
                :key="tag.id"
                @click="
                  toggleTag(source, tag.id);
                  openTagMenu = null;
                "
              >
                {{ tag.name }}
              </button>
              <em v-if="tags.every((t) => source.tagIds.includes(t.id))">hepsi ekli</em>
            </span>
          </td>
          <td class="num">{{ source.entries.toLocaleString('tr') }}</td>
          <td class="muted">{{ source.lastSyncedAt ?? 'hiç' }}</td>
        </tr>
      </tbody>
      <tfoot>
        <tr>
          <td colspan="5">
            <b>{{ sources.length }} kaynak</b>
          </td>
          <td class="num">
            <b>{{ totalVouches.toLocaleString('tr') }}</b>
          </td>
          <td class="muted">toplam destek</td>
        </tr>
      </tfoot>
    </table>

    <p class="hint">
      Sözlükte <b>{{ glossaryTotal.toLocaleString('tr') }}</b> benzersiz girdi var. Yukarıdaki
      {{ totalVouches.toLocaleString('tr') }} bundan büyük, çünkü kaynaklar örtüşüyor:
      <code>Save</code> hem çekirdekte hem çoğu eklentide geçer ve her biri aynı girdiyi destekler.
    </p>
    <p class="hint">
      Aile adresten çıkarılır, düzenlenmez. Yanlış adres verdiyseniz kaldırıp yeniden ekleyin —
      ekleme sırasında adres denetlenir, dışa aktarma vermeyen bir proje listeye girmez.
    </p>
    <p class="hint">
      Sıra önemli: iki kaynak aynı metni farklı çevirdiğinde çoğunluk kazanır, berabere kalırsa
      üstteki. Ölçümde çakışmaların %88'i beraberlik, yani kararı çoğu zaman bu sıra veriyor.
      Satırları <b>⠿</b> tutamağından sürükleyerek ya da ok tuşlarıyla taşıyın.
    </p>
  </section>
</template>
