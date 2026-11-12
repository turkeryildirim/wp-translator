<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import {
  addUnitsToGlossary,
  overrideCheck,
  requestSingleProposal,
  saveUnit,
  unitDetail,
  type GlossarySuggestion,
  type SingleProposal,
  type TmSuggestion,
  type Unit,
  type UnitDetail,
} from './api.ts';
import Reveal from './Reveal.vue';
import { notify } from './notify.ts';

/**
 * Selection lives on the screen above, with the actions that consume it.
 */
const props = defineProps<{
  units: Unit[];
  picked: number[];
  projectId?: number;
  projectPath?: string;
  activeEngine?: string;
}>();
const emit = defineEmits<{ changed: [Unit]; bulk: []; 'update:picked': [number[]]; page: [] }>();

const pickedSet = computed(() => new Set(props.picked));

function setPicked(id: number, on: boolean): void {
  const next = new Set(props.picked);
  if (on) next.add(id);
  else next.delete(id);
  emit('update:picked', [...next]);
}

const allPickedOnPage = computed(
  () => props.units.length > 0 && props.units.every((u) => pickedSet.value.has(u.id)),
);

const somePickedOnPage = computed(
  () => !allPickedOnPage.value && props.units.some((u) => pickedSet.value.has(u.id)),
);

const selectAllCheckbox = ref<HTMLInputElement | null>(null);

watch(
  [somePickedOnPage, selectAllCheckbox],
  () => {
    if (selectAllCheckbox.value) {
      selectAllCheckbox.value.indeterminate = somePickedOnPage.value;
    }
  },
  { flush: 'post' },
);

function toggleSelectAll(checked: boolean): void {
  const ids = props.units.map((u) => u.id);
  const next = new Set(props.picked);
  if (checked) {
    for (const id of ids) next.add(id);
  } else {
    for (const id of ids) next.delete(id);
  }
  emit('update:picked', [...next]);
}

const cursor = ref(0);
const editing = ref(false);
/** Both halves of a translation; `many` is unused unless the source has a plural. */
interface Draft {
  one: string;
  many: string;
}

// Keyed by unit id rather than by row index, so a draft survives the list being
// reloaded under it.
const drafts = ref(new Map<number, Draft>());
const editor = ref<HTMLTextAreaElement | null>(null);
const rowEls = ref<HTMLElement[]>([]);

const current = computed(() => props.units[cursor.value]);

const detail = ref<UnitDetail | null>(null);
const loadingDetail = ref(false);

watch(
  () => current.value?.id,
  async (id) => {
    if (!id) {
      detail.value = null;
      return;
    }
    loadingDetail.value = true;
    try {
      detail.value = await unitDetail(id);
    } catch {
      detail.value = null;
    } finally {
      loadingDetail.value = false;
    }
  },
  { immediate: true },
);

const singlePos = ref('auto');
const addingToGlossary = ref(false);

function formatPos(pos: string): string {
  const map: Record<string, string> = {
    auto: 'Otomatik',
    noun: 'İsim (noun)',
    verb: 'Fiil (verb)',
    adjective: 'Sıfat (adj)',
    adverb: 'Zarf (adv)',
    expression: 'Deyim (expr)',
    abbreviation: 'Kısaltma (abbr)',
    pronoun: 'Zamir (pron)',
    preposition: 'Edat (prep)',
  };
  return map[pos] ?? pos;
}

const hasGlossaryItems = computed(() => {
  const termCount = detail.value?.glossaryTerms?.length ?? 0;
  const candCount = current.value?.candidates?.length ?? 0;
  return termCount > 0 || candCount > 0;
});

async function addCurrentToGlossary(): Promise<void> {
  const unit = current.value;
  if (!unit || !props.projectId) return;
  const draft = draftOf(unit);
  const translation = draft.one.trim();
  if (!translation) {
    notify('error', 'Sözlüğe eklemek için önce bir Türkçe çeviri giriniz.');
    return;
  }

  addingToGlossary.value = true;
  try {
    const res = await addUnitsToGlossary(
      props.projectId,
      { ids: [unit.id] },
      singlePos.value,
      { translation, translationPlural: draft.many.trim() || undefined },
    );
    if (res.added > 0) {
      const assigned = res.entries[0]?.pos ?? 'noun';
      notify('ok', `"${unit.msgid}" (${formatPos(assigned)}) olarak sözlüğe eklendi.`);
      detail.value = await unitDetail(unit.id);
    } else if (res.skipped > 0) {
      notify('ok', `"${unit.msgid}" sözlükte zaten mevcut olduğu için korunarak atlandı.`);
    } else {
      notify('error', 'Sözlüğe eklenemedi.');
    }
  } catch (err) {
    notify('error', 'Sözlüğe ekleme başarısız: ' + String(err));
  } finally {
    addingToGlossary.value = false;
  }
}

