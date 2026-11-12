<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import {
  createTag,
  deleteTag,
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
import { notify } from './notify.ts';

const tags = ref<Tag[]>([]);
const rules = ref<StyleRule[]>([]);
const loading = ref(false);
const saving = ref(false);

// Active Selected Rule (null = General / Global, number = tagId)
const editingRule = ref<number | null>(null);
const ruleBody = ref('');
const initialBody = ref('');

// Modals
const showAddModal = ref(false);
const newTagName = ref('');
const addingTag = ref(false);

const showRenameModal = ref(false);
const renamingTag = ref<Tag | null>(null);
const renameNewName = ref('');
const renaming = ref(false);

const showDeleteModal = ref(false);
const deletingTag = ref<Tag | null>(null);
const deleting = ref(false);

const showMergeModal = ref(false);
const mergeFrom = ref('');
const mergeTo = ref('');
const preview = ref<MergePreview | null>(null);
const policy = ref<'keep-target' | 'take-source'>('keep-target');
const merging = ref(false);

const generalRule = computed(() => rules.value.find((rule) => rule.tagId === null));
const activeTag = computed(() =>
  editingRule.value === null ? null : tags.value.find((t) => t.id === editingRule.value),
);
const isDirty = computed(() => ruleBody.value !== initialBody.value);

async function load(): Promise<void> {
  loading.value = true;
  try {
    const [tagList, ruleList] = await Promise.all([listTags(), listStyleRules()]);
    tags.value = tagList;
    rules.value = ruleList;

    // Load current rule body
    const current = ruleList.find((r) => r.tagId === editingRule.value);
    ruleBody.value = current?.body ?? '';
    initialBody.value = ruleBody.value;
  } catch (err) {
    notify('error', 'Veriler yüklenemedi: ' + String(err));
  } finally {
    loading.value = false;
  }
}

function selectRule(tagId: number | null): void {
  if (isDirty.value && !confirm('Kaydedilmemiş değişiklikleriniz var. Başka bir kılavuza geçmek istiyor musunuz?')) {
    return;
  }
  editingRule.value = tagId;
  const current = rules.value.find((r) => r.tagId === tagId);
  ruleBody.value = current?.body ?? '';
  initialBody.value = ruleBody.value;
}

async function saveRule(): Promise<void> {
  saving.value = true;
  try {
    await saveStyleRule(editingRule.value, ruleBody.value);
    initialBody.value = ruleBody.value;
    // Update local state
    const existing = rules.value.find((r) => r.tagId === editingRule.value);
    if (existing) {
      existing.body = ruleBody.value;
      existing.updatedAt = new Date().toISOString();
    } else {
      rules.value.push({
        tagId: editingRule.value,
        tagName: activeTag.value?.name ?? null,
        body: ruleBody.value,
        updatedAt: new Date().toISOString(),
      });
    }
    notify('ok', 'Üslup kılavuzu başarıyla kaydedildi.');
  } catch (err) {
    notify('error', 'Kılavuz kaydedilemedi: ' + String(err));
  } finally {
    saving.value = false;
  }
}

// Add Tag
function openAddModal(): void {
  newTagName.value = '';
  showAddModal.value = true;
}

async function handleAddTag(): Promise<void> {
  if (!newTagName.value.trim()) return;
  addingTag.value = true;
  try {
    await createTag(newTagName.value.trim());
    notify('ok', `"${newTagName.value.trim()}" etiketi oluşturuldu.`);
    showAddModal.value = false;
    newTagName.value = '';
    await load();
  } catch (err) {
    notify('error', 'Etiket oluşturulamadı: ' + String(err));
  } finally {
    addingTag.value = false;
  }
}

// Rename Tag
function openRenameModal(tag: Tag): void {
  renamingTag.value = tag;
  renameNewName.value = tag.name;
  showRenameModal.value = true;
}

async function handleRenameTag(): Promise<void> {
  if (!renamingTag.value || !renameNewName.value.trim()) return;
  renaming.value = true;
  try {
    await renameTag(renamingTag.value.id, renameNewName.value.trim());
    notify('ok', `Etiket "${renameNewName.value.trim()}" olarak güncellendi.`);
    showRenameModal.value = false;
    renamingTag.value = null;
    await load();
  } catch (err) {
    notify('error', 'Yeniden adlandırılamadı: ' + String(err));
  } finally {
    renaming.value = false;
  }
}

// Delete Tag
function openDeleteModal(tag: Tag): void {
  deletingTag.value = tag;
  showDeleteModal.value = true;
}

async function handleDeleteTag(): Promise<void> {
  if (!deletingTag.value) return;
  deleting.value = true;
  try {
    await deleteTag(deletingTag.value.id, false);
    notify('ok', `"${deletingTag.value.name}" etiketi silindi.`);
    if (editingRule.value === deletingTag.value.id) {
      editingRule.value = null;
    }
    showDeleteModal.value = false;
    deletingTag.value = null;
    await load();
  } catch (err) {
    notify('error', 'Etiket silinemedi: ' + String(err));
  } finally {
    deleting.value = false;
  }
}

// Merge Tags
function openMergeModal(): void {
  mergeFrom.value = '';
  mergeTo.value = '';
  preview.value = null;
  policy.value = 'keep-target';
  showMergeModal.value = true;
}

async function checkMerge(): Promise<void> {
  preview.value = null;
  if (!mergeFrom.value || !mergeTo.value || mergeFrom.value === mergeTo.value) return;
  try {
    preview.value = await previewMerge(Number(mergeFrom.value), Number(mergeTo.value));
  } catch (err) {
    notify('error', 'Önizleme alınamadı: ' + String(err));
  }
}

async function handleMerge(): Promise<void> {
  if (!mergeFrom.value || !mergeTo.value) return;
  merging.value = true;
  try {
    const result = await mergeTags(Number(mergeFrom.value), Number(mergeTo.value), policy.value);
    notify(
      'ok',
      `${result.moving} girdi taşındı, ${result.colliding} çakışma ${
        policy.value === 'keep-target' ? 'hedefteki korunarak' : 'kaynaktaki alınarak'
      } birleştirildi.`,
    );
    showMergeModal.value = false;
    await load();
    if (editingRule.value === Number(mergeFrom.value)) {
      editingRule.value = Number(mergeTo.value);
    }
  } catch (err) {
    notify('error', 'Birleştirme başarısız: ' + String(err));
  } finally {
    merging.value = false;
  }
}

onMounted(load);
</script>

<template>
  <div class="page-layout">
    <div class="page-header">
      <div>
        <h1 class="page-title">Etiketler & Özel AI Üslup Rehberleri</h1>
        <p class="page-desc">
          Projeleri ve sözlük terimlerini alanlara göre ayırın. Her etiket için modele verilecek özel prompt kuralları tanımlayabilir, etiketleri birleştirebilirsiniz.
        </p>
      </div>
      <div style="display: flex; gap: 10px;">
        <button class="btn" @click="openMergeModal">
          🔄 Etiketleri Birleştir (Merge)
        </button>
        <button class="btn primary" @click="openAddModal">
          + Yeni Etiket Ekle
        </button>
      </div>
    </div>

    <!-- Two-Column Deck: Tags Sidebar + Style Editor -->
    <div class="tags-layout">
      <!-- Left Column: Tags List -->
      <aside class="tags-sidebar-card">
        <div class="sidebar-card-header">
          <span style="font-size: 11px; font-weight: 700; text-transform: uppercase; color: var(--text-subtle); letter-spacing: 0.05em;">
            Etiketler & Rehberler ({{ tags.length }})
          </span>
        </div>

        <div class="tags-nav-list">
          <!-- General Guide Item -->
          <div
            class="tag-nav-item"
            :class="{ active: editingRule === null }"
            @click="selectRule(null)"
          >
            <div class="tag-nav-info">
              <span class="tag-nav-name">🌐 Genel Kılavuz (Global)</span>
              <span class="tag-nav-desc">Tüm projeler için zorunlu</span>
            </div>
            <span v-if="generalRule?.body?.trim()" class="status-indicator-dot ok" title="Kılavuz tanımlı" />
          </div>

          <!-- Per-Tag Items -->
          <div
            v-for="tag in tags"
            :key="tag.id"
            class="tag-nav-item"
            :class="{ active: editingRule === tag.id }"
            @click="selectRule(tag.id)"
          >
            <div class="tag-nav-info">
              <span class="tag-nav-name">{{ tag.name }}</span>
              <span class="tag-nav-badge">{{ tag.entries.toLocaleString('tr') }} girdi</span>
            </div>
            <div class="tag-item-actions" @click.stop>
              <button
                class="tag-rename-btn"
                title="Etiketi yeniden adlandır"
                @click="openRenameModal(tag)"
              >
                ✏️
              </button>
              <button
                class="tag-delete-btn"
                :title="tag.entries === 0 ? 'Boş etiketi sil' : 'Etiketi sil'"
                @click="openDeleteModal(tag)"
              >
                🗑️
              </button>
            </div>
          </div>
        </div>

        <div class="sidebar-card-footer">
          <button class="btn" style="width: 100%; justify-content: center; font-size: 12px;" @click="openAddModal">
            + Yeni Etiket Ekle
          </button>
        </div>
      </aside>

      <!-- Right Column: Style Guide Editor -->
      <main class="style-editor-card">
        <div class="editor-header">
          <div>
            <div style="display: flex; align-items: center; gap: 8px;">
              <h2 class="editor-title">
                {{ editingRule === null ? 'Genel Üslup Rehberi (Global Style Guide)' : `"${activeTag?.name}" Etiketi Özel Üslup Rehberi` }}
              </h2>
              <span v-if="isDirty" class="status-pill waiting" style="font-size: 10px;">
                Kaydedilmedi
              </span>
            </div>
            <p class="editor-desc">
              {{
                editingRule === null
                  ? 'Tüm AI çevirilerine ve kalite denetimlerine ana kılavuz olarak zorunlu iletilir.'
                  : `Yalnızca "${activeTag?.name}" etiketine sahip projelerin AI çevirilerine ek kural olarak iletilir.`
              }}
            </p>
          </div>
          <button
            class="btn primary"
            :disabled="saving"
            title="Ctrl + Enter ile de kaydedebilirsiniz"
            @click="saveRule"
          >
            {{ saving ? 'Kaydediliyor…' : 'Rehberi Kaydet (Ctrl+Enter)' }}
          </button>
        </div>

        <!-- Markdown / Rules Textarea -->
        <textarea
          v-model="ruleBody"
          class="rule-textarea"
          spellcheck="false"
          placeholder="# Türkçe çeviri kuralları...
1. Tümce Düzeni: WordPress arayüz metinleri Başlık Düzeni değil, tümce düzeniyle yazılır.
2. Yer Tutucular: %s ifadelerine ek getirilmez.
3. Sıralama: %1$s in %2$s yapısı Türkçe sözdizimine göre %2$s içinde %1$s olarak çevrilir."
          @keydown.ctrl.enter.prevent="saveRule"
        />

        <!-- Best Practices Reference Card -->
        <div class="rule-tips-box">
          <div style="font-size: 11px; font-weight: 700; text-transform: uppercase; color: var(--accent-mint); margin-bottom: 6px;">
            💡 Üslup Kılavuzu İpuçları & Önerilen Format
          </div>
          <ul style="margin: 0; padding-left: 18px; font-size: 12px; color: var(--text-muted); line-height: 1.6;">
            <li><b>Tümce Düzeni (Sentence Case):</b> WordPress arayüz metinleri İngilizce Title Case olsa dahi Türkçede sadece ilk harf büyük yazılır (<i>Save Changes → Değişiklikleri kaydet</i>).</li>
            <li><b>Yer Tutucular (%s, %d):</b> Yer tutuculara kesme işaretiyle ek takmayın (<i>%s'yi sil → HATALI</i>; <i>"%s" silinsin mi? → DOĞRU</i>).</li>
            <li><b>Öğe Sıralaması:</b> Yer tutucuların sırası Türkçe kurallarına göre serbestçe değiştirilebilir (<i>%1$s by %2$s → %2$s tarafından %1$s</i>).</li>
            <li><b>Etiket Özelleştirmeleri:</b> E-ticaret (WooCommerce) veya form eklentilerine özel terim tercihlerini o etiketin rehberine yazabilirsiniz.</li>
          </ul>
        </div>
      </main>
    </div>

    <!-- Modal: Yeni Etiket Ekle -->
    <div v-if="showAddModal" class="backdrop" @click.self="showAddModal = false">
      <div class="modal" style="max-width: 440px;">
        <div style="display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid var(--border-default); padding-bottom: 10px;">
          <h3 style="margin: 0; color: #fff; font-size: 16px;">Yeni Etiket Ekle</h3>
          <button class="btn" style="padding: 2px 8px;" @click="showAddModal = false">✕</button>
        </div>

        <div style="margin: 14px 0;">
          <label style="font-size: 11px; font-weight: 700; color: var(--text-subtle); text-transform: uppercase; display: block; margin-bottom: 6px;">
            Etiket Adı:
          </label>
          <input
            v-model="newTagName"
            class="search-input"
            placeholder="Örn: forms, analytics, seo..."
            @keyup.enter="handleAddTag"
          />
          <p style="font-size: 11px; color: var(--text-subtle); margin: 6px 0 0; line-height: 1.4;">
            Etiket adları Türkçe kurallarına göre küçültülür (<code>İÇERİK</code> ile <code>içerik</code> aynı kabul edilir).
          </p>
        </div>

        <div style="display: flex; justify-content: flex-end; gap: 8px; border-top: 1px solid var(--border-default); padding-top: 12px;">
          <button class="btn" @click="showAddModal = false">İptal</button>
          <button class="btn primary" :disabled="!newTagName.trim() || addingTag" @click="handleAddTag">
            {{ addingTag ? 'Ekleniyor…' : 'Etiketi Ekle' }}
          </button>
        </div>
      </div>
    </div>

    <!-- Modal: Etiketi Yeniden Adlandır -->
    <div v-if="showRenameModal" class="backdrop" @click.self="showRenameModal = false">
      <div class="modal" style="max-width: 440px;">
        <div style="display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid var(--border-default); padding-bottom: 10px;">
          <h3 style="margin: 0; color: #fff; font-size: 16px;">Etiketi Yeniden Adlandır</h3>
          <button class="btn" style="padding: 2px 8px;" @click="showRenameModal = false">✕</button>
        </div>

        <div style="margin: 14px 0;">
          <label style="font-size: 11px; font-weight: 700; color: var(--text-subtle); text-transform: uppercase; display: block; margin-bottom: 6px;">
            Yeni Ad:
          </label>
          <input
            v-model="renameNewName"
            class="search-input"
            @keyup.enter="handleRenameTag"
          />
        </div>

        <div style="display: flex; justify-content: flex-end; gap: 8px; border-top: 1px solid var(--border-default); padding-top: 12px;">
          <button class="btn" @click="showRenameModal = false">İptal</button>
          <button class="btn primary" :disabled="!renameNewName.trim() || renaming" @click="handleRenameTag">
            {{ renaming ? 'Kaydediliyor…' : 'Kaydet' }}
          </button>
        </div>
      </div>
    </div>

    <!-- Modal: Etiketleri Birleştir (Merge) -->
    <div v-if="showMergeModal" class="backdrop" @click.self="showMergeModal = false">
      <div class="modal" style="max-width: 520px;">
        <div style="display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid var(--border-default); padding-bottom: 10px;">
          <h3 style="margin: 0; color: #fff; font-size: 16px;">Etiketleri Birleştir (Tag Merge)</h3>
          <button class="btn" style="padding: 2px 8px;" @click="showMergeModal = false">✕</button>
        </div>

        <p style="font-size: 12px; color: var(--text-muted); margin: 10px 0 14px;">
          Kaynak etiketteki tüm sözlük girdileri, projeler ve güvenilir kaynaklar hedef etikete aktarılır; ardından kaynak etiket silinir.
        </p>

        <div style="display: grid; grid-template-columns: 1fr auto 1fr; gap: 10px; align-items: center; margin-bottom: 14px;">
          <div>
            <label style="font-size: 11px; font-weight: 700; color: var(--text-subtle); text-transform: uppercase; display: block; margin-bottom: 4px;">
              Kaynak Etiket (Silinecek):
            </label>
            <select v-model="mergeFrom" class="search-input" style="padding: 6px 10px;" @change="checkMerge">
              <option value="">Seçin…</option>
              <option v-for="tag in tags" :key="tag.id" :value="String(tag.id)">
                {{ tag.name }} ({{ tag.entries.toLocaleString('tr') }})
              </option>
            </select>
          </div>

          <div style="font-size: 18px; color: var(--text-subtle); padding-top: 18px;">
            ➔
          </div>

          <div>
            <label style="font-size: 11px; font-weight: 700; color: var(--text-subtle); text-transform: uppercase; display: block; margin-bottom: 4px;">
              Hedef Etiket (Birleşilecek):
            </label>
            <select v-model="mergeTo" class="search-input" style="padding: 6px 10px;" @change="checkMerge">
              <option value="">Seçin…</option>
              <option v-for="tag in tags" :key="tag.id" :value="String(tag.id)">
                {{ tag.name }} ({{ tag.entries.toLocaleString('tr') }})
              </option>
            </select>
          </div>
        </div>

        <!-- Preview Results -->
        <div v-if="preview" style="background: var(--bg-surface-elevated, #1b2624); border: 1px solid var(--border-default); border-radius: 6px; padding: 12px; margin-bottom: 14px;">
          <div style="font-size: 13px; font-weight: 600; color: #fff; margin-bottom: 6px;">
            Önizleme Özeti:
          </div>
          <div style="font-size: 12px; color: var(--text-muted); display: flex; flex-direction: column; gap: 4px;">
            <div>• <b>{{ preview.moving.toLocaleString('tr') }}</b> sözlük girdisi doğrudan taşınacak.</div>
            <div>• <b>{{ preview.projects }}</b> proje ve <b>{{ preview.sources }}</b> güvenilir kaynak hedef etikete aktarılacak.</div>
            <div v-if="preview.colliding > 0" style="color: #fbbf24; font-weight: 600; margin-top: 4px;">
              ⚠️ <b>{{ preview.colliding.toLocaleString('tr') }}</b> girdide çakışma tespit edildi (iki etikette aynı İngilizce kelime farklı Türkçeye sahip).
            </div>
            <div v-else style="color: #34d399; font-weight: 600;">
              ✓ Hiçbir çakışma yok.
            </div>
          </div>

          <!-- Collision policy choice if collisions exist -->
          <div v-if="preview.colliding > 0" style="margin-top: 12px; border-top: 1px solid var(--border-default); padding-top: 10px;">
            <div style="font-size: 11px; font-weight: 700; text-transform: uppercase; color: var(--text-subtle); margin-bottom: 6px;">
              Çakışma Politikası:
            </div>
            <div style="display: flex; flex-direction: column; gap: 6px;">
              <label style="display: flex; align-items: center; gap: 8px; font-size: 12px; color: #fff; cursor: pointer;">
                <input v-model="policy" type="radio" value="keep-target" />
                Hedef etiketteki mevcut çeviri korunsun (Önerilen)
              </label>
              <label style="display: flex; align-items: center; gap: 8px; font-size: 12px; color: #fff; cursor: pointer;">
                <input v-model="policy" type="radio" value="take-source" />
                Kaynak etiketteki çeviri hedefinkinin üzerine yazılsın
              </label>
            </div>
          </div>
        </div>

        <div style="display: flex; justify-content: flex-end; gap: 8px; border-top: 1px solid var(--border-default); padding-top: 12px;">
          <button class="btn" @click="showMergeModal = false">İptal</button>
          <button
            class="btn primary"
            :disabled="!preview || merging || mergeFrom === mergeTo"
            @click="handleMerge"
          >
            {{ merging ? 'Birleştiriliyor…' : 'Birleştirmeyi Onayla & Uygula' }}
          </button>
        </div>
      </div>
    </div>

    <!-- Modal: Etiketi Sil -->
    <div v-if="showDeleteModal && deletingTag" class="backdrop" @click.self="showDeleteModal = false">
      <div class="modal" style="max-width: 440px;">
        <div style="display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid var(--border-default); padding-bottom: 10px;">
          <h3 style="margin: 0; color: #fff; font-size: 16px;">Etiketi Sil</h3>
          <button class="btn" style="padding: 2px 8px;" @click="showDeleteModal = false">✕</button>
        </div>

        <div style="margin: 14px 0;">
          <p style="font-size: 13px; color: var(--text-default); line-height: 1.5; margin: 0 0 12px;">
            <b style="color: #fff;">"{{ deletingTag.name }}"</b> etiketini silmek istediğinize emin misiniz?
          </p>

          <div
            v-if="deletingTag.entries > 0"
            style="background: rgba(239, 68, 68, 0.1); border: 1px solid rgba(239, 68, 68, 0.3); border-radius: 6px; padding: 10px; font-size: 12px; color: #fca5a5; line-height: 1.4;"
          >
            ⚠️ Bu etikete bağlı <b>{{ deletingTag.entries.toLocaleString('tr') }}</b> sözlük girdisi bulunmaktadır.
            Girdileri kaybetmemek için etiketi silmek yerine <b>"Etiketleri Birleştir"</b> özelliğini kullanmanız önerilir.
          </div>
          <div
            v-else
            style="background: rgba(52, 211, 153, 0.1); border: 1px solid rgba(52, 211, 153, 0.3); border-radius: 6px; padding: 10px; font-size: 12px; color: #6ee7b7;"
          >
            ✓ Bu etiket boştur (0 girdi). Güvenle silebilirsiniz.
          </div>
        </div>

        <div style="display: flex; justify-content: flex-end; gap: 8px; border-top: 1px solid var(--border-default); padding-top: 12px;">
          <button class="btn" :disabled="deleting" @click="showDeleteModal = false">
            İptal
          </button>
          <button
            class="btn"
            style="background: #dc2626; color: #fff; border: 1px solid #b91c1c;"
            :disabled="deleting"
            @click="handleDeleteTag"
          >
            {{ deleting ? 'Siliniyor…' : 'Etiketi Sil' }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.tags-layout {
  display: grid;
  grid-template-columns: 300px 1fr;
  gap: 20px;
  align-items: flex-start;
  margin-top: 10px;
}

/* Left Sidebar Card */
.tags-sidebar-card {
  background: var(--bg-surface, #141f1d);
  border: 1px solid var(--border-default, #2a3a37);
  border-radius: var(--radius-md, 8px);
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.sidebar-card-header {
  padding: 14px 16px;
  border-bottom: 1px solid var(--border-default);
}

.tags-nav-list {
  display: flex;
  flex-direction: column;
  padding: 8px;
  gap: 3px;
  max-height: calc(100vh - 240px);
  overflow-y: auto;
}

.tag-nav-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 12px;
  border-radius: 6px;
  cursor: pointer;
  transition: background-color 0.15s, border-color 0.15s;
  border: 1px solid transparent;
}

.tag-nav-item:hover {
  background: var(--bg-hover, #1d2d2a);
}

.tag-nav-item.active {
  background: var(--bg-hover, #1d2d2a);
  border-color: var(--accent-mint, #5eead4);
}

.tag-nav-info {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.tag-nav-name {
  font-size: 13px;
  font-weight: 600;
  color: #fff;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.tag-nav-desc {
  font-size: 11px;
  color: var(--text-subtle, #627b75);
}

.tag-nav-badge {
  font-size: 11px;
  color: var(--text-muted, #93a9a4);
}

.tag-item-actions {
  display: flex;
  align-items: center;
  gap: 4px;
}

.tag-rename-btn {
  background: transparent;
  border: none;
  cursor: pointer;
  padding: 2px 4px;
  font-size: 11px;
  opacity: 0.6;
  border-radius: 3px;
  transition: opacity 0.15s;
}

.tag-rename-btn:hover {
  opacity: 1;
  background: rgba(0, 0, 0, 0.2);
}

.tag-delete-btn {
  background: transparent;
  border: none;
  cursor: pointer;
  padding: 2px 4px;
  font-size: 11px;
  opacity: 0.6;
  border-radius: 3px;
  transition: opacity 0.15s, background 0.15s, color 0.15s;
}

.tag-delete-btn:hover {
  opacity: 1;
  background: rgba(220, 38, 38, 0.2);
}

.status-indicator-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  flex-shrink: 0;
}

.status-indicator-dot.ok {
  background: #34d399;
  box-shadow: 0 0 6px rgba(52, 211, 153, 0.5);
}

.sidebar-card-footer {
  padding: 12px 14px;
  border-top: 1px solid var(--border-default);
}

/* Right Editor Card */
.style-editor-card {
  background: var(--bg-surface, #141f1d);
  border: 1px solid var(--border-default, #2a3a37);
  border-radius: var(--radius-md, 8px);
  padding: 20px;
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.editor-header {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 16px;
  border-bottom: 1px solid var(--border-default);
  padding-bottom: 14px;
}

.editor-title {
  margin: 0;
  font-size: 16px;
  font-weight: 700;
  color: #fff;
}

.editor-desc {
  margin: 4px 0 0;
  font-size: 12px;
  color: var(--text-muted, #93a9a4);
}

.rule-textarea {
  width: 100%;
  min-height: 440px;
  background: var(--bg-surface-elevated, #1b2624);
  border: 1px solid var(--border-default, #2a3a37);
  border-radius: 6px;
  color: #e2e8f0;
  font-family: var(--font-mono, monospace);
  font-size: 13px;
  padding: 16px;
  line-height: 1.65;
  resize: vertical;
  outline: none;
  transition: border-color 0.15s;
}

.rule-textarea:focus {
  border-color: var(--accent-mint, #5eead4);
}

.rule-tips-box {
  background: rgba(94, 234, 212, 0.05);
  border: 1px solid rgba(94, 234, 212, 0.2);
  border-radius: 6px;
  padding: 14px 16px;
}
</style>
