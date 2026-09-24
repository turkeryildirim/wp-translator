<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import {
  createTag,
  listStyleRules,
  listTags,
  mergeTags,
  previewMerge,
  renameTag,
  saveStyleRule,
  type MergePreview,
  type StyleRule,
  type Tag,
} from './api.ts';

const tags = ref<Tag[]>([]);
const rules = ref<StyleRule[]>([]);
const newTag = ref('');

const mergeFrom = ref('');
const mergeTo = ref('');
const preview = ref<MergePreview | null>(null);
const policy = ref<'keep-target' | 'take-source'>('keep-target');
const mergeNotice = ref('');

const editingRule = ref<number | null | undefined>(undefined);
const ruleBody = ref('');
const ruleNotice = ref('');

const generalRule = computed(() => rules.value.find((rule) => rule.tagId === null));

async function load(): Promise<void> {
  [tags.value, rules.value] = await Promise.all([listTags(), listStyleRules()]);
}

async function add(): Promise<void> {
  if (!newTag.value.trim()) return;
  await createTag(newTag.value);
  newTag.value = '';
  await load();
}

async function rename(tag: Tag): Promise<void> {
  const name = prompt('Yeni ad', tag.name);
  if (name && name !== tag.name) {
    await renameTag(tag.id, name);
    await load();
  }
}

async function check(): Promise<void> {
  mergeNotice.value = '';
  preview.value = null;
  if (!mergeFrom.value || !mergeTo.value || mergeFrom.value === mergeTo.value) return;
  preview.value = await previewMerge(Number(mergeFrom.value), Number(mergeTo.value));
}

async function merge(): Promise<void> {
  const result = await mergeTags(Number(mergeFrom.value), Number(mergeTo.value), policy.value);
  mergeNotice.value = `${result.moving} girdi taşındı, ${result.colliding} çakışma ${
    policy.value === 'keep-target' ? 'hedefteki korunarak' : 'kaynaktaki alınarak'
  } çözüldü.`;
  preview.value = null;
  mergeFrom.value = '';
  mergeTo.value = '';
  await load();
}

function editRule(tagId: number | null): void {
  editingRule.value = tagId;
  ruleBody.value = rules.value.find((rule) => rule.tagId === tagId)?.body ?? '';
  ruleNotice.value = '';
}

async function saveRule(): Promise<void> {
  if (editingRule.value === undefined) return;
  await saveStyleRule(editingRule.value, ruleBody.value);
  ruleNotice.value = 'Kaydedildi.';
  await load();
}

onMounted(load);
</script>

<template>
  <section class="screen">
    <h3>Etiketler</h3>
    <div class="toolbar">
      <input v-model="newTag" placeholder="Yeni etiket adı" @keyup.enter="add" />
      <button @click="add">Ekle</button>
    </div>
    <p class="hint">
      Adlar Türkçe kurallarına göre küçültülüp saklanır: SQLite'ın kendi karşılaştırması yalnızca
      ASCII katlar, <code>içerik</code> ile <code>İÇERİK</code> ona göre farklı sözcüklerdir.
    </p>

    <table class="grid narrow">
      <thead>
        <tr><th>Etiket</th><th class="num">Sözlük girdisi</th><th /></tr>
      </thead>
      <tbody>
        <tr v-for="tag in tags" :key="tag.id">
          <td>{{ tag.name }}</td>
          <td class="num">{{ tag.entries.toLocaleString('tr') }}</td>
          <td><button @click="rename(tag)">Yeniden adlandır</button></td>
        </tr>
      </tbody>
    </table>

    <h3>Etiket birleştir</h3>
    <div class="toolbar">
      <select v-model="mergeFrom" @change="check">
        <option value="">Kaynak etiket</option>
        <option v-for="tag in tags" :key="tag.id" :value="String(tag.id)">{{ tag.name }}</option>
      </select>
      <span>→</span>
      <select v-model="mergeTo" @change="check">
        <option value="">Hedef etiket</option>
        <option v-for="tag in tags" :key="tag.id" :value="String(tag.id)">{{ tag.name }}</option>
      </select>
    </div>

    <template v-if="preview">
      <p class="status">
        {{ preview.moving.toLocaleString('tr') }} girdi sorunsuz taşınır.
        <b v-if="preview.colliding">{{ preview.colliding.toLocaleString('tr') }} girdi çakışıyor</b>
        <span v-else>Çakışma yok.</span>
        {{ preview.projects }} proje, {{ preview.sources }} kaynak bu etiketi kullanıyor.
      </p>
      <div v-if="preview.colliding" class="toolbar">
        <label class="check">
          <input v-model="policy" type="radio" value="keep-target" /> Hedefteki çeviri kalsın
        </label>
        <label class="check">
          <input v-model="policy" type="radio" value="take-source" /> Kaynaktaki çeviri geçsin
        </label>
      </div>
      <p v-if="preview.colliding" class="hint">
        Çakışma, iki etiketin aynı metni farklı çevirmesi demek. Yüzlerce
        çakışmada tek tek sormak bitirilebilir bir iş olmadığı için karar birleştirmenin tamamına
        uygulanır.
      </p>
      <button class="primary" @click="merge">Birleştir</button>
    </template>
    <p v-if="mergeNotice" class="notice">{{ mergeNotice }}</p>

    <h3>Üslup rehberi</h3>
    <p class="hint">
      Genel rehber her çeviri isteğine gider; etiket rehberleri yalnızca o etiketi taşıyan
      projelere eklenir.
    </p>
    <div class="toolbar">
      <button :class="{ primary: editingRule === null }" @click="editRule(null)">
        Genel{{ generalRule ? '' : ' (boş)' }}
      </button>
      <button
        v-for="tag in tags"
        :key="tag.id"
        :class="{ primary: editingRule === tag.id }"
        @click="editRule(tag.id)"
      >
        {{ tag.name }}{{ rules.some((r) => r.tagId === tag.id) ? '' : ' (boş)' }}
      </button>
    </div>

    <template v-if="editingRule !== undefined">
      <textarea v-model="ruleBody" class="rule-editor" rows="18" spellcheck="false" />
      <div class="toolbar">
        <button class="primary" @click="saveRule">Kaydet</button>
        <span v-if="ruleNotice" class="notice">{{ ruleNotice }}</span>
      </div>
    </template>
  </section>
</template>