async function addRowToGlossary(unit: Unit): Promise<void> {
  if (!props.projectId) return;
  const draft = draftOf(unit);
  const translation = (draft.one || unit.msgstr || '').trim();
  if (!translation) {
    notify('error', 'Sözlüğe eklemek için önce bir Türkçe çeviri giriniz.');
    return;
  }

  try {
    const res = await addUnitsToGlossary(
      props.projectId,
      { ids: [unit.id] },
      'auto',
      { translation, translationPlural: (draft.many || unit.msgstrPlural || '').trim() || undefined },
    );
    if (res.added > 0) {
      const assigned = res.entries[0]?.pos ?? 'noun';
      notify('ok', `"${unit.msgid}" (${formatPos(assigned)}) olarak sözlüğe eklendi.`);
      if (current.value?.id === unit.id) {
        detail.value = await unitDetail(unit.id);
      }
    } else if (res.skipped > 0) {
      notify('ok', `"${unit.msgid}" sözlükte zaten mevcut olduğu için korunarak atlandı.`);
    }
  } catch (err) {
    notify('error', 'Sözlüğe ekleme başarısız: ' + String(err));
  }
}

function applyGlossaryTerm(term: GlossarySuggestion): void {
  const unit = current.value;
  if (!unit) return;
  setDraft(unit, 'one', term.translation);
  if (term.translationPlural && unit.msgidPlural) {
    setDraft(unit, 'many', term.translationPlural);
  }
  notify('ok', `"${term.translation}" çeviri kutusuna aktarıldı.`);
}

const proposingAi = ref(false);
const singleAiProposal = ref<SingleProposal | null>(null);

watch(cursor, () => {
  singleAiProposal.value = null;
});

async function requestSingleAi(): Promise<void> {
  const unit = current.value;
  if (!unit) return;
  proposingAi.value = true;
  singleAiProposal.value = null;
  try {
    const proposal = await requestSingleProposal(props.projectPath, unit, props.activeEngine);
    singleAiProposal.value = proposal;
    notify('ok', 'AI çeviri önerisi alındı.');
  } catch (err) {
    notify('error', 'AI önerisi alınamadı: ' + String(err));
  } finally {
    proposingAi.value = false;
  }
}

function applyAiSuggestion(andApprove = false): void {
  const unit = current.value;
  const proposal = singleAiProposal.value;
  if (!unit || !proposal?.translation) return;

  setDraft(unit, 'one', proposal.translation);
  if (proposal.translationPlural && unit.msgidPlural) {
    setDraft(unit, 'many', proposal.translationPlural);
  }

  if (andApprove) {
    void approve(true);
  } else {
    notify('ok', 'Öneri çeviri kutusuna aktarıldı.');
  }
}

function applyTmSuggestion(sug: TmSuggestion): void {
  const unit = current.value;
  if (!unit) return;
  setDraft(unit, 'one', sug.translation);
  if (sug.translationPlural && unit.msgidPlural) {
    setDraft(unit, 'many', sug.translationPlural);
  }
  notify('ok', `Öneri aktarıldı (${sug.similarity === 100 ? '%100 Eşleşme' : `%${sug.similarity} Benzer`}).`);
}

const draftOf = (unit: Unit): Draft =>
  drafts.value.get(unit.id) ?? { one: unit.msgstr ?? '', many: unit.msgstrPlural ?? '' };

function setDraft(unit: Unit, part: keyof Draft, value: string): void {
  drafts.value = new Map(drafts.value).set(unit.id, { ...draftOf(unit), [part]: value });
}

/** What a save sends: the plural half only where the source has one. */
function editOf(unit: Unit): { msgstr: string; msgstrPlural?: string } {
  const draft = draftOf(unit);
  return unit.msgidPlural === null
    ? { msgstr: draft.one }
    : { msgstr: draft.one, msgstrPlural: draft.many };
}

