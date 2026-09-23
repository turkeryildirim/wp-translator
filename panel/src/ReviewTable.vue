<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import { saveUnit, type Unit } from './api.ts';
import UnitDetailPanel from './UnitDetailPanel.vue';

const props = defineProps<{ units: Unit[] }>();
const emit = defineEmits<{ changed: [Unit] }>();

const ROW_HEIGHT = 34;
const OVERSCAN = 8;

const cursor = ref(0);
const editing = ref(false);
// Keyed by unit id, not by row index: a virtualised row unmounts when it
// scrolls out of view, and the row being edited is exactly the one that must
// not lose its state.
const drafts = ref(new Map<number, string>());
const expanded = ref(new Set<number>());
const viewport = ref<HTMLElement | null>(null);
const scrollTop = ref(0);
const viewportHeight = ref(600);
const editor = ref<HTMLTextAreaElement | null>(null);

const current = computed(() => props.units[cursor.value]);

const windowRange = computed(() => {
  const first = Math.max(0, Math.floor(scrollTop.value / ROW_HEIGHT) - OVERSCAN);
  const visible = Math.ceil(viewportHeight.value / ROW_HEIGHT) + OVERSCAN * 2;
  return { first, last: Math.min(props.units.length, first + visible) };
});

const slice = computed(() =>
  props.units.slice(windowRange.value.first, windowRange.value.last).map((unit, index) => ({
    unit,
    index: windowRange.value.first + index,
  })),
);

const draftOf = (unit: Unit): string => drafts.value.get(unit.id) ?? unit.msgstr ?? '';

function setDraft(unit: Unit, value: string): void {
  drafts.value = new Map(drafts.value).set(unit.id, value);
}

function clearDraft(unit: Unit): void {
  const next = new Map(drafts.value);
  next.delete(unit.id);
  drafts.value = next;
}

function move(delta: number): void {
  cursor.value = Math.min(Math.max(cursor.value + delta, 0), props.units.length - 1);
  scrollIntoView(cursor.value);
}

// After approving, land on the next row still needing attention rather than on
// whatever slid into this index — otherwise holding Enter approves the wrong
// strings, which is the one mistake that is both easy and expensive.
function advance(): void {
  const next = props.units.findIndex((unit, index) => index > cursor.value && unit.state !== 'ok');
  cursor.value = next >= 0 ? next : Math.min(cursor.value + 1, props.units.length - 1);
  scrollIntoView(cursor.value);
}

function scrollIntoView(index: number): void {
  const element = viewport.value;
  if (!element) return;

  const top = index * ROW_HEIGHT;
  if (top < element.scrollTop) element.scrollTop = top;
  else if (top + ROW_HEIGHT > element.scrollTop + element.clientHeight) {
    element.scrollTop = top + ROW_HEIGHT - element.clientHeight;
  }
}

async function startEdit(): Promise<void> {
  if (!current.value) return;
  editing.value = true;
  await nextTick();
  editor.value?.focus();
  editor.value?.select();
}

function cancelEdit(): void {
  if (current.value) clearDraft(current.value);
  editing.value = false;
}

async function approve(withEdit: boolean): Promise<void> {
  const unit = current.value;
  if (!unit || unit.failures.length > 0) return;

  const { unit: saved } = await saveUnit(unit.id, withEdit ? { msgstr: draftOf(unit) } : {});

  clearDraft(unit);
  editing.value = false;
  emit('changed', saved);
  advance();
}

function chooseCandidate(position: number): void {
  const unit = current.value;
  const candidate = unit?.candidates[position];
  if (unit && candidate) setDraft(unit, candidate.translation);
}

function toggleDetail(): void {
  const unit = current.value;
  if (!unit) return;
  const next = new Set(expanded.value);
  if (next.has(unit.id)) next.delete(unit.id);
  else next.add(unit.id);
  expanded.value = next;
}

function onKey(event: KeyboardEvent): void {
  if (editing.value) {
    if (event.key === 'Escape') {
      event.preventDefault();
      cancelEdit();
    } else if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      void approve(true);
    }
    return;
  }

  if ((event.target as HTMLElement | null)?.tagName === 'INPUT') return;

  switch (event.key) {
    case 'j':
    case 'ArrowDown':
      event.preventDefault();
      move(1);
      break;
    case 'k':
    case 'ArrowUp':
      event.preventDefault();
      move(-1);
      break;
    case 'Enter':
      event.preventDefault();
      void approve(drafts.value.has(current.value?.id ?? -1));
      break;
    case 'e':
      event.preventDefault();
      void startEdit();
      break;
    case ' ':
      event.preventDefault();
      toggleDetail();
      break;
    default:
      if (/^[1-9]$/.test(event.key)) {
        event.preventDefault();
        chooseCandidate(Number(event.key) - 1);
      }
  }
}

function measure(): void {
  viewportHeight.value = viewport.value?.clientHeight ?? 600;
}

onMounted(() => {
  window.addEventListener('keydown', onKey);
  window.addEventListener('resize', measure);
  measure();
});

onUnmounted(() => {
  window.removeEventListener('keydown', onKey);
  window.removeEventListener('resize', measure);
});

watch(
  () => props.units,
  () => {
    cursor.value = 0;
  },
);
</script>

<template>
  <div class="review">
    <div
      ref="viewport"
      class="viewport"
      @scroll="scrollTop = ($event.target as HTMLElement).scrollTop"
    >
      <div class="spacer" :style="{ height: units.length * 34 + 'px' }">
        <div
          v-for="row in slice"
          :key="row.unit.id"
          class="row"
          :class="{
            active: row.index === cursor,
            blocked: row.unit.failures.length > 0,
            ambiguous: row.unit.candidates.length > 0,
            settled: row.unit.state === 'ok',
          }"
          :style="{ top: row.index * 34 + 'px' }"
          @click="cursor = row.index"
        >
          <span class="state">{{
            row.unit.state === 'ok' ? '✓' : row.unit.failures.length ? '!' : '·'
          }}</span>
          <span class="source">{{ row.unit.msgid }}</span>

          <textarea
            v-if="editing && row.index === cursor"
            ref="editor"
            class="target editor"
            :value="draftOf(row.unit)"
            rows="1"
            @input="setDraft(row.unit, ($event.target as HTMLTextAreaElement).value)"
          />
          <span v-else-if="row.unit.candidates.length" class="target candidates">
            <span v-for="(candidate, i) in row.unit.candidates" :key="candidate.tag">
              <kbd>{{ i + 1 }}</kbd> {{ candidate.translation }}
              <em>{{ candidate.tag }}</em>
            </span>
          </span>
          <span v-else class="target">{{ draftOf(row.unit) }}</span>

          <span v-if="row.unit.provenance" class="badge">{{ row.unit.provenance }}</span>
        </div>
      </div>
    </div>

    <aside v-if="current" class="detail">
      <p v-for="failure in current.failures" :key="failure.rule" class="failure">
        {{ failure.message }}
      </p>
      <UnitDetailPanel
        v-if="expanded.has(current.id) || current.structured"
        :unit-id="current.id"
      />
      <p v-else class="hint">Ayrıntı için <kbd>boşluk</kbd></p>
    </aside>
  </div>
</template>
