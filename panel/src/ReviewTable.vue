<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import { overrideCheck, saveUnit, type Unit } from './api.ts';
import Reveal from './Reveal.vue';
import { notify } from './notify.ts';
import UnitDetailPanel from './UnitDetailPanel.vue';

/**
 * Selection lives on the screen above, with the actions that consume it.
 * Keeping it here meant two places offering to select things, which is what
 * made the screen confusing to begin with.
 */
const props = defineProps<{ units: Unit[]; picked: number[] }>();
const emit = defineEmits<{ changed: [Unit]; bulk: []; 'update:picked': [number[]]; page: [] }>();

const pickedSet = computed(() => new Set(props.picked));

function setPicked(id: number, on: boolean): void {
  const next = new Set(props.picked);
  if (on) next.add(id);
  else next.delete(id);
  emit('update:picked', [...next]);
}

const cursor = ref(0);
const editing = ref(false);
// Keyed by unit id rather than by row index, so a draft survives the list being
// reloaded under it.
const drafts = ref(new Map<number, string>());
const editor = ref<HTMLTextAreaElement | null>(null);
const rowEls = ref<HTMLElement[]>([]);

const current = computed(() => props.units[cursor.value]);

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
  const next = cursor.value + delta;
  // Past the end of a page, ask for the next one rather than stopping on the
  // last row: the queue is paged now, and a project runs to thousands.
  if (next >= props.units.length) {
    emit('page');
    return;
  }
  cursor.value = Math.max(next, 0);
  scrollIntoView(cursor.value);
}

// After approving, land on the next row still needing attention rather than on
// whatever slid into this index — otherwise holding Enter approves the wrong
// strings, which is the one mistake that is both easy and expensive.
function advance(): void {
  const next = props.units.findIndex((unit, index) => index > cursor.value && unit.state !== 'ok');
  if (next >= 0) {
    cursor.value = next;
    scrollIntoView(cursor.value);
    return;
  }
  move(1);
}

/** Let the browser decide how far to scroll; rows are no longer a fixed size. */
function scrollIntoView(index: number): void {
  rowEls.value[index]?.scrollIntoView({ block: 'nearest' });
}

/** `e` puts the caret in the panel's box; there is nowhere else to type. */
async function startEdit(): Promise<void> {
  if (!current.value) return;
  await nextTick();
  editor.value?.focus();
  editor.value?.select();
}

function cancelEdit(): void {
  if (current.value) clearDraft(current.value);
  editor.value?.blur();
}

/**
 * Empty a unit and move on.
 *
 * Rejecting is not a state of its own: the translation goes, the unit returns
 * to untranslated, and the next AI run picks it up. Saving an empty string is
 * what the server reads as that.
 */
async function reject(): Promise<void> {
  const unit = current.value;
  if (!unit) return;

  const { unit: saved } = await saveUnit(unit.id, { msgstr: '' });
  notify('ok', 'Reddedildi');
  clearDraft(unit);
  editing.value = false;
  emit('changed', saved);
  advance();
}

async function approve(withEdit: boolean): Promise<void> {
  const unit = current.value;
  if (!unit) return;

  // Blocked rows used to refuse silently, so approving one looked like a key
  // that did not work. Say what is wrong and what the two ways out are.
  if (unit.failures.length > 0) {
    notify(
      'error',
      `${unit.failures[0]!.message} — düzeltmek için "e", kuralı atlamak için sağdaki düğme.`,
    );
    return;
  }

  const { unit: saved, blocked } = await saveUnit(
    unit.id,
    withEdit ? { msgstr: draftOf(unit) } : {},
  );

  // A refused save answers 200 with the failures, so the outcome is in the
  // body, not the status.
  if (blocked?.length)
    notify('error', `Kaydedilmedi, kalite kontrolü engelledi: ${blocked[0]!.rule}`);
  else notify('ok', 'Onaylandı');

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

function togglePick(): void {
  const unit = current.value;
  if (unit) setPicked(unit.id, !pickedSet.value.has(unit.id));
}


/**
 * Record that this check is deliberately not met here, then save again so the
 * unit is re-judged without it.
 *
 * The reason is asked for rather than assumed. A check the owner overrides is
 * either wrong about this string or wrong in general, and the note is what
 * tells those apart later.
 */
async function skipCheck(unit: Unit, rule: string): Promise<void> {
  const reason = prompt(`"${rule}" kuralı bu dizgede neden atlanıyor?`);
  if (!reason?.trim()) return;

  await overrideCheck(unit.id, rule, reason.trim());
  const { unit: saved } = await saveUnit(unit.id, {});
  emit('changed', saved);
}

/** Keep the edit without settling the row — the string stays where it is. */
async function saveOnly(): Promise<void> {
  const unit = current.value;
  if (!unit) return;

  const { unit: saved, blocked } = await saveUnit(unit.id, { msgstr: draftOf(unit) });
  if (blocked?.length) notify('error', `Kaydedildi ama onaylanmadı: ${blocked[0]!.rule}`);
  else notify('ok', 'Kaydedildi');
  clearDraft(unit);
  emit('changed', saved);
}


function onKey(event: KeyboardEvent): void {
  // While the caret is in the box, only the combinations survive: everything
  // else is someone typing a translation.
  if (editing.value) {
    if (event.key === 'Escape') {
      event.preventDefault();
      cancelEdit();
    } else if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      void approve(true);
    } else if (event.key === 'Enter' && event.shiftKey) {
      event.preventDefault();
      void reject();
    } else if (
      (event.ctrlKey || event.metaKey) &&
      (event.key === 'ArrowUp' || event.key === 'ArrowDown')
    ) {
      event.preventDefault();
      move(event.key === 'ArrowDown' ? 1 : -1);
    }
    return;
  }

  if ((event.target as HTMLElement | null)?.tagName === 'INPUT') return;

  // Ctrl+arrow moves the cursor even while a modifier is held, so a run of
  // approvals never needs the hand to leave Ctrl.
  if ((event.ctrlKey || event.metaKey) && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
    event.preventDefault();
    move(event.key === 'ArrowDown' ? 1 : -1);
    return;
  }

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
      if (event.shiftKey) void reject();
      else void approve(event.ctrlKey || event.metaKey || drafts.value.has(current.value?.id ?? -1));
      break;
    case 'e':
      event.preventDefault();
      void startEdit();
      break;
    case 'x':
      event.preventDefault();
      togglePick();
      break;
    default:
      if (/^[1-9]$/.test(event.key)) {
        event.preventDefault();
        chooseCandidate(Number(event.key) - 1);
      }
  }
}