function clearDraft(unit: Unit): void {
  const next = new Map(drafts.value);
  next.delete(unit.id);
  drafts.value = next;
}

function move(delta: number): void {
  const next = cursor.value + delta;
  // Past the end of a page, ask for the next one.
  if (next >= props.units.length) {
    emit('page');
    return;
  }
  cursor.value = Math.max(next, 0);
  scrollIntoView(cursor.value);
}

// Land on the next row still needing attention, not on whatever slid into this
// index; otherwise holding Enter approves the wrong strings.
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
 * Empty a unit and move on. Rejecting is not a state: the unit returns to
 * untranslated and the next AI run picks it up.
 */
async function reject(): Promise<void> {
  const unit = current.value;
  if (!unit) return;

  const { unit: saved } = await saveUnit(unit.id, { msgstr: '', msgstrPlural: '' });
  notify('ok', 'Reddedildi');
  clearDraft(unit);
  editing.value = false;
  emit('changed', saved);
  advance();
}

/**
 * Save what is in the box and settle the row.
 *
 * The checks run on the server against what is actually saved, never against
 * `unit.failures` — that describes the stored translation, so an edit that
 * fixes a blocked string would be refused on the strength of the string it
 * replaced. A refused save answers 200 with the failures, so the outcome is in
 * the body, and the cursor stays put for the owner to try again.
 */
async function approve(withEdit: boolean): Promise<void> {
  const unit = current.value;
  if (!unit) return;

  const { unit: saved, blocked } = await saveUnit(unit.id, withEdit ? editOf(unit) : {}, true);
  emit('changed', saved);

  if (blocked?.length) {
    notify('error', `Onaylanmadı: ${blocked[0]!.message}`);
    return;
  }

  notify('ok', 'Onaylandı');
  clearDraft(unit);
  editing.value = false;
  advance();
}

