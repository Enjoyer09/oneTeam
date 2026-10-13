import React, { useState, useRef } from 'react';
import { ModalPortal } from './ui/ModalPortal';
import { StatusBadge } from './ui/StatusBadge';
import {
  PlusCircle,
  Calendar,
  CheckSquare,
  Square,
  X,
  Store as StoreIcon,
  Send,
  Filter,
  Layers,
  Sparkles,
  Camera,
  Upload,
  Pencil,
  Trash2,
  AlertTriangle,
  Loader2,
} from 'lucide-react';
import { Task, Store, TaskPriority, ChecklistItem } from '../types';
import { useModalA11y } from '../lib/useModalA11y';

/**
 * What the edit form sends.
 *
 * `deadline` is a `datetime-local` string, so it carries a time. The create
 * forms are still date-only; upgrading them is a separate, smaller change.
 */
/**
 * How the bot renders the answer UI for a checklist question.
 *
 * `boolean` → ✅ Bəli / ❌ Xeyr buttons; `single_choice` → one button per option;
 * `number` → typed number; `text` → free text. This is the field the bot's
 * `answerMode()` switches on, so a question authored here without a type would
 * fall back to free text and show no preset buttons — which is exactly the gap
 * this selector closes. New questions default to `boolean` (Hə/Yox).
 */
export interface TaskEditValues {
  title: string;
  description: string;
  priority: TaskPriority;
  deadline: string;
  requires_before_after_photo: boolean;
  checklist_schema: ChecklistItem[];
}

const CHECKLIST_TYPES: ReadonlyArray<{ value: ChecklistItem['type']; label: string }> = [
  { value: 'boolean', label: 'Hə/Yox' },
  { value: 'single_choice', label: 'Seçim' },
  { value: 'number', label: 'Rəqəm' },
  { value: 'text', label: 'Mətn' },
];

const isChecklistType = (v: unknown): v is ChecklistItem['type'] =>
  v === 'boolean' || v === 'single_choice' || v === 'number' || v === 'text';

/**
 * Normalize a stored checklist row into the editor's shape.
 *
 * A row saved before this editor had a type selector has no `type`, so it
 * defaults to `boolean` — re-saving such a task is what turns its plain
 * questions into Hə/Yox presets. A row seeded with a real type keeps it.
 */
function normalizeChecklistItem(item: unknown, index: number): ChecklistItem {
  const raw = (item ?? {}) as Record<string, unknown>;
  const type = isChecklistType(raw.type) ? raw.type : 'boolean';
  const options = Array.isArray(raw.options) ? raw.options.map((o) => String(o)) : undefined;
  return {
    id: String(raw.id ?? `q${index + 1}`),
    label: String(raw.label ?? raw.text ?? ''),
    type,
    ...(type === 'single_choice' ? { options: options ?? [] } : {}),
  };
}

/**
 * An ISO timestamp as the value a `datetime-local` input expects.
 *
 * The input reads and writes local wall-clock time and has no timezone field,
 * so slicing the ISO string would show UTC — two hours behind Baku — and the
 * supervisor would "fix" a deadline that was already correct.
 */