onMounted(() => window.addEventListener('keydown', onKey));
onUnmounted(() => window.removeEventListener('keydown', onKey));

watch(
  () => props.units,
  () => {
    cursor.value = 0;
  },
);
</script>

<template>
  <div class="review">
    <!-- A table, because this is tabular. It was a list of absolutely
         positioned divs at a fixed height, which is what virtualisation needed
         while the screen loaded a whole catalogue at once. Paging removed that
         reason and left only its costs: a long string overlapped the row under
         it, and the height lived in two files that could disagree. -->
    <div class="queue">
      <table class="grid">
        <thead>
          <tr>
            <th></th>
            <th title="Durum">·</th>
            <th>Kaynak</th>
            <th>Çeviri</th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="(unit, index) in units"
            :key="unit.id"
            :ref="(el) => { if (el) rowEls[index] = el as HTMLElement }"
            :class="{
              on: index === cursor,
              blocked: unit.failures.length > 0,
              settled: unit.state === 'ok',
              picked: pickedSet.has(unit.id),
            }"
            @click="cursor = index"
          >
            <td>
              <input
                class="pick"
                type="checkbox"
                :checked="pickedSet.has(unit.id)"
                :aria-label="`Seç: ${unit.msgid.slice(0, 40)}`"
                @click.stop
                @change="setPicked(unit.id, ($event.target as HTMLInputElement).checked)"
              />
            </td>
            <td class="state">
              {{ unit.state === 'ok' ? '✓' : unit.failures.length ? '!' : '·' }}
            </td>
            <td>
              <div class="clamp"><Reveal :value="unit.msgid" /></div>
            </td>
            <td>
              <div v-if="unit.candidates.length" class="clamp candidates">
                <span v-for="(candidate, i) in unit.candidates" :key="candidate.tag">
                  <kbd>{{ i + 1 }}</kbd> {{ candidate.translation }}
                  <em>{{ candidate.tag }}</em>
                </span>
              </div>
              <div v-else class="clamp"><Reveal :value="draftOf(unit)" /></div>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <aside v-if="current" class="detail">
      <h4>Kaynak</h4>
      <p class="stored"><Reveal :value="current.msgid" /></p>
      <p v-if="current.msgidPlural" class="stored">
        çoğul: <Reveal :value="current.msgidPlural" />
      </p>

      <label>
        Çeviri
        <!-- The one place a translation is edited. It used to be a single-line
             box inside a 40px row, which could not show what it held. -->
        <textarea
          ref="editor"
          class="target-editor"
          :value="draftOf(current)"
          rows="3"
          @focus="editing = true"
          @blur="editing = false"
          @input="setDraft(current!, ($event.target as HTMLTextAreaElement).value)"
        />
      </label>
      <div class="editor-actions">
        <button class="primary" :disabled="current.failures.length > 0" @click="approve(true)">
          Kaydet ve onayla
        </button>
        <button @click="saveOnly">Kaydet</button>
        <button @click="reject">Reddet</button>
        <span class="muted"><kbd>Ctrl</kbd>+<kbd>Enter</kbd></span>
      </div>

      <div v-for="failure in current.failures" :key="failure.rule" class="failure">
        <p>{{ failure.message }}</p>
        <button @click="skipCheck(current!, failure.rule)">Bu kuralı bu dizgede atla</button>
      </div>
      <!-- Always, for the row under the cursor: where the string lives in the
           source tree is the context a reviewer reads it in, and it has no
           column of its own. -->
      <UnitDetailPanel :unit-id="current.id" />
    </aside>
  </div>
</template>