function chooseCandidate(position: number): void {
  const unit = current.value;
  const candidate = unit?.candidates[position];
  if (unit && candidate) setDraft(unit, 'one', candidate.translation);
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

/** Put the source into the translation boxes, invisible characters and all. */
function copySource(): void {
  const unit = current.value;
  if (!unit) return;
  setDraft(unit, 'one', unit.msgid);
  if (unit.msgidPlural !== null) setDraft(unit, 'many', unit.msgidPlural);
}

/** Keep the edit without settling the row — the string stays where it is. */
async function saveOnly(): Promise<void> {
  const unit = current.value;
  if (!unit) return;

  const { unit: saved, blocked } = await saveUnit(unit.id, editOf(unit));
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
    <!-- A table, because this is tabular. Positioned boxes at a fixed height
         overlap as soon as a string runs past one line. -->
    <div class="queue review-table-area">
      <table class="grid">
        <thead>
          <tr>
            <th style="width: 36px; text-align: center;">
              <input
                ref="selectAllCheckbox"
                class="pick"
                type="checkbox"
                :checked="allPickedOnPage"
                :indeterminate.prop="somePickedOnPage"
                title="Sayfadaki tüm satırları seç / seçimi kaldır"
                aria-label="Sayfadaki tümünü seç"
                @change="toggleSelectAll(($event.target as HTMLInputElement).checked)"
              />
            </th>
            <th style="width: 100px;">Durum</th>
            <th style="width: 44%;">Kaynak</th>
            <th>Çeviri</th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="(unit, index) in units"
            :key="unit.id"
            :ref="(el) => { if (el) rowEls[index] = el as HTMLElement }"
            :class="{
              active: index === cursor,
              on: index === cursor,
              blocked: unit.failures.length > 0,
              settled: unit.state === 'ok',
              picked: pickedSet.has(unit.id),
            }"
            @click="cursor = index"
          >
            <td style="text-align: center;">
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
              <span v-if="unit.state === 'ok'" class="status-pill ok">Onaylı</span>
              <span v-else-if="unit.failures.length > 0" class="status-pill blocked">Bloklandı</span>
              <span v-else-if="unit.state === 'review'" class="status-pill waiting">Bekliyor</span>
              <span v-else class="status-pill untranslated">Boş</span>
            </td>
            <td>
              <div class="clamp"><Reveal :value="unit.msgid" /></div>
            </td>
            <td>
              <div style="display: flex; justify-content: space-between; align-items: flex-start; gap: 6px;">
                <div style="flex: 1; min-width: 0;">
                  <div v-if="unit.candidates.length" class="clamp candidates">
                    <span
                      v-for="(candidate, i) in unit.candidates"
                      :key="candidate.tag"
                      class="chip-btn"
                      style="margin-right: 6px;"
                      @click.stop="chooseCandidate(i)"
                    >
                      <kbd>{{ i + 1 }}</kbd> {{ candidate.translation }}
                      <em>{{ candidate.tag }}</em>
                    </span>
                  </div>
                  <div v-else class="clamp"><Reveal :value="draftOf(unit).one" /></div>
                  <div v-if="unit.failures.length > 0" style="font-size: 11px; color: #f87171; margin-top: 3px;">
                    ⚠️ {{ unit.failures[0]?.message }}
                  </div>
                </div>
                <button
                  class="btn"
                  style="padding: 1px 7px; font-size: 10px; white-space: nowrap; opacity: 0.85;"
                  title="Bu çeviriyi sözlüğe ekle (eskileri ezmez)"
                  @click.stop="addRowToGlossary(unit)"
                >
                  + Sözlük
                </button>
              </div>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <!-- Right Inspector Panel -->
    <aside v-if="current" class="detail inspector-panel">
      <div class="inspector-header">
        <div style="display: flex; align-items: center; gap: 8px;">
          <span style="font-size: 13px; font-weight: 700; color: #fff;">
            Dizge Detayı #{{ current.id }}
          </span>
          <span v-if="current.state === 'ok'" class="status-pill ok" style="font-size: 10px;">Onaylı</span>
          <span v-else-if="current.failures.length > 0" class="status-pill blocked" style="font-size: 10px;">Bloklandı</span>
          <span v-else-if="current.state === 'review'" class="status-pill waiting" style="font-size: 10px;">Bekliyor</span>
          <span v-else class="status-pill untranslated" style="font-size: 10px;">Boş</span>
        </div>
        <div style="display: flex; gap: 6px;">
          <button class="btn" style="padding: 2px 8px; font-size: 11px;" title="Önceki satır (Ctrl+↑ veya K)" @click="move(-1)">↑</button>
          <button class="btn" style="padding: 2px 8px; font-size: 11px;" title="Sonraki satır (Ctrl+↓ veya J)" @click="move(1)">↓</button>
        </div>
      </div>

      <div class="inspector-content">
        <!-- Quality check failures / Blocked alerts -->
        <div v-if="current.failures.length > 0" class="alert-danger-box">
          <div v-for="failure in current.failures" :key="failure.rule" style="display: flex; flex-direction: column; gap: 6px;">
            <div style="font-size: 12px; font-weight: 700; color: #f87171; display: flex; justify-content: space-between; align-items: center;">
              <span>⛔ Kalite Kontrolü: {{ failure.rule }}</span>
              <span class="status-pill blocked">Bloklandı</span>
            </div>
            <div style="font-size: 12px; color: #cbd5e1; line-height: 1.4;">
              {{ failure.message }}
            </div>
            <button
              class="btn"
              style="align-self: flex-start; margin-top: 4px; font-size: 11px; padding: 3px 8px; border-color: rgba(239, 68, 68, 0.4); color: #fca5a5;"
              @click="skipCheck(current!, failure.rule)"
            >
              Bu kuralı bu dizgede atla (İstisna ekle)...
            </button>
          </div>
        </div>

        <!-- English Source Box -->
        <div>
          <div style="font-size: 11px; font-weight: 700; text-transform: uppercase; color: var(--text-subtle); margin-bottom: 6px; display: flex; justify-content: space-between; align-items: center;">
            <span>İngilizce Kaynak</span>
            <button class="btn" style="padding: 2px 7px; font-size: 10px;" title="Kaynağı çeviri alanına kopyala" @click="copySource">
              Kopyala
            </button>
          </div>
          <div class="box-block">
            <Reveal :value="current.msgid" />
          </div>
        </div>

        <!-- Plural Source Box if applicable -->
        <div v-if="current.msgidPlural">
          <div style="font-size: 11px; font-weight: 700; text-transform: uppercase; color: var(--text-subtle); margin-bottom: 6px;">
            <span>İngilizce Kaynak (Çoğul)</span>
          </div>
          <div class="box-block">
            <Reveal :value="current.msgidPlural" />
          </div>
        </div>

        <!-- Source Context & Metadata -->
        <div v-if="detail && (detail.usageSurface || detail.extractedComments || detail.refs)" class="box-block" style="font-size: 12px;">
          <dl style="margin: 0; display: flex; flex-direction: column; gap: 6px;">
            <div v-if="detail.usageSurface" style="display: flex; align-items: center; gap: 6px;">
              <dt style="font-weight: 700; color: var(--text-subtle); margin: 0;">Kullanım Yeri:</dt>
              <dd style="margin: 0;"><span class="status-pill source" style="font-size: 10px;">{{ detail.usageSurface }}</span></dd>
            </div>
            <div v-if="detail.extractedComments">
              <dt style="font-weight: 700; color: var(--text-subtle); margin: 0;">Geliştirici Notu:</dt>
              <dd style="margin: 2px 0 0; color: var(--text-main); font-weight: 500;">{{ detail.extractedComments }}</dd>
            </div>
            <div v-if="detail.refs">
              <dt style="font-weight: 700; color: var(--text-subtle); margin: 0;">Dosya Konumu:</dt>
              <dd style="margin: 2px 0 0; color: var(--text-muted); font-family: monospace; font-size: 11px; word-break: break-all;">{{ detail.refs }}</dd>
            </div>
          </dl>
        </div>

        <!-- Single-entry On-Demand AI Suggestion -->
        <div style="background: rgba(230, 126, 34, 0.08); border: 1px solid rgba(230, 126, 34, 0.3); border-radius: 6px; padding: 10px 12px; display: flex; flex-direction: column; gap: 8px;">
          <div style="display: flex; justify-content: space-between; align-items: center;">
            <span style="font-size: 12px; font-weight: 700; color: #f39c12; display: flex; align-items: center; gap: 5px;">
              ✨ Tekil AI Çeviri Önerisi
            </span>
            <button
              class="btn primary"
              style="padding: 4px 10px; font-size: 11px;"
              :disabled="proposingAi"
              @click="requestSingleAi"
            >
              {{ proposingAi ? 'Öneri İsteniyor…' : 'AI Önerisi İste' }}
            </button>
          </div>

          <div
            v-if="singleAiProposal"
            style="display: flex; flex-direction: column; gap: 6px; background: var(--bg-base); padding: 10px 12px; border-radius: 4px; border: 1px solid var(--border-default);"
          >
            <div style="font-size: 11px; color: var(--text-subtle); display: flex; justify-content: space-between;">
              <span>Kaynak: <b style="color: #fff;">{{ singleAiProposal.from === 'glossary' ? 'Sözlük' : singleAiProposal.from === 'memory' ? 'AI Belleği' : 'Model' }}</b></span>
              <span v-if="singleAiProposal.translation" style="color: #34d399; font-weight: 600;">✓ Kalite Kontrolü Geçti</span>
              <span v-else style="color: #f87171; font-weight: 600;">{{ singleAiProposal.reason ?? 'Öneri yok' }}</span>
            </div>

            <div v-if="singleAiProposal.translation" style="font-size: 13px; font-weight: 600; color: #fff;">
              {{ singleAiProposal.translation }}
            </div>

            <div v-if="singleAiProposal.translationPlural" style="font-size: 12px; color: var(--text-muted);">
              Çoğul: {{ singleAiProposal.translationPlural }}
            </div>

            <div v-if="singleAiProposal.translation" style="display: flex; gap: 6px; margin-top: 6px;">
              <button
                class="btn"
                style="flex: 1; padding: 5px 10px; font-size: 11px; justify-content: center; background: rgba(39, 174, 96, 0.2); border-color: rgba(39, 174, 96, 0.4); color: #34d399;"
                @click="applyAiSuggestion(true)"
              >
                ⚡ Doğrudan Kaydet & Onayla
              </button>
              <button
                class="btn"
                style="padding: 5px 10px; font-size: 11px;"
                @click="applyAiSuggestion(false)"
              >
                Kutuya Aktar
              </button>
            </div>
          </div>
        </div>

        <!-- Turkish Translation Textarea(s) -->
        <div>
          <div style="font-size: 11px; font-weight: 700; text-transform: uppercase; color: var(--text-subtle); margin-bottom: 6px; display: flex; justify-content: space-between; align-items: center;">
            <span>{{ current.msgidPlural ? 'Türkçe Çeviri (Tekil)' : 'Türkçe Çeviri' }}</span>
          </div>
          <textarea
            ref="editor"
            class="edit-area"
            :value="draftOf(current).one"
            rows="3"
            placeholder="Türkçe karşılığını yazın..."
            @focus="editing = true"
            @blur="editing = false"
            @input="setDraft(current!, 'one', ($event.target as HTMLTextAreaElement).value)"
          />
        </div>

        <div v-if="current.msgidPlural">
          <div style="font-size: 11px; font-weight: 700; text-transform: uppercase; color: var(--text-subtle); margin-bottom: 6px;">
            <span>Türkçe Çeviri (Çoğul)</span>
          </div>
          <textarea
            class="edit-area"
            :value="draftOf(current).many"
            rows="3"
            placeholder="Çoğul karşılığını yazın..."
            @focus="editing = true"
            @blur="editing = false"
            @input="setDraft(current!, 'many', ($event.target as HTMLTextAreaElement).value)"
          />
        </div>

        <!-- 3'LÜ BUTON BLOĞU (Hemen Çeviri Girilen Text Alanının Altında!) -->
        <div style="display: flex; gap: 8px; border-top: 1px solid var(--border-default); padding-top: 10px; margin-top: 2px;">
          <button
            class="btn"
            style="color: #f87171; border-color: rgba(239, 68, 68, 0.4);"
            title="Çeviriyi sil ve boşalt (Shift+Enter veya R)"
            @click="reject"
          >
            Reddet (R)
          </button>
          <button
            class="btn"
            title="Dizgeyi onaylamadan yalnızca kaydet"
            @click="saveOnly"
          >
            Kaydet
          </button>
          <button
            class="btn primary"
            style="flex: 1; justify-content: center;"
            title="Kaydet ve onayla (Enter veya Ctrl+Enter)"
            @click="approve(true)"
          >
            Kaydet & Onayla (Enter)
          </button>
        </div>

        <!-- Tekil Sözlüğe Ekleme Satırı (Terim bankası gibi) -->
        <div style="display: flex; gap: 6px; align-items: center; background: rgba(255,255,255,0.03); padding: 7px 10px; border-radius: 6px; border: 1px solid var(--border-default);">
          <span style="font-size: 11px; font-weight: 700; color: var(--text-muted); text-transform: uppercase;">Sözlüğe Ekle:</span>
          <select v-model="singlePos" class="btn" style="padding: 4px 6px; font-size: 11px;">
            <option value="auto">✨ Otomatik Tür</option>
            <option value="noun">İsim (Noun)</option>
            <option value="verb">Fiil (Verb)</option>
            <option value="adjective">Sıfat (Adj)</option>
            <option value="adverb">Zarf (Adv)</option>
            <option value="expression">Deyim (Expr)</option>
            <option value="abbreviation">Kısaltma (Abbr)</option>
          </select>
          <button
            class="btn"
            style="flex: 1; font-size: 11px; padding: 4px 10px; justify-content: center;"
            :disabled="addingToGlossary"
            title="Bu dizgeyi ve çeviriyi sözlüğe ekler (eskileri ezmez)"
            @click="addCurrentToGlossary"
          >
            📖 Bu Çeviriyi Sözlüğe Ekle
          </button>
        </div>

        <!-- SÖZLÜK ÖNERİLERİ / ALTERNATİFLERİ (Hemen Butonların Altında!) -->
        <div class="box-block" style="display: flex; flex-direction: column; gap: 8px;">
          <div style="font-size: 11px; font-weight: 700; text-transform: uppercase; color: var(--text-subtle); display: flex; justify-content: space-between; align-items: center;">
            <span>📖 Sözlük Önerileri / Alternatifleri</span>
            <span v-if="hasGlossaryItems" class="status-pill ok" style="font-size: 10px; padding: 1px 6px;">
              {{ (detail?.glossaryTerms?.length ?? 0) + (current.candidates.length) }} kayıt
            </span>
          </div>

          <!-- Sözlük terimleri (pos IS NOT NULL) -->
          <div v-if="detail?.glossaryTerms && detail.glossaryTerms.length > 0" style="display: flex; flex-direction: column; gap: 6px;">
            <div
              v-for="gt in detail.glossaryTerms"
              :key="gt.id"
              class="suggestion-card"
              title="Tıklayarak çeviri kutusuna aktarın"
              @click="applyGlossaryTerm(gt)"
            >
              <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 3px;">
                <span class="status-pill ok" style="font-size: 10px; padding: 1px 7px; font-weight: 700;">
                  {{ formatPos(gt.pos ?? 'noun') }}
                </span>
                <span v-if="gt.tag" class="muted" style="font-size: 11px;">
                  {{ gt.tag }}
                </span>
              </div>
              <div style="font-size: 13px; font-weight: 600; color: #fff;">
                {{ gt.translation }}
              </div>
              <div v-if="gt.translationPlural" style="font-size: 12px; color: var(--text-muted); margin-top: 2px;">
                Çoğul: {{ gt.translationPlural }}
              </div>
              <div v-if="gt.note" style="font-size: 11px; color: var(--text-subtle); margin-top: 3px; font-style: italic;">
                💬 {{ gt.note }}
              </div>
            </div>
          </div>

          <!-- Adaylar (candidates - rakam kısayolu ile) -->
          <div v-if="current.candidates.length" style="display: flex; flex-wrap: wrap; gap: 6px; margin-top: 4px;">
            <span
              v-for="(candidate, i) in current.candidates"
              :key="candidate.tag + candidate.translation"
              class="chip-btn"
              title="Tıkla ve çeviri kutusuna aktar"
              @click="chooseCandidate(i)"
            >
              <kbd style="background: rgba(0,0,0,0.3); padding: 1px 4px; border-radius: 3px;">{{ i + 1 }}</kbd>
              <b>{{ candidate.translation }}</b>
              <em style="color: var(--text-subtle); font-style: normal;">({{ candidate.tag }})</em>
            </span>
          </div>

          <div v-if="!hasGlossaryItems" style="font-size: 12px; color: var(--text-subtle); padding: 4px 0;">
            Eşleşen sözlük terimi bulunamadı.
          </div>
        </div>

        <!-- BELLEK ÖNERİLERİ (Hemen Sözlük Önerisinin Altında!) -->
        <div class="box-block" style="display: flex; flex-direction: column; gap: 8px;">
          <div style="font-size: 11px; font-weight: 700; text-transform: uppercase; color: var(--text-subtle); display: flex; justify-content: space-between; align-items: center;">
            <span>💾 Bellek Önerileri (Güvenilir Kaynaklar)</span>
            <span v-if="detail?.suggestions && detail.suggestions.length" class="status-pill ok" style="font-size: 10px; padding: 1px 6px;">
              {{ detail.suggestions.length }} eşleşme
            </span>
          </div>

          <div v-if="detail?.suggestions && detail.suggestions.length" style="display: flex; flex-direction: column; gap: 8px;">
            <div
              v-for="(sug, i) in detail.suggestions"
              :key="i"
              class="suggestion-card"
              title="Tıklayarak çeviri kutusuna aktarın"
              @click="applyTmSuggestion(sug)"
            >
              <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 4px;">
                <span
                  class="status-pill"
                  :class="sug.similarity === 100 ? 'ok' : 'waiting'"
                  style="font-size: 10px; padding: 1px 7px; font-weight: 700;"
                >
                  {{ sug.similarity === 100 ? '✓ %100 Eşleşme' : `~ %${sug.similarity} Benzer` }}
                </span>
                <span v-if="sug.tag" class="muted" style="font-size: 11px;">
                  {{ sug.tag }}
                </span>
              </div>
              <div
                v-if="sug.source !== current.msgid"
                class="muted"
                style="font-size: 11px; margin-bottom: 3px; font-style: italic; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;"
                :title="sug.source"
              >
                "{{ sug.source }}"
              </div>
              <div style="font-size: 13px; font-weight: 600; color: #fff;">
                {{ sug.translation }}
              </div>
              <div v-if="sug.translationPlural" style="font-size: 12px; color: var(--text-muted); margin-top: 3px;">
                Çoğul: {{ sug.translationPlural }}
              </div>
            </div>
          </div>

          <div v-else style="font-size: 12px; color: var(--text-subtle); padding: 4px 0;">
            Eşleşen çeviri belleği kaydı bulunamadı.
          </div>
        </div>
      </div>
    </aside>
  </div>
</template>