function toLocalInput(iso: string | undefined): string {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}`
  );
}

interface TaskManagerProps {
  tasks: Task[];
  stores: Store[];
  isCreateModalOpen: boolean;
  setIsCreateModalOpen: (open: boolean) => void;
  /**
   * Hər ikisi `Promise<boolean>` qaytarır: `true` = tapşırıq həqiqətən yaradıldı
   * yaxud göndərildi. Komponent bu bayraq olmadan formanı sıfırlamır və modalı
   * bağlamır, çünki `App`-dəki `runAction` xətanı udub normal qayıdır — əgər
   * burada nəticə soruşulmasaydı, uğursuz göndərmə "uğur" kimi görünərdi.
   */
  onCreateTask: (taskData: {
    title: string;
    description: string;
    reference_image_url: string;
    priority: TaskPriority;
    deadline: string;
    assigned_stores: string[];
    requires_before_after_photo?: boolean;
    checklist_schema?: ChecklistItem[];
  }) => Promise<boolean>;
  onBulkDispatch?: (data: {
    title: string;
    description: string;
    reference_image_url: string;
    priority: TaskPriority;
    deadline: string;
    chainName: string;
    storeFormat: string;
    regionId: string;
    requires_before_after_photo?: boolean;
    checklist_schema?: ChecklistItem[];
  }) => Promise<boolean>;
  /**
   * Resolves with how many store tasks the content change reached.
   *
   * Title, description, priority and the checklist live on the template, so
   * editing them from one row changes every row dispatched from the same
   * briefing. The API counts them and this is what lets the panel say so
   * instead of letting a supervisor believe they renamed one card.
   */
  onUpdateTask?: (id: string, changes: TaskEditValues) => Promise<number>;
  onDeleteTask?: (id: string) => Promise<void>;
  /** UI-only gate; the real one is `TASK_EDIT_FORBIDDEN` in the API. */
  canEdit?: boolean;
}

export const TaskManager: React.FC<TaskManagerProps> = ({
  tasks,
  stores,
  isCreateModalOpen,
  setIsCreateModalOpen,
  onCreateTask,
  onBulkDispatch,
  onUpdateTask,
  onDeleteTask,
  canEdit = false,
}) => {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [referenceImageUrl, setReferenceImageUrl] = useState('');
  const [priority, setPriority] = useState<TaskPriority>('medium');
  const [deadline, setDeadline] = useState(
    new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0],
  );
  const [selectedStores, setSelectedStores] = useState<string[]>([]);
  const [isSubmitting, setIsSubmitting] = useState(false);
  /* Yaratma formasının inline xətası — alert() əvəzinə, redaktə modalındakı
     `editError` ilə eyni pattern. */
  const [createError, setCreateError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  /* ------------------------------------------------------------------------ */
  /* Redaktə və silmə                                                         */
  /*                                                                          */
  /* Xətalar modalın İÇİNDƏ göstərilir, toast kimi yox: "bu tapşırığa 3 audit  */
  /* göndərişi var" kimi bir səbəb istifadəçinin baxdığı yerin yanında          */
  /* görünməlidir. `StoreDirectory`dəki eyni qayda.                            */
  /* ------------------------------------------------------------------------ */
  const [editingTask, setEditingTask] = useState<Task | null>(null);
  const [editValues, setEditValues] = useState<TaskEditValues | null>(null);
  const [editError, setEditError] = useState<string | null>(null);
  const [isSavingEdit, setIsSavingEdit] = useState(false);

  const [deletingTask, setDeletingTask] = useState<Task | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);

  const editModalRef = useModalA11y<HTMLDivElement>(editingTask !== null, () => closeEdit());
  const deleteModalRef = useModalA11y<HTMLDivElement>(deletingTask !== null, () => closeDelete());

  function closeEdit() {
    setEditingTask(null);
    setEditValues(null);
    setEditError(null);
  }

  function closeDelete() {
    setDeletingTask(null);
    setDeleteError(null);
  }

  const openEdit = (task: Task) => {
    setEditValues({
      title: task.title ?? '',
      description: task.description ?? '',
      priority: (task.priority ?? 'medium') as TaskPriority,
      deadline: toLocalInput(task.deadline),
      requires_before_after_photo: task.requires_before_after_photo ?? false,
      checklist_schema: (task.checklist_schema ?? []).map((item, index) =>
        normalizeChecklistItem(item, index),
      ),
    });
    setEditError(null);
    setEditingTask(task);
  };

  const submitEdit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingTask || !editValues || !onUpdateTask) return;

    if (!editValues.title.trim()) {
      setEditError('Tapşırıq başlığı tələb olunur');
      return;
    }
    if (!editValues.deadline) {
      setEditError('Son tarix tələb olunur');
      return;
    }
    // An item with no question would reach the field client as a checklist row
    // the merchandiser cannot answer, so it is refused here rather than stored.
    const blankItem = editValues.checklist_schema.findIndex((item) => !item.label.trim());
    if (blankItem !== -1) {
      setEditError(`Çeklistin ${blankItem + 1}-ci bəndində sual mətni boşdur`);
      return;
    }
    // A "Seçim" question with fewer than two real options gives the merchandiser
    // nothing to tap, so it is refused rather than shipped as a dead button row.
    const badChoice = editValues.checklist_schema.findIndex(
      (item) =>
        item.type === 'single_choice' && (item.options ?? []).filter((o) => o.trim()).length < 2,
    );
    if (badChoice !== -1) {
      setEditError(
        `Çeklistin ${badChoice + 1}-ci bəndi (Seçim) ən azı iki cavab variantı tələb edir`,
      );
      return;
    }

    setIsSavingEdit(true);
    setEditError(null);
    try {
      // Trim labels and drop empty options; only single_choice carries options,
      // so the other types are sent clean (no stray `options` the bot ignores).
      const checklist_schema = editValues.checklist_schema.map((item) => ({
        id: item.id,
        label: item.label.trim(),
        type: item.type,
        ...(item.type === 'single_choice'
          ? { options: (item.options ?? []).map((o) => o.trim()).filter(Boolean) }
          : {}),
      }));
      // Resolves with how many rows the content change reached; the caller
      // reports that, so it is not swallowed here.
      await onUpdateTask(editingTask.id, {
        ...editValues,
        title: editValues.title.trim(),
        checklist_schema,
      });
      closeEdit();
    } catch (error) {
      setEditError(error instanceof Error ? error.message : String(error));
    } finally {
      setIsSavingEdit(false);
    }
  };

  const submitDelete = async () => {
    if (!deletingTask || !onDeleteTask) return;
    setIsDeleting(true);
    setDeleteError(null);
    try {
      await onDeleteTask(deletingTask.id);
      closeDelete();
    } catch (error) {
      setDeleteError(error instanceof Error ? error.message : String(error));
    } finally {
      setIsDeleting(false);
    }
  };

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      if (file.size > 5 * 1024 * 1024) {
        setCreateError('Şəkil ölçüsü 5 MB-dan çox ola bilməz.');
        return;
      }
      setCreateError(null);
      const reader = new FileReader();
      reader.onloadend = () => {
        if (typeof reader.result === 'string') {
          setReferenceImageUrl(reader.result);
        }
      };
      reader.readAsDataURL(file);
    }
  };

  const [isBulkModalOpen, setIsBulkModalOpen] = useState(false);

  /* İki modal da eyni əlçatanlıq davranışını paylaşır */
  const bulkModalRef = useModalA11y<HTMLDivElement>(isBulkModalOpen, () =>
    setIsBulkModalOpen(false),
  );
  const createModalRef = useModalA11y<HTMLDivElement>(isCreateModalOpen, () =>
    setIsCreateModalOpen(false),
  );
  const [bulkChain, setBulkChain] = useState<string>('all');
  const [bulkFormat, setBulkFormat] = useState<string>('all');
  const [bulkRegion, setBulkRegion] = useState<string>('all');
  /* Kütləvi göndərmə məzmunu — əvvəllər hardcoded şablonlardan gəlirdi, indi
     supervayzer özü yazır (yaratma formasındakı kimi). */
  const [bulkTitle, setBulkTitle] = useState('');
  const [bulkDescription, setBulkDescription] = useState('');
  const [bulkRequiresBeforeAfter, setBulkRequiresBeforeAfter] = useState(false);
  const [bulkPriority, setBulkPriority] = useState<TaskPriority>('high');
  const [bulkDeadline, setBulkDeadline] = useState(
    new Date(Date.now() + 5 * 24 * 60 * 60 * 1000).toISOString().split('T')[0],
  );
  const [isBulkSubmitting, setIsBulkSubmitting] = useState(false);
  const [bulkError, setBulkError] = useState<string | null>(null);

  /* Filtr seçimləri həqiqi mağaza məlumatından qurulur — sabit kodlanmış
     şəbəkə/region siyahısı deyil. Mağazalarda olmayan bir dəyər seçilə bilməz. */
  const chainOptions = Array.from(
    new Set(stores.map((s) => s.chain_name).filter((v): v is string => !!v)),
  ).sort();
  const formatOptions = Array.from(
    new Set(stores.map((s) => s.store_format).filter((v): v is string => !!v)),
  ).sort();
  const regionOptions = Array.from(
    new Set(stores.map((s) => s.region_id).filter((v): v is string => !!v)),
  ).sort();

  // Compute matched stores in real time based on active filters
  const matchedStores = stores.filter((s) => {
    if (!s.is_active) return false;
    if (bulkChain !== 'all' && s.chain_name?.toLowerCase() !== bulkChain.toLowerCase()) {
      return false;
    }
    if (bulkFormat !== 'all' && s.store_format?.toLowerCase() !== bulkFormat.toLowerCase()) {
      return false;
    }
    if (bulkRegion !== 'all' && s.region_id !== bulkRegion) {
      return false;
    }
    return true;
  });

  /**
   * Modal YALNIZ uğurluqdan sonra bağlanır.
   *
   * Əvvəl `try { … setIsBulkModalOpen(false) } finally { … }` idi: xəta halında da
   * modal bağlanırdı, halbuki `App`-dəki `runAction` xətanı udub normal qayıdır.
   * Supervayzer "Əməliyyat alınmadı" toast-unu 3.5 saniyə görüb, filtrlərini və
   * seçimlərini itirmiş vəziyyətdə qalırdı. `false` gələndə `runAction` artıq
   * toast göstərib, ona görə burada yalnız "heç nə dəyişmə" deyirik.
   */
  const handleBulkSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (matchedStores.length === 0) {
      setBulkError('Seçilmiş filtrlərə uyğun aktiv mağaza yoxdur.');
      return;
    }
    if (!bulkTitle.trim() || !bulkDescription.trim()) {
      setBulkError('Zəhmət olmasa təlimat başlığını və məzmununu doldurun.');
      return;
    }
    setBulkError(null);

    setIsBulkSubmitting(true);
    try {
      const taskData = {
        title: bulkTitle.trim(),
        description: bulkDescription.trim(),
        reference_image_url: referenceImageUrl,
        priority: bulkPriority,
        deadline: new Date(bulkDeadline).toISOString(),
        chainName: bulkChain,
        storeFormat: bulkFormat,
        regionId: bulkRegion,
        requires_before_after_photo: bulkRequiresBeforeAfter,
        assigned_stores: matchedStores.map((s) => s.id),
      };

      const ok = onBulkDispatch ? await onBulkDispatch(taskData) : await onCreateTask(taskData);
      if (ok) setIsBulkModalOpen(false);
    } finally {
      setIsBulkSubmitting(false);
    }
  };

  const selectedStoreIds = stores
    .filter((store) => selectedStores.includes(store.id))
    .map((store) => store.id);
  const toggleStore = (storeId: string) => {
    if (storeId === 'all') {
      setSelectedStores(
        selectedStoreIds.length === stores.length ? [] : stores.map((store) => store.id),
      );
      return;
    }
    setSelectedStores((previous) =>
      previous.includes(storeId) ? previous.filter((id) => id !== storeId) : [...previous, storeId],
    );
  };

  /**
   * Forma yalnız uğurluqdan sonra sıfırlanır.
   *
   * Əvvəl uğursuzluqda da `setTitle('')`/`setDescription('')` çağırılırdı: server
   * 500 qaytardıqda supervayzer yazdığı bütün məzmunu itirmiş, modalı bağlanmış
   * və yalnız 3.5 saniyəlik "Əməliyyat alınmadı" zolağı qalırdı. Bir tapşırıq
   * təlimatının yazılması dəqiqələr çəkir — bu, bu panelin ən ağır itkisidir.
   */
  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim() || !description.trim()) {
      setCreateError('Zəhmət olmasa başlıq və təlimat mətnini doldurun.');
      return;
    }
    if (selectedStoreIds.length === 0) {
      setCreateError('Ən azı bir mağaza seçin.');
      return;
    }
    setCreateError(null);

    setIsSubmitting(true);
    try {
      const storeIds = selectedStoreIds;

      const ok = await onCreateTask({
        title: title.trim(),
        description: description.trim(),
        reference_image_url: referenceImageUrl,
        priority,
        deadline: new Date(deadline).toISOString(),
        assigned_stores: storeIds,
      });

      if (ok) {
        setTitle('');
        setDescription('');
        setSelectedStores([]);
        setIsCreateModalOpen(false);
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  const getPriorityBadge = (p: TaskPriority) => {
    switch (p) {
      case 'urgent':
        return (
          <span className="px-2.5 py-0.5 rounded-full text-xs font-bold bg-rose-100 text-rose-800">
            🔴 Təcili
          </span>
        );
      case 'high':
        return (
          <span className="px-2.5 py-0.5 rounded-full text-xs font-bold bg-orange-100 text-orange-800">
            🟠 Yüksək
          </span>
        );
      case 'medium':
        return (
          <span className="px-2.5 py-0.5 rounded-full text-xs font-bold bg-amber-100 text-amber-800">
            🟡 Orta
          </span>
        );
      case 'low':
        return (
          <span className="px-2.5 py-0.5 rounded-full text-xs font-bold bg-emerald-100 text-emerald-800">
            🟢 Aşağı
          </span>
        );
    }
  };

  return (
    <div className="space-y-6">
      {/* Top Bar */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 bg-[var(--g-card)] p-4 sm:p-5 rounded-xl border border-hair shadow-subtle">
        <div>
          <div className="flex items-center gap-2">
            <h3 className="font-bold text-sm sm:text-base text-ink">Mövcud tapşırıqlar</h3>
            <span className="px-2 py-0.5 rounded-md text-[10px] font-extrabold bg-red-100 text-coke-700 border border-red-200">
              Tapşırıq idarəetməsi
            </span>
          </div>
          <p className="text-xs text-muted mt-0.5">
            Supervayzerlər tərəfindən mağaza vitrinləri üçün tərtib edilmiş rəf qaydaları və kütləvi
            paylama
          </p>
        </div>
        <div className="flex items-center gap-2.5 w-full sm:w-auto">
          <button
            onClick={() => setIsBulkModalOpen(true)}
            className="flex-1 sm:flex-initial flex items-center justify-center space-x-1.5 btn-strong text-white px-3.5 py-2.5 rounded-xl text-xs font-extrabold shadow-sm transition-all cursor-pointer whitespace-nowrap"
          >
            <Send className="w-3.5 h-3.5 text-coke-400" />
            <span>Kütləvi Təlimat Göndər</span>
          </button>
          <button
            onClick={() => setIsCreateModalOpen(true)}
            className="flex-1 sm:flex-initial flex items-center justify-center space-x-1.5 btn-coke text-white px-3.5 py-2.5 rounded-xl text-xs font-extrabold shadow-sm shadow-coke-500/20 transition-all cursor-pointer whitespace-nowrap"
          >
            <PlusCircle className="w-3.5 h-3.5" />
            <span>Yeni Təlimat Yarat</span>
          </button>
        </div>
      </div>

      {/* Task Cards */}
      {tasks.length === 0 ? (
        <div className="glass-card rounded-card p-12 text-center">
          <p className="text-sm font-semibold text-ink-2">Hələ planogram tapşırığı yoxdur.</p>
          <p className="text-xs text-muted mt-1">
            "Yeni Təlimat Yarat" düyməsi ilə ilk təlimatı hazırlayın.
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">
          {tasks.map((task) => {
            const deadlineStr = new Date(task.deadline).toLocaleDateString('az-AZ', {
              timeZone: 'Asia/Baku',
              day: '2-digit',
              month: '2-digit',
              year: 'numeric',
            });

            return (
              <div
                key={task.id}
                className="glass-card rounded-card overflow-hidden flex flex-col justify-between hover:shadow-md transition-all"
              >
                <div>
                  {/* Planogram Image Preview */}
                  <div className="relative aspect-[16/9] bg-[var(--g-panel)] overflow-hidden border-b border-hair-2">
                    {task.reference_image_url ? (
                      <img
                        src={task.reference_image_url}
                        alt={`${task.title} üçün nümunə foto`}
                        className="w-full h-full object-contain"
                      />
                    ) : (
                      <div className="flex h-full items-center justify-center gap-2 text-sm text-muted">
                        <Camera className="h-5 w-5" aria-hidden="true" />
                        Nümunə foto əlavə edilməyib
                      </div>
                    )}
                    <div className="absolute top-2.5 right-2.5">
                      {getPriorityBadge(task.priority)}
                    </div>
                    <div className="absolute bottom-2.5 left-2.5 bg-slate-950/75 backdrop-blur-sm text-white px-2.5 py-1 rounded-md text-[10px] font-semibold flex items-center gap-1">
                      <Calendar className="w-3 h-3 text-muted" />
                      Son tarix: {deadlineStr}
                    </div>
                  </div>

                  <div className="p-4 space-y-2">
                    <div className="flex items-center gap-1.5 flex-wrap">
                      {/* The API derives `kind` from the fields below, so this
                        badge appears exactly when neither of the other two
                        does — a plain audit with no checklist and no
                        before/after pair. */}
                      {task.kind === 'AUDIT' && (
                        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-extrabold bg-slate-100 text-slate-700 border border-slate-200">
                          <Layers className="w-3 h-3 text-slate-500" />
                          Ümumi audit
                        </span>
                      )}
                      {task.requires_before_after_photo && (
                        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-extrabold bg-indigo-50 text-indigo-700 border border-indigo-200">
                          <Camera className="w-3 h-3 text-indigo-500" />
                          Before & After Tələbi
                        </span>
                      )}
                      {task.checklist_schema && task.checklist_schema.length > 0 && (
                        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-extrabold bg-blue-50 text-blue-700 border border-blue-200">
                          <CheckSquare className="w-3 h-3 text-blue-500" />
                          {task.checklist_schema.length} Çeklist Sualı
                        </span>
                      )}
                    </div>
                    <h4 className="font-bold text-xs sm:text-sm text-ink leading-snug">
                      {task.title}
                    </h4>
                    <p className="text-xs text-ink-2 line-clamp-3 leading-relaxed">
                      {task.description}
                    </p>
                  </div>
                </div>

                <div className="p-4 pt-0 border-t border-hair-2 mt-2 flex items-center justify-between gap-2 text-xs text-muted">
                  <span className="flex min-w-0 items-center gap-1 font-medium text-[11px]">
                    <StoreIcon className="w-3.5 h-3.5 flex-shrink-0 text-muted" />
                    <span className="truncate">
                      {task.assigned_stores?.length || 'Bütün'} Mağaza Təhkim edilib
                    </span>
                  </span>
                  <div className="flex flex-shrink-0 items-center gap-1.5">
                    <StatusBadge value={task.status ?? 'Bilinmir'} />
                    {canEdit && (
                      <>
                        <button
                          type="button"
                          onClick={() => openEdit(task)}
                          aria-label={`"${task.title}" tapşırığını redaktə et`}
                          title="Redaktə et"
                          className="rounded-lg p-1.5 text-muted transition-colors hover:bg-[var(--g-panel)] hover:text-ink cursor-pointer"
                        >
                          <Pencil className="w-3.5 h-3.5" />
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            setDeleteError(null);
                            setDeletingTask(task);
                          }}
                          aria-label={`"${task.title}" tapşırığını sil`}
                          title="Sil"
                          className="rounded-lg p-1.5 text-muted transition-colors hover:bg-[rgba(200,60,60,.08)] hover:text-[#b23b3b] cursor-pointer"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* ====================================================================== */}
      {/* BULK TASK DISPATCH MODAL (STORE SEGMENTATION ENGINE) */}
      {/* ====================================================================== */}
      {isBulkModalOpen && (
        <ModalPortal>
          <div className="fixed inset-0 z-50 modal-veil flex items-center justify-center p-4 sm:p-6 overflow-y-auto">
            <div
              ref={bulkModalRef}
              role="dialog"
              aria-modal="true"
              aria-label="Kütləvi planogram təlimatı göndər"
              className="glass-pop w-full max-w-2xl rounded-card overflow-hidden my-auto"
            >
              {/* Modal Header */}
              <div className="p-5 border-b border-hair flex items-center justify-between bg-[var(--g-panel)]">
                <div className="flex items-center space-x-3">
                  <div className="w-10 h-10 rounded-xl bg-coke-500 flex items-center justify-center text-white shadow-md shadow-[0_3px_10px_-3px_var(--coke-ring)]">
                    <Send className="w-5 h-5" />
                  </div>
                  <div>
                    <h3 className="font-extrabold text-sm sm:text-base text-ink flex items-center gap-2">
                      Tapşırığı bir neçə mağazaya göndər
                      <span className="text-[10px] px-2 py-0.5 rounded-full bg-coke-600 text-white font-bold">
                        Bulk Dispatcher
                      </span>
                    </h3>
                    <p className="text-xs text-muted">
                      Mağaza şəbəkəsi və formatı üzrə seqmentasiya ilə avtomatlaşdırılmış paylama
                    </p>
                  </div>
                </div>
                <button
                  onClick={() => setIsBulkModalOpen(false)}
                  aria-label="Pəncərəni bağla"
                  className="w-8 h-8 rounded-full bg-[var(--g-panel)] hover:bg-[var(--g-card)] text-ink-2 flex items-center justify-center transition-colors cursor-pointer"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>

              {/* Form */}
              <form onSubmit={(e) => void handleBulkSubmit(e)} className="p-6 space-y-5">
                {/* SECTION 1: Store Segmentation Filters */}
                <div className="p-4 bg-[var(--g-panel)] rounded-xl border border-hair space-y-3">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-extrabold text-ink flex items-center gap-1.5 uppercase tracking-wider">
                      <Filter className="w-3.5 h-3.5 text-coke-500" />
                      1. Hədəf Mağaza Seqmentasiyası
                    </span>
                    <span className="text-[11px] font-bold text-muted">Şəbəkə üzrə qaydalar</span>
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                    {/* Chain Filter */}
                    <div>
                      <label
                        htmlFor="bulk-chain"
                        className="block text-[11px] font-bold text-ink-2 mb-1"
                      >
                        Şəbəkə (Chain):
                      </label>
                      <select
                        id="bulk-chain"
                        value={bulkChain}
                        onChange={(e) => {
                          setBulkChain(e.target.value);
                          if (bulkError) setBulkError(null);
                        }}
                        className="w-full px-3 py-2 border border-hair rounded-lg text-xs bg-[var(--g-card)] text-ink font-semibold focus:ring-2 focus:ring-[var(--coke-ring)] focus:border-coke/45"
                      >
                        <option value="all">Bütün Şəbəkələr (All)</option>
                        {chainOptions.map((chain) => (
                          <option key={chain} value={chain}>
                            {chain}
                          </option>
                        ))}
                      </select>
                    </div>

                    {/* Format Filter */}
                    <div>
                      <label
                        htmlFor="bulk-format"
                        className="block text-[11px] font-bold text-ink-2 mb-1"
                      >
                        Format (Store Format):
                      </label>
                      <select
                        id="bulk-format"
                        value={bulkFormat}
                        onChange={(e) => {
                          setBulkFormat(e.target.value);
                          if (bulkError) setBulkError(null);
                        }}
                        className="w-full px-3 py-2 border border-hair rounded-lg text-xs bg-[var(--g-card)] text-ink font-semibold focus:ring-2 focus:ring-[var(--coke-ring)] focus:border-coke/45"
                      >
                        <option value="all">Bütün Formatlar</option>
                        {formatOptions.map((format) => (
                          <option key={format} value={format}>
                            {format}
                          </option>
                        ))}
                      </select>
                    </div>

                    {/* Region Filter */}
                    <div>
                      <label
                        htmlFor="bulk-region"
                        className="block text-[11px] font-bold text-ink-2 mb-1"
                      >
                        Region / Şəhər:
                      </label>
                      <select
                        id="bulk-region"
                        value={bulkRegion}
                        onChange={(e) => {
                          setBulkRegion(e.target.value);
                          if (bulkError) setBulkError(null);
                        }}
                        className="w-full px-3 py-2 border border-hair rounded-lg text-xs bg-[var(--g-card)] text-ink font-semibold focus:ring-2 focus:ring-[var(--coke-ring)] focus:border-coke/45"
                      >
                        <option value="all">Bütün Regionlar</option>
                        {regionOptions.map((region) => (
                          <option key={region} value={region}>
                            {region}
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>

                  {/* Live Real-time Target Store Counter Badge */}
                  <div className="pt-2 border-t border-hair flex flex-col sm:flex-row items-start sm:items-center justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <span className="px-3 py-1 rounded-full text-xs font-extrabold bg-emerald-100 text-emerald-800 border border-emerald-300 flex items-center gap-1.5">
                        <Sparkles className="w-3.5 h-3.5 text-emerald-600" />
                        🎯 Hədəf: {matchedStores.length} mağaza seçildi
                      </span>
                      <span className="text-[11px] text-muted font-medium">
                        (Aktiv filtrlərə uyğun)
                      </span>
                    </div>

                    {/* Matched Stores Chips */}
                    <div className="flex items-center gap-1 flex-wrap">
                      {matchedStores.map((s) => (
                        <span
                          key={s.id}
                          className="px-2 py-0.5 rounded text-[10px] font-bold bg-[var(--g-card)] text-ink-2 border border-hair"
                        >
                          {s.name.split(' - ')[0]} ({s.store_code})
                        </span>
                      ))}
                    </div>
                  </div>
                </div>

                {/* SECTION 2: Briefing content (title, instruction, options) */}
                <div className="space-y-3.5">
                  <div>
                    <label
                      htmlFor="bulk-title"
                      className="block text-xs font-bold text-ink mb-1.5 uppercase tracking-wider"
                    >
                      2. Təlimat Məzmunu
                    </label>
                    <input
                      id="bulk-title"
                      type="text"
                      required
                      placeholder="Tapşırığın başlığı (məs: 0.5L Ön Vitrin Soyuducusu Auditi)"
                      value={bulkTitle}
                      onChange={(e) => {
                        setBulkTitle(e.target.value);
                        if (bulkError) setBulkError(null);
                      }}
                      className="w-full px-3 py-2 border border-hair rounded-lg text-xs text-ink bg-[var(--g-card)] focus:outline-none focus:ring-2 focus:ring-[var(--coke-ring)] focus:border-coke/45"
                    />
                  </div>
                  <div>
                    <textarea
                      rows={3}
                      required
                      placeholder="Rəf düzülüşü və məhsul sayı qaydaları..."
                      value={bulkDescription}
                      onChange={(e) => {
                        setBulkDescription(e.target.value);
                        if (bulkError) setBulkError(null);
                      }}
                      className="w-full px-3 py-2 border border-hair rounded-lg text-xs text-ink bg-[var(--g-card)] focus:outline-none focus:ring-2 focus:ring-[var(--coke-ring)] focus:border-coke/45"
                    />
                  </div>
                  <label className="flex items-center gap-2.5 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={bulkRequiresBeforeAfter}
                      onChange={(e) => setBulkRequiresBeforeAfter(e.target.checked)}
                      className="w-4 h-4 rounded border-hair accent-[var(--coke-500)] cursor-pointer"
                    />
                    <span className="text-xs font-semibold text-ink-2">
                      Before &amp; After fotosu tələb olunsun
                    </span>
                  </label>
                </div>

                {/* SECTION 3: Priority & Deadline */}
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div>
                    <label
                      htmlFor="bulk-priority"
                      className="block text-xs font-bold text-ink-2 mb-1"
                    >
                      Prioritet (Priority):
                    </label>
                    <select
                      id="bulk-priority"
                      value={bulkPriority}
                      onChange={(e) => setBulkPriority(e.target.value as TaskPriority)}
                      className="w-full px-3 py-2 border border-hair rounded-lg text-xs bg-[var(--g-card)] text-ink focus:outline-none focus:ring-2 focus:ring-[var(--coke-ring)] focus:border-coke/45 font-semibold"
                    >
                      <option value="urgent">🔴 Təcili (Urgent)</option>
                      <option value="high">🟠 Yüksək (High)</option>
                      <option value="medium">🟡 Orta (Medium)</option>
                      <option value="low">🟢 Aşağı (Low)</option>
                    </select>
                  </div>

                  <div>
                    <label
                      htmlFor="bulk-deadline"
                      className="block text-xs font-bold text-ink-2 mb-1"
                    >
                      Yekunlaşma üçün Son Tarix (Deadline):
                    </label>
                    <input
                      id="bulk-deadline"
                      type="date"
                      required
                      value={bulkDeadline}
                      onChange={(e) => setBulkDeadline(e.target.value)}
                      className="w-full px-3 py-2 border border-hair rounded-lg text-xs bg-[var(--g-card)] text-ink focus:outline-none focus:ring-2 focus:ring-[var(--coke-ring)] focus:border-coke/45 font-semibold"
                    />
                  </div>
                </div>

                {bulkError && (
                  <div className="flex items-start gap-2.5 rounded-xl border border-[rgba(200,60,60,.28)] bg-[rgba(200,60,60,.08)] px-3.5 py-2.5">
                    <AlertTriangle className="w-4 h-4 flex-shrink-0 text-[#b23b3b] mt-[1px]" />
                    <p className="text-[11.5px] leading-relaxed text-ink">{bulkError}</p>
                  </div>
                )}

                {/* Modal Actions */}
                <div className="pt-4 border-t border-hair flex items-center justify-between">
                  <div className="text-[11px] text-muted">
                    Təlimat avtomatik olaraq{' '}
                    <span className="font-bold text-ink">Telegram Bot</span> və{' '}
                    <span className="font-bold text-ink">Mobil Tətbiqə</span> bildiriş göndərəcək.
                  </div>

                  <div className="flex items-center space-x-2.5">
                    <button
                      type="button"
                      onClick={() => setIsBulkModalOpen(false)}
                      className="px-4 py-2 rounded-xl text-xs font-bold text-ink-2 hover:bg-[var(--g-panel)] cursor-pointer"
                    >
                      Ləğv Et
                    </button>
                    <button
                      type="submit"
                      disabled={isBulkSubmitting || matchedStores.length === 0}
                      className="px-5 py-2.5 rounded-xl btn-strong text-white text-xs font-extrabold shadow-md flex items-center space-x-2 cursor-pointer transition-all disabled:opacity-50"
                    >
                      <Send className="w-3.5 h-3.5 text-coke-400" />
                      <span>
                        {isBulkSubmitting
                          ? 'Göndərilir...'
                          : `Kütləvi Göndər (${matchedStores.length} Mağaza)`}
                      </span>
                    </button>
                  </div>
                </div>
              </form>
            </div>
          </div>
        </ModalPortal>
      )}

      {/* ====================================================================== */}
      {/* CREATE NEW TASK MODAL */}
      {/* ====================================================================== */}
      {isCreateModalOpen && (
        <ModalPortal>
          <div className="fixed inset-0 z-50 modal-veil flex items-center justify-center p-4 sm:p-6 overflow-y-auto">
            <div
              ref={createModalRef}
              role="dialog"
              aria-modal="true"
              aria-label="Yeni planogram təlimatı yarat"
              className="glass-pop w-full max-w-xl rounded-card overflow-hidden my-auto"
            >
              {/* Modal Header */}
              <div className="p-5 border-b border-hair flex items-center justify-between bg-[var(--g-panel)]">
                <div>
                  <h3 className="font-extrabold text-sm sm:text-base text-ink">
                    Yeni tapşırıq yarat
                  </h3>
                  <p className="text-xs text-muted">
                    Mağazalara və sahə merchandiser-lərinə göndəriləcək yeni rəf auditi
                  </p>
                </div>
                <button
                  onClick={() => setIsCreateModalOpen(false)}
                  aria-label="Pəncərəni bağla"
                  className="w-8 h-8 rounded-full bg-[var(--g-panel)] hover:bg-[var(--g-card)] text-ink-2 flex items-center justify-center transition-colors cursor-pointer"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>

              {/* Form */}
              <form onSubmit={(e) => void handleSubmit(e)} className="p-5 space-y-3.5">
                {/* Title */}
                <div>
                  <label htmlFor="task-title" className="block text-xs font-bold text-ink-2 mb-1">
                    Tapşırığın Başlığı *
                  </label>
                  <input
                    id="task-title"
                    type="text"
                    required
                    placeholder="Məs: Coca-Cola Zero Sugar Promo Stand Check"
                    value={title}
                    onChange={(e) => {
                      setTitle(e.target.value);
                      if (createError) setCreateError(null);
                    }}
                    className="w-full px-3 py-2 border border-hair rounded-lg text-xs text-ink focus:outline-none focus:ring-2 focus:ring-[var(--coke-ring)] focus:border-coke/45 bg-[var(--g-card)]"
                  />
                </div>

                {/* Instructions */}
                <div>
                  <label
                    htmlFor="task-instructions"
                    className="block text-xs font-bold text-ink-2 mb-1"
                  >
                    Düzülüş Təlimatı və Facing Qaydaları *
                  </label>
                  <textarea
                    id="task-instructions"
                    rows={3}
                    required
                    placeholder="Məs: Bütün Coca-Cola 0.5L şüşələri soyuducunun 1-ci rəfində tələb olunan sayda..."
                    value={description}
                    onChange={(e) => {
                      setDescription(e.target.value);
                      if (createError) setCreateError(null);
                    }}
                    className="w-full px-3 py-2 border border-hair rounded-lg text-xs text-ink focus:outline-none focus:ring-2 focus:ring-[var(--coke-ring)] focus:border-coke/45 bg-[var(--g-card)]"
                  />
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label
                      htmlFor="task-priority"
                      className="block text-xs font-bold text-ink-2 mb-1"
                    >
                      Prioritet
                    </label>
                    <select
                      id="task-priority"
                      value={priority}
                      onChange={(e) => setPriority(e.target.value as TaskPriority)}
                      className="w-full px-3 py-2 border border-hair rounded-lg text-xs text-ink bg-[var(--g-card)] focus:outline-none focus:ring-2 focus:ring-[var(--coke-ring)] focus:border-coke/45"
                    >
                      <option value="low">🟢 Aşağı (Low)</option>
                      <option value="medium">🟡 Orta (Medium)</option>
                      <option value="high">🟠 Yüksək (High)</option>
                      <option value="urgent">🔴 Təcili (Urgent)</option>
                    </select>
                  </div>

                  <div>
                    <label
                      htmlFor="task-deadline"
                      className="block text-xs font-bold text-ink-2 mb-1"
                    >
                      Yoxlama üçün Son Tarix *
                    </label>
                    <input
                      id="task-deadline"
                      type="date"
                      required
                      value={deadline}
                      onChange={(e) => setDeadline(e.target.value)}
                      className="w-full px-3 py-2 border border-hair rounded-lg text-xs text-ink bg-[var(--g-card)] focus:outline-none focus:ring-2 focus:ring-[var(--coke-ring)] focus:border-coke/45"
                    />
                  </div>
                </div>

                {/* Planogram Reference Photo Upload / URL */}
                <div>
                  <div className="flex items-center justify-between mb-1.5">
                    <span className="block text-xs font-bold text-ink-2">Rəf nümunəsi fotosu</span>
                    <button
                      type="button"
                      onClick={() => fileInputRef.current?.click()}
                      className="flex items-center gap-1.5 text-[11px] font-extrabold text-coke hover:opacity-80 transition-opacity cursor-pointer"
                    >
                      <Upload className="w-3.5 h-3.5" />
                      <span>Kompüterdən Şəkil Seç</span>
                    </button>
                  </div>

                  <input
                    type="file"
                    ref={fileInputRef}
                    accept="image/*"
                    onChange={handleFileSelect}
                    className="hidden"
                  />

                  <div className="flex items-center gap-2.5">
                    <div className="flex-1">
                      <input
                        type="text"
                        placeholder="https://.../planogram.jpg və ya kompüterdən seçin"
                        value={referenceImageUrl}
                        onChange={(e) => {
                          setReferenceImageUrl(e.target.value);
                          if (createError) setCreateError(null);
                        }}
                        className="w-full px-3 py-2 border border-hair rounded-lg text-xs text-ink bg-[var(--g-card)] focus:outline-none focus:ring-2 focus:ring-[var(--coke-ring)] focus:border-coke/45 truncate"
                      />
                    </div>
                    {referenceImageUrl && (
                      <div className="w-12 h-9 rounded-lg overflow-hidden border border-hair bg-[var(--g-panel)] flex-shrink-0 relative group shadow-sm">
                        <img
                          src={referenceImageUrl}
                          alt="Preview"
                          className="w-full h-full object-cover"
                          onError={(e) => {
                            (e.target as HTMLElement).style.display = 'none';
                          }}
                        />
                      </div>
                    )}
                  </div>
                  <p className="text-[11px] text-muted mt-1">
                    Kompüterinizdən birbaşa şəkil seçə və ya URL daxil edə bilərsiniz (PNG, JPG,
                    WebP).
                  </p>
                </div>

                {/* Store Assignment (Multi-select) */}
                <div>
                  <span className="block text-xs font-bold text-ink-2 mb-1.5">
                    Təhkim Olunacaq Mağazalar:
                  </span>
                  <div className="grid grid-cols-2 gap-1.5 max-h-32 overflow-y-auto p-2.5 border border-hair rounded-lg bg-[var(--g-panel)]">
                    <button
                      type="button"
                      onClick={() => toggleStore('all')}
                      aria-pressed={stores.length > 0 && selectedStoreIds.length === stores.length}
                      className="flex items-center space-x-1.5 cursor-pointer p-1 rounded hover:bg-[var(--g-card)] text-xs font-bold text-ink"
                    >
                      {stores.length > 0 && selectedStoreIds.length === stores.length ? (
                        <CheckSquare className="w-3.5 h-3.5 text-coke-500" />
                      ) : (
                        <Square className="w-3.5 h-3.5 text-muted" />
                      )}
                      <span>Bütün Mağazalar (Şəbəkə Üzrə)</span>
                    </button>

                    {stores.map((store) => {
                      const isChecked = selectedStores.includes(store.id);
                      return (
                        <button
                          type="button"
                          key={store.id}
                          onClick={() => toggleStore(store.id)}
                          aria-pressed={isChecked}
                          className="flex items-center space-x-1.5 cursor-pointer p-1 rounded hover:bg-[var(--g-card)] text-xs text-ink-2"
                        >
                          {isChecked ? (
                            <CheckSquare className="w-3.5 h-3.5 text-coke-500" />
                          ) : (
                            <Square className="w-3.5 h-3.5 text-muted" />
                          )}
                          <span className="truncate">{store.name}</span>
                        </button>
                      );
                    })}
                  </div>
                </div>

                <p role="status" className="text-sm text-ink-2">
                  {selectedStoreIds.length === 0
                    ? 'Heç bir mağaza seçilməyib.'
                    : `Seçilən mağaza sayı: ${selectedStoreIds.length}. Təlimat yalnız bu mağazalara göndəriləcək.`}
                </p>
                {createError && (
                  <div className="flex items-start gap-2.5 rounded-xl border border-[rgba(200,60,60,.28)] bg-[rgba(200,60,60,.08)] px-3.5 py-2.5">
                    <AlertTriangle className="w-4 h-4 flex-shrink-0 text-[#b23b3b] mt-[1px]" />
                    <p className="text-[11.5px] leading-relaxed text-ink">{createError}</p>
                  </div>
                )}

                {/* Modal Submit Actions */}
                <div className="pt-3 border-t border-hair flex items-center justify-end space-x-2.5">
                  <button
                    type="button"
                    onClick={() => setIsCreateModalOpen(false)}
                    className="px-3.5 py-1.5 rounded-lg text-xs font-bold text-ink-2 hover:bg-[var(--g-panel)] cursor-pointer"
                  >
                    Ləğv Et
                  </button>
                  <button
                    type="submit"
                    disabled={isSubmitting}
                    className="px-5 py-1.5 rounded-lg btn-coke text-white text-xs font-bold transition-all cursor-pointer"
                  >
                    {isSubmitting ? 'Saxlanılır...' : `${selectedStoreIds.length} mağazaya dərc et`}
                  </button>
                </div>
              </form>
            </div>
          </div>
        </ModalPortal>
      )}

      {/* ====================================================================== */}
      {/* TAPŞIRIĞI REDAKTƏ ET                                                   */}
      {/* ====================================================================== */}
      {editingTask && editValues && (
        <ModalPortal>
          <div className="fixed inset-0 z-50 modal-veil flex items-center justify-center p-4 sm:p-6 overflow-y-auto">
            <div
              ref={editModalRef}
              role="dialog"
              aria-modal="true"
              aria-label="Tapşırığı redaktə et"
              className="glass-pop w-full max-w-2xl rounded-card overflow-hidden my-auto"
            >
              <div className="p-5 border-b border-hair flex items-center justify-between bg-[var(--g-panel)]">
                <div className="flex items-center space-x-3">
                  <div className="w-10 h-10 rounded-xl bg-coke-500 flex items-center justify-center text-white shadow-md shadow-[0_3px_10px_-3px_var(--coke-ring)]">
                    <Pencil className="w-5 h-5" />
                  </div>
                  <div>
                    <h3 className="font-extrabold text-sm sm:text-base text-ink">
                      Tapşırığı redaktə et
                    </h3>
                    <p className="text-xs text-muted">{editingTask.title}</p>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={closeEdit}
                  aria-label="Bağla"
                  className="p-1.5 rounded-lg text-muted hover:text-ink hover:bg-[var(--g-card)] cursor-pointer"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>

              <form
                onSubmit={(e) => void submitEdit(e)}
                className="p-5 space-y-4 max-h-[65vh] overflow-y-auto"
              >
                {/*
                  The single most important sentence on this screen. The panel
                  shows one card per store, so a supervisor reasonably expects
                  the edit to touch the card they clicked. Four of these five
                  fields do not.
                */}
                {(editingTask.sibling_task_count ?? 1) > 1 && (
                  <div className="flex items-start gap-2.5 rounded-xl border border-amber-200 bg-amber-50 px-3.5 py-2.5">
                    <AlertTriangle className="w-4 h-4 flex-shrink-0 text-amber-600 mt-[1px]" />
                    <p className="text-[11.5px] leading-relaxed text-ink">
                      Bu təlimat <b>{editingTask.sibling_task_count} mağazaya</b> göndərilib.
                      Başlıq, təsvir, prioritet, çeklist və foto tələbi <b>hamısında</b> dəyişəcək.
                      Yalnız son tarix bu mağazaya aiddir.
                    </p>
                  </div>
                )}

                <div>
                  <label
                    htmlFor="task-edit-title"
                    className="block text-[11px] font-bold text-ink-2 mb-1.5"
                  >
                    Tapşırıq Başlığı *
                  </label>
                  <input
                    id="task-edit-title"
                    type="text"
                    value={editValues.title}
                    onChange={(e) => setEditValues({ ...editValues, title: e.target.value })}
                    className="w-full px-3 py-2 border border-hair rounded-lg text-xs text-ink bg-[var(--g-card)] focus:outline-none focus:ring-2 focus:ring-[var(--coke-ring)] focus:border-coke/45"
                  />
                </div>

                <div>
                  <label
                    htmlFor="task-edit-instructions"
                    className="block text-[11px] font-bold text-ink-2 mb-1.5"
                  >
                    Təlimat
                  </label>
                  <textarea
                    id="task-edit-instructions"
                    rows={3}
                    value={editValues.description}
                    onChange={(e) => setEditValues({ ...editValues, description: e.target.value })}
                    className="w-full px-3 py-2 border border-hair rounded-lg text-xs text-ink bg-[var(--g-card)] focus:outline-none focus:ring-2 focus:ring-[var(--coke-ring)] focus:border-coke/45 resize-none"
                  />
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div>
                    <label
                      htmlFor="task-edit-priority"
                      className="block text-[11px] font-bold text-ink-2 mb-1.5"
                    >
                      Prioritet
                    </label>
                    <select
                      id="task-edit-priority"
                      value={editValues.priority}
                      onChange={(e) =>
                        setEditValues({ ...editValues, priority: e.target.value as TaskPriority })
                      }
                      className="w-full px-3 py-2 border border-hair rounded-lg text-xs text-ink bg-[var(--g-card)] focus:outline-none focus:ring-2 focus:ring-[var(--coke-ring)]"
                    >
                      <option value="low">Aşağı</option>
                      <option value="medium">Orta</option>
                      <option value="high">Yüksək</option>
                      <option value="urgent">Təcili</option>
                    </select>
                  </div>
                  <div>
                    <label
                      htmlFor="task-edit-deadline"
                      className="block text-[11px] font-bold text-ink-2 mb-1.5"
                    >
                      Son Tarix (bu mağaza üçün) *
                    </label>
                    <input
                      id="task-edit-deadline"
                      type="datetime-local"
                      value={editValues.deadline}
                      onChange={(e) => setEditValues({ ...editValues, deadline: e.target.value })}
                      className="w-full px-3 py-2 border border-hair rounded-lg text-xs text-ink bg-[var(--g-card)] focus:outline-none focus:ring-2 focus:ring-[var(--coke-ring)] focus:border-coke/45"
                    />
                  </div>
                </div>

                <label className="flex items-center gap-2.5 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={editValues.requires_before_after_photo}
                    onChange={(e) =>
                      setEditValues({
                        ...editValues,
                        requires_before_after_photo: e.target.checked,
                      })
                    }
                    className="w-4 h-4 rounded border-hair accent-[var(--coke-500)] cursor-pointer"
                  />
                  <span className="text-xs font-semibold text-ink-2">
                    Before &amp; After fotosu tələb olunsun
                  </span>
                </label>

                <div>
                  <div className="flex items-center justify-between mb-1.5">
                    <span className="text-[11px] font-bold text-ink-2">
                      Çeklist sualları ({editValues.checklist_schema.length})
                    </span>
                    <button
                      type="button"
                      onClick={() =>
                        setEditValues({
                          ...editValues,
                          checklist_schema: [
                            ...editValues.checklist_schema,
                            { id: `q${Date.now()}`, label: '', type: 'boolean' },
                          ],
                        })
                      }
                      className="text-[11px] font-bold text-coke-600 hover:underline cursor-pointer"
                    >
                      + Sual əlavə et
                    </button>
                  </div>
                  {editValues.checklist_schema.length === 0 ? (
                    <p className="text-[11px] text-muted italic">
                      Çeklist yoxdur — bu tapşırıq ümumi audit kimi göndəriləcək.
                    </p>
                  ) : (
                    <div className="space-y-2">
                      {editValues.checklist_schema.map((item, index) => (
                        <div
                          key={item.id}
                          className="rounded-lg border border-hair bg-[var(--g-card)] p-2 space-y-1.5"
                        >
                          <div className="flex items-center gap-2">
                            <span className="w-5 flex-shrink-0 text-[11px] font-bold text-muted">
                              {index + 1}
                            </span>
                            <input
                              type="text"
                              value={item.label}
                              placeholder="Sual mətni (məsələn: Raf tam doludurmu?)"
                              onChange={(e) => {
                                const next = [...editValues.checklist_schema];
                                next[index] = { ...next[index], label: e.target.value };
                                setEditValues({ ...editValues, checklist_schema: next });
                              }}
                              className="flex-1 px-3 py-1.5 border border-hair rounded-lg text-xs text-ink bg-[var(--g-card)] focus:outline-none focus:ring-2 focus:ring-[var(--coke-ring)]"
                            />
                            <select
                              value={item.type}
                              aria-label={`${index + 1}-ci sualın cavab tipi`}
                              onChange={(e) => {
                                const type = e.target.value as ChecklistItem['type'];
                                const next = [...editValues.checklist_schema];
                                next[index] = {
                                  ...next[index],
                                  type,
                                  ...(type === 'single_choice'
                                    ? { options: next[index].options ?? [] }
                                    : { options: undefined }),
                                };
                                setEditValues({ ...editValues, checklist_schema: next });
                              }}
                              className="flex-shrink-0 px-2 py-1.5 border border-hair rounded-lg text-xs text-ink bg-[var(--g-card)] focus:outline-none focus:ring-2 focus:ring-[var(--coke-ring)] cursor-pointer"
                            >
                              {CHECKLIST_TYPES.map((t) => (
                                <option key={t.value} value={t.value}>
                                  {t.label}
                                </option>
                              ))}
                            </select>
                            <button
                              type="button"
                              aria-label={`${index + 1}-ci sualı sil`}
                              onClick={() =>
                                setEditValues({
                                  ...editValues,
                                  checklist_schema: editValues.checklist_schema.filter(
                                    (_, i) => i !== index,
                                  ),
                                })
                              }
                              className="p-1.5 rounded-lg text-muted hover:text-[#b23b3b] hover:bg-[rgba(200,60,60,.08)] cursor-pointer"
                            >
                              <X className="w-3.5 h-3.5" />
                            </button>
                          </div>
                          {item.type === 'single_choice' && (
                            <input
                              type="text"
                              value={(item.options ?? []).join(', ')}
                              placeholder="Seçimlər (vergüllə ayır): Var, Yoxdur, Qismən"
                              onChange={(e) => {
                                const next = [...editValues.checklist_schema];
                                next[index] = {
                                  ...next[index],
                                  options: e.target.value.split(',').map((o) => o.trim()),
                                };
                                setEditValues({ ...editValues, checklist_schema: next });
                              }}
                              className="w-full ml-7 px-3 py-1.5 border border-hair rounded-lg text-xs text-ink bg-[var(--g-card)] focus:outline-none focus:ring-2 focus:ring-[var(--coke-ring)]"
                              style={{ width: 'calc(100% - 1.75rem)' }}
                            />
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                {editError && (
                  <div className="flex items-start gap-2.5 rounded-xl border border-[rgba(200,60,60,.28)] bg-[rgba(200,60,60,.08)] px-3.5 py-2.5">
                    <AlertTriangle className="w-4 h-4 flex-shrink-0 text-[#b23b3b] mt-[1px]" />
                    <p className="text-[11.5px] leading-relaxed text-ink">{editError}</p>
                  </div>
                )}

                <div className="pt-3 border-t border-hair flex items-center justify-end space-x-2.5">
                  <button
                    type="button"
                    onClick={closeEdit}
                    className="px-3.5 py-1.5 rounded-lg text-xs font-bold text-ink-2 hover:bg-[var(--g-panel)] cursor-pointer"
                  >
                    Ləğv Et
                  </button>
                  <button
                    type="submit"
                    disabled={isSavingEdit}
                    className="px-5 py-1.5 rounded-lg btn-coke text-white text-xs font-bold transition-all cursor-pointer disabled:opacity-60 disabled:cursor-not-allowed inline-flex items-center gap-1.5"
                  >
                    {isSavingEdit && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                    {isSavingEdit ? 'Saxlanılır...' : 'Yadda saxla'}
                  </button>
                </div>
              </form>
            </div>
          </div>
        </ModalPortal>
      )}

      {/* ====================================================================== */}
      {/* TAPŞIRIĞI SİL                                                          */}
      {/* ====================================================================== */}
      {deletingTask && (
        <ModalPortal>
          <div className="fixed inset-0 z-50 modal-veil flex items-center justify-center p-4 sm:p-6 overflow-y-auto">
            <div
              ref={deleteModalRef}
              role="dialog"
              aria-modal="true"
              aria-label="Tapşırığı sil"
              className="glass-pop w-full max-w-lg rounded-card overflow-hidden my-auto"
            >
              <div className="p-5 border-b border-hair flex items-center justify-between bg-[var(--g-panel)]">
                <div className="flex items-center space-x-3">
                  <div className="w-10 h-10 rounded-xl bg-[rgba(200,60,60,.14)] flex items-center justify-center text-[#b23b3b]">
                    <Trash2 className="w-5 h-5" />
                  </div>
                  <div>
                    <h3 className="font-extrabold text-sm sm:text-base text-ink">Tapşırığı sil</h3>
                    <p className="text-xs text-muted">Bu əməliyyat geri qaytarılmır</p>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={closeDelete}
                  aria-label="Bağla"
                  className="p-1.5 rounded-lg text-muted hover:text-ink hover:bg-[var(--g-card)] cursor-pointer"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>

              <div className="p-5 space-y-3.5">
                <p className="text-xs leading-relaxed text-ink">
                  <b>{deletingTask.title}</b> tapşırığı silinəcək. Tapşırığın təlimatı və bu mağaza
                  üçün yaradılmış qeyd bazadan çıxacaq.
                </p>

                {/*
                  The API refuses this with 409 TASK_HAS_EVIDENCE, because
                  `task_evidences.store_task_id` is ON DELETE CASCADE and the
                  delete would take the photos with it. Saying so here means the
                  supervisor learns it before pressing the button rather than
                  after — but the button stays enabled, because the count on this
                  card can be a refresh behind.
                */}
                {(deletingTask.evidence_count ?? 0) > 0 && (
                  <div className="flex items-start gap-2.5 rounded-xl border border-amber-200 bg-amber-50 px-3.5 py-2.5">
                    <AlertTriangle className="w-4 h-4 flex-shrink-0 text-amber-600 mt-[1px]" />
                    <p className="text-[11.5px] leading-relaxed text-ink">
                      Bu tapşırığa <b>{deletingTask.evidence_count} audit göndərişi</b> var. Silinmə
                      rədd olunacaq — silinsəydi, həmin fotolar və çeklist cavabları da silinərdi.
                    </p>
                  </div>
                )}

                {deleteError && (
                  <div className="flex items-start gap-2.5 rounded-xl border border-[rgba(200,60,60,.28)] bg-[rgba(200,60,60,.08)] px-3.5 py-2.5">
                    <AlertTriangle className="w-4 h-4 flex-shrink-0 text-[#b23b3b] mt-[1px]" />
                    <p className="text-[11.5px] leading-relaxed text-ink">{deleteError}</p>
                  </div>
                )}

                <div className="pt-3 border-t border-hair flex items-center justify-end space-x-2.5">
                  <button
                    type="button"
                    onClick={closeDelete}
                    className="px-3.5 py-1.5 rounded-lg text-xs font-bold text-ink-2 hover:bg-[var(--g-panel)] cursor-pointer"
                  >
                    Ləğv Et
                  </button>
                  <button
                    type="button"
                    onClick={() => void submitDelete()}
                    disabled={isDeleting}
                    className="px-5 py-1.5 rounded-lg bg-[#b23b3b] text-white text-xs font-bold transition-all cursor-pointer disabled:opacity-60 disabled:cursor-not-allowed inline-flex items-center gap-1.5"
                  >
                    {isDeleting && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                    {isDeleting ? 'Silinir...' : 'Bəli, sil'}
                  </button>
                </div>
              </div>
            </div>
          </div>
        </ModalPortal>
      )}
    </div>
  );
};
