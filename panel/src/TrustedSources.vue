<script setup lang="ts">
import { nextTick, onMounted, onUnmounted, ref } from 'vue';
import {
  addSource,
  listSources,
  listTags,
  removeSource,
  reorderSources,
  setSourceTags,
  startSync,
  syncProgress,
  type SyncProgress,
  type Tag,
  type TrustedSource,
} from './api.ts';

const sources = ref<TrustedSource[]>([]);
const tags = ref<Tag[]>([]);
const url = ref('');
const chosenTags = ref<number[]>([]);
const error = ref('');
const progress = ref<SyncProgress | null>(null);
let poll: ReturnType<typeof setInterval> | null = null;

const dragging = ref<number | null>(null);
const dropTarget = ref<number | null>(null);

async function load(): Promise<void> {
  [sources.value, tags.value] = await Promise.all([listSources(), listTags()]);
}

async function add(): Promise<void> {
  error.value = '';
  try {
    await addSource(url.value.trim(), chosenTags.value);
    url.value = '';
    await load();
  } catch (problem) {
    error.value = problem instanceof Error ? problem.message : String(problem);
  }
}

async function drop(source: TrustedSource): Promise<void> {
  if (!confirm(`"${source.label ?? source.projectPath}" kaldırılsın mı?\n\nBu kaynağın tek başına desteklediği sözlük girdileri de silinir.`)) return;
  await removeSource(source.id);
  await load();
}

/**
 * Order decides most disagreements (R15), so it is edited directly.
 *
 * Dragging for the mouse, arrow keys on the focused handle for the keyboard —
 * one control rather than two, since with 41 sources a pair of nudge buttons
 * means forty clicks to move something to the top.
 */
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
  // Firefox needs data set or the drag never starts.
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

async function retag(source: TrustedSource, event: Event): Promise<void> {
  const chosen = [...(event.target as HTMLSelectElement).selectedOptions].map((option) =>
    Number(option.value),
  );
  await setSourceTags(source.id, chosen);
  await load();
}

async function sync(): Promise<void> {
  progress.value = await startSync();
  poll ??= setInterval(async () => {
    progress.value = await syncProgress();
    if (!progress.value.running) {
      clearInterval(poll!);
      poll = null;
      await load();
    }
  }, 700);
}

onMounted(load);
onUnmounted(() => {
  if (poll) clearInterval(poll);
});
</script>

<template>
  <section class="screen">
    <div class="toolbar">
      <input
        v-model="url"
        class="grow"
        placeholder="https://translate.wordpress.org/projects/…/tr/default/"
        @keyup.enter="add"
      />
      <select v-model="chosenTags" multiple size="1">
        <option v-for="tag in tags" :key="tag.id" :value="tag.id">{{ tag.name }}</option>
      </select>
      <button @click="add">Ekle</button>
      <button class="primary" :disabled="progress?.running" @click="sync">
        {{ progress?.running ? 'Güncelleniyor…' : 'Güncelle' }}
      </button>
    </div>

    <p v-if="error" class="failure">{{ error }}</p>

    <p v-if="progress?.running" class="status">
      {{ progress.done }} / {{ progress.total }} · {{ progress.current }}
    </p>
    <p v-else-if="progress?.finishedAt" class="status">
      Güncelleme bitti: {{ progress.done - 1 }} kaynak<span v-if="progress.glossaryTerms">
        + resmî sözlükten {{ progress.glossaryTerms }} terim</span
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
          <th>Sıra</th>
          <th>Proje</th>
          <th>Aile</th>
          <th>Etiket</th>
          <th class="num">Girdi</th>
          <th>Son güncelleme</th>
          <th />
        </tr>
      </thead>
      <tbody>
        <tr
          v-for="(source, index) in sources"
          :key="source.id"
          :class="{ dragging: dragging === index, dropinto: dropTarget === index && dragging !== index }"
          @dragover="onDragOver(index, $event)"
          @drop.prevent="onDrop(index)"
        >
          <td class="rank">
            <span
              class="draghandle"
              draggable="true"
              tabindex="0"
              role="button"
              :aria-label="`Sıra ${index + 1}. Taşımak için sürükleyin ya da yukarı/aşağı ok tuşlarını kullanın.`"
              @dragstart="onDragStart(index, $event)"
              @dragend="dragging = null; dropTarget = null"
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
          <td>
            <select multiple size="1" class="tagpick" @change="retag(source, $event)">
              <option
                v-for="tag in tags"
                :key="tag.id"
                :value="tag.id"
                :selected="source.tagIds.includes(tag.id)"
              >
                {{ tag.name }}
              </option>
            </select>
          </td>
          <td class="num">{{ source.entries.toLocaleString('tr') }}</td>
          <td class="muted">{{ source.lastSyncedAt ?? 'hiç' }}</td>
          <td><button @click="drop(source)">Kaldır</button></td>
        </tr>
      </tbody>
    </table>

    <p class="hint">
      Bu liste kurulumla birlikte gelir: WordPress çekirdeği, büyük eklentiler, tema, mobil
      uygulamalar ve meta siteler. Hepsi tek bir <code>wordpress</code> etiketi altında başlar.
      <b>Ayırmak sizin kararınız</b> — örneğin WooCommerce'i kendi etiketine almak,
      <code>item</code> kelimesinin orada <code>ürün</code>, başka yerde <code>öge</code> çıkmasını
      sağlayan şey.
    </p>
    <p class="hint">
      Sıra önemli: iki kaynak aynı metni farklı çevirdiğinde çoğunluk kazanır, berabere kalırsa
      üstteki. Ölçümde çakışmaların %88'i beraberlik, yani kararı çoğu zaman bu sıra veriyor.
      Satırları <b>⠿</b> tutamağından sürükleyerek, ya da tutamağa odaklanıp ok tuşlarıyla
      taşıyabilirsiniz.
    </p>
  </section>
</template>
