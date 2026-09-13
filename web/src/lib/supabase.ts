import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { Store, Task, Submission, DashboardMetrics, SubmissionStatus } from '../types';

const env: Record<string, any> =
  (typeof import.meta !== 'undefined' && (import.meta as any).env) ||
  (typeof process !== 'undefined' && process.env) ||
  {};

const SUPABASE_URL = env.VITE_SUPABASE_URL || env.SUPABASE_URL || 'https://mock-oneteam.supabase.co';
const SUPABASE_ANON_KEY = env.VITE_SUPABASE_ANON_KEY || env.SUPABASE_ANON_KEY || 'mock-anon-key';

export const isMockClient =
  !env.VITE_SUPABASE_URL ||
  SUPABASE_URL.includes('mock-oneteam') ||
  SUPABASE_URL.includes('mock');

// Initial realistic seed state
const INITIAL_STORES: Store[] = [
  {
    id: '22222222-2222-2222-2222-222222222221',
    store_code: 'BRAVO_28MAY_01',
    name: 'Bravo Supermarket - 28 Mall',
    chain_name: 'Bravo',
    store_format: 'supermarket',
    region_id: 'reg-baku-central',
    address: '28 May küç., Nəsimi ray., Bakı',
    city: 'Bakı',
    latitude: 40.379893,
    longitude: 49.847512,
    is_active: true,
    created_at: '2026-09-01T10:00:00Z',
  },
  {
    id: '22222222-2222-2222-2222-222222222222',
    store_code: 'ARAZ_GENJLIK_02',
    name: 'Araz Superstore - Gənclik',
    chain_name: 'Araz',
    store_format: 'supermarket',
    region_id: 'reg-baku-central',
    address: 'Fətəli Xan Xoyski pr. 14, Bakı',
    city: 'Bakı',
    latitude: 40.400215,
    longitude: 49.852441,
    is_active: true,
    created_at: '2026-09-02T11:00:00Z',
  },
  {
    id: '22222222-2222-2222-2222-222222222223',
    store_code: 'BAZAR_PORTBAKU_03',
    name: 'Bazarstore Gourmet - Port Baku',
    chain_name: 'Bazarstore',
    store_format: 'supermarket',
    region_id: 'reg-baku-central',
    address: 'Neftçilər pr. 151, Səbail, Bakı',
    city: 'Bakı',
    latitude: 40.375112,
    longitude: 49.863145,
    is_active: true,
    created_at: '2026-09-05T09:30:00Z',
  },
  {
    id: '22222222-2222-2222-2222-222222222224',
    store_code: 'BRAVO_YASAMAL_04',
    name: 'Bravo Hypermarket - Yasamal',
    chain_name: 'Bravo',
    store_format: 'hypermarket',
    region_id: 'reg-baku-central',
    address: 'Həsən bəy Zərdabi pr. 92, Yasamal, Bakı',
    city: 'Bakı',
    latitude: 40.385012,
    longitude: 49.810541,
    is_active: true,
    created_at: '2026-09-06T14:15:00Z',
  },
];

const INITIAL_TASKS: Task[] = [
  {
    id: '11111111-1111-1111-1111-111111111111',
    title: 'Coca-Cola 0.5L Cooler Placement Check',
    description:
      'Təlimat: 1. Coca-Cola Classic, Zero Sugar, Sprite və Fanta 0.5L məhsulları mütləq ön vitrin soyuducusunda yerləşdirilməlidir.\n2. Bütün brend loqoları alıcıya doğru (front-facing) yönəlməlidir.\n3. Hər SKU üçün minimum 3 facing təmin edilməlidir.\n4. Soyuducu temperaturu <= 4°C olmalıdır.\n5. Cari ayın promo qiymət kağızları aydın görünməlidir.',
    reference_image_url:
      'https://images.unsplash.com/photo-1622483767028-3f66f32aef97?auto=format&fit=crop&w=800&q=80',
    priority: 'high',
    status: 'published',
    deadline: '2026-09-20T18:00:00Z',
    created_at: '2026-09-10T08:00:00Z',
    assigned_stores: [
      '22222222-2222-2222-2222-222222222221',
      '22222222-2222-2222-2222-222222222222',
      '22222222-2222-2222-2222-222222222223',
    ],
  },
  {
    id: '11111111-1111-1111-1111-111111111112',
    title: 'Coca-Cola Zero Sugar Promo Stand Display',
    description:
      'Təlimat: Kassaya yaxın ərazidə qara rəngli Zero Sugar promo stendinin quraşdırılmasını yoxlayın. 0.33L dəmir banka və 1L şüşələrin rəfdə tam dolu olmasını təmin edin.',
    reference_image_url:
      'https://images.unsplash.com/photo-1554866585-cd94860890b7?auto=format&fit=crop&w=800&q=80',
    priority: 'urgent',
    status: 'published',
    deadline: '2026-09-18T12:00:00Z',
    created_at: '2026-09-11T09:30:00Z',
    assigned_stores: [
      '22222222-2222-2222-2222-222222222221',
      '22222222-2222-2222-2222-222222222224',
    ],
  },
  {
    id: '11111111-1111-1111-1111-111111111113',
    title: 'Fanta Orange & Sprite Göz Səviyyəsi Audit',
    description:
      'Orta rəflərdə Fanta və Sprite məhsullarının 1.5L həcmlərinin göz səviyyəsində fasiləsiz düzülüşünü və təmizliyini yoxlayın.',
    reference_image_url:
      'https://images.unsplash.com/photo-1581009146145-b5ef050c2e1e?auto=format&fit=crop&w=800&q=80',
    priority: 'medium',
    status: 'published',
    deadline: '2026-09-25T20:00:00Z',
    created_at: '2026-09-12T07:15:00Z',
    assigned_stores: [
      '22222222-2222-2222-2222-222222222222',
      '22222222-2222-2222-2222-222222222223',
    ],
  },
];

const INITIAL_SUBMISSIONS: Submission[] = [
  {
    // SCENARIO A: Perfect Compliant Shelf (95% Score, Auto-Approved by AI)
    id: 'sub-001',
    task_id: '11111111-1111-1111-1111-111111111111',
    store_id: '22222222-2222-2222-2222-222222222221',
    photo_type: 'after',
    before_photo_url:
      'https://images.unsplash.com/photo-1581093458791-9f3c3900df4b?auto=format&fit=crop&w=1200&q=80',
    photo_url:
      'https://images.unsplash.com/photo-1554866585-cd94860890b7?auto=format&fit=crop&w=1200&q=80',
    checklist_answers: [
      {
        questionId: 'q-temp',
        question: 'Soyuducu temperaturu normaya uyğundurmu? (<= 4°C)',
        value: 3.4,
        unit: '°C',
      },
      {
        questionId: 'q-clean',
        question: 'Soyuducu şüşəsi və rəflər təmizdirmi?',
        value: true,
      },
      {
        questionId: 'q-promo-posm',
        question: 'Promo POSM materialı mövcuddurmu?',
        value: 'Mövcuddur və yerləşdirilib',
      },
    ],
    status: 'approved',
    reviewer_feedback:
      '⚡ AI Avtomatik Təsdiqi (Uyğunluq Balı: 95%). İdeal vitrin tərtibatı: Bütün Coca-Cola Classic, Zero Sugar və Fanta məhsulları tələb olunan sayda və front-facing vəziyyətindədir.',
    ai_score: 95,
    ai_summary:
      '✅ Planogram Uyğunluğu: 95% (AI tərəfindən avto-təsdiqlənib). Rəf düzülüşü standartlara tam cavab verir. Aşkarlandı: 4x Classic, 3x Zero, 3x Fanta, 2x Sprite. 0 boşluq.',
    ai_detections: [
      { id: 'det-a1', sku: 'coca_cola_classic', label: 'Coca-Cola Classic 0.5L', confidence: 0.98, box: { x: 6, y: 15, width: 13, height: 32 }, color: '#F40009', shelfRow: 1, facingIndex: 1 },
      { id: 'det-a2', sku: 'coca_cola_classic', label: 'Coca-Cola Classic 0.5L', confidence: 0.97, box: { x: 21, y: 15, width: 13, height: 32 }, color: '#F40009', shelfRow: 1, facingIndex: 2 },
      { id: 'det-a3', sku: 'coca_cola_classic', label: 'Coca-Cola Classic 0.5L', confidence: 0.99, box: { x: 36, y: 15, width: 13, height: 32 }, color: '#F40009', shelfRow: 1, facingIndex: 3 },
      { id: 'det-a4', sku: 'coca_cola_classic', label: 'Coca-Cola Classic 0.5L', confidence: 0.96, box: { x: 51, y: 15, width: 13, height: 32 }, color: '#F40009', shelfRow: 1, facingIndex: 4 },
      { id: 'det-a5', sku: 'coca_cola_zero', label: 'Coca-Cola Zero Sugar 0.5L', confidence: 0.95, box: { x: 66, y: 15, width: 13, height: 32 }, color: '#111827', shelfRow: 1, facingIndex: 5 },
      { id: 'det-a6', sku: 'coca_cola_zero', label: 'Coca-Cola Zero Sugar 0.5L', confidence: 0.96, box: { x: 81, y: 15, width: 13, height: 32 }, color: '#111827', shelfRow: 1, facingIndex: 6 },
      { id: 'det-a7', sku: 'coca_cola_zero', label: 'Coca-Cola Zero Sugar 0.5L', confidence: 0.94, box: { x: 6, y: 52, width: 13, height: 32 }, color: '#111827', shelfRow: 2, facingIndex: 1 },
      { id: 'det-a8', sku: 'fanta', label: 'Fanta Orange 0.5L', confidence: 0.96, box: { x: 21, y: 52, width: 13, height: 32 }, color: '#FF7300', shelfRow: 2, facingIndex: 2 },
      { id: 'det-a9', sku: 'fanta', label: 'Fanta Orange 0.5L', confidence: 0.97, box: { x: 36, y: 52, width: 13, height: 32 }, color: '#FF7300', shelfRow: 2, facingIndex: 3 },
      { id: 'det-a10', sku: 'fanta', label: 'Fanta Orange 0.5L', confidence: 0.95, box: { x: 51, y: 52, width: 13, height: 32 }, color: '#FF7300', shelfRow: 2, facingIndex: 4 },
      { id: 'det-a11', sku: 'sprite', label: 'Sprite 0.5L', confidence: 0.97, box: { x: 66, y: 52, width: 13, height: 32 }, color: '#008B47', shelfRow: 2, facingIndex: 5 },
      { id: 'det-a12', sku: 'sprite', label: 'Sprite 0.5L', confidence: 0.96, box: { x: 81, y: 52, width: 13, height: 32 }, color: '#008B47', shelfRow: 2, facingIndex: 6 },
    ],
    metadata: {
      scenario: 'scenario_a_compliant',
      telegram_user_id: 998877665,
      telegram_username: 'eldar_coke',
      message_id: 301,
      captured_at: '2026-09-12T15:30:00Z',
      gps: { latitude: 40.379893, longitude: 49.847512 },
    },
    submitted_at: '2026-09-12T15:32:00Z',
    reviewed_at: '2026-09-12T15:32:05Z',
    submitter_name: 'Eldar Məmmədov (Merchandiser)',
  },
  {
    // SCENARIO B: Shelf with Out-of-Stock Gaps (70% Score, Manual Review Needed)
    id: 'sub-002',
    task_id: '11111111-1111-1111-1111-111111111112',
    store_id: '22222222-2222-2222-2222-222222222222',
    photo_url:
      'https://images.unsplash.com/photo-1581093458791-9f3c3900df4b?auto=format&fit=crop&w=1200&q=80',
    status: 'pending_review',
    reviewer_feedback: null,
    ai_score: 70,
    ai_summary:
      '⚠️ Planogram Uyğunluğu: 70% (Supervayzer yoxlaması tələb olunur). Səbəb: Rəfdə 2 ədəd boşluq (out of stock gap) aşkarlandı (-30% cərimə tətbiq edildi). Aşkarlandı: 3x Classic, 2x Zero, 2x Fanta, 1x Sprite, 2x Boşluq.',
    ai_detections: [
      { id: 'det-b1', sku: 'coca_cola_classic', label: 'Coca-Cola Classic 0.5L', confidence: 0.96, box: { x: 7, y: 16, width: 14, height: 32 }, color: '#F40009', shelfRow: 1, facingIndex: 1 },
      { id: 'det-b2', sku: 'coca_cola_classic', label: 'Coca-Cola Classic 0.5L', confidence: 0.94, box: { x: 23, y: 16, width: 14, height: 32 }, color: '#F40009', shelfRow: 1, facingIndex: 2 },
      { id: 'det-b3', sku: 'out_of_stock_gap', label: 'Boşluq (Out of Stock)', confidence: 0.89, box: { x: 39, y: 16, width: 16, height: 32 }, color: '#EF4444', shelfRow: 1, facingIndex: 3 },
      { id: 'det-b4', sku: 'coca_cola_zero', label: 'Coca-Cola Zero Sugar 0.5L', confidence: 0.95, box: { x: 58, y: 16, width: 14, height: 32 }, color: '#111827', shelfRow: 1, facingIndex: 4 },
      { id: 'det-b5', sku: 'coca_cola_zero', label: 'Coca-Cola Zero Sugar 0.5L', confidence: 0.93, box: { x: 75, y: 16, width: 14, height: 32 }, color: '#111827', shelfRow: 1, facingIndex: 5 },
      { id: 'det-b6', sku: 'coca_cola_classic', label: 'Coca-Cola Classic 0.5L', confidence: 0.92, box: { x: 7, y: 52, width: 14, height: 32 }, color: '#F40009', shelfRow: 2, facingIndex: 1 },
      { id: 'det-b7', sku: 'fanta', label: 'Fanta Orange 0.5L', confidence: 0.94, box: { x: 23, y: 52, width: 14, height: 32 }, color: '#FF7300', shelfRow: 2, facingIndex: 2 },
      { id: 'det-b8', sku: 'fanta', label: 'Fanta Orange 0.5L', confidence: 0.93, box: { x: 39, y: 52, width: 14, height: 32 }, color: '#FF7300', shelfRow: 2, facingIndex: 3 },
      { id: 'det-b9', sku: 'out_of_stock_gap', label: 'Boşluq (Out of Stock)', confidence: 0.88, box: { x: 56, y: 52, width: 17, height: 32 }, color: '#EF4444', shelfRow: 2, facingIndex: 4 },
      { id: 'det-b10', sku: 'sprite', label: 'Sprite 0.5L', confidence: 0.91, box: { x: 76, y: 52, width: 14, height: 32 }, color: '#008B47', shelfRow: 2, facingIndex: 5 },
    ],
    metadata: {
      scenario: 'scenario_b_gap',
      telegram_user_id: 887766554,
      telegram_username: 'anar_araz',
      message_id: 304,
      captured_at: '2026-09-12T15:15:00Z',
      gps: { latitude: 40.400215, longitude: 49.852441 },
    },
    submitted_at: '2026-09-12T15:17:00Z',
    reviewed_at: null,
    submitter_name: 'Anar Qasımov (Store Staff)',
  },
  {
    // SCENARIO C: Non-compliant / Missing Sprite (55% Score, Drawer Pre-filled)
    id: 'sub-003',
    task_id: '11111111-1111-1111-1111-111111111113',
    store_id: '22222222-2222-2222-2222-222222222224',
    photo_url:
      'https://images.unsplash.com/photo-1527864550417-7fd91fc51a46?auto=format&fit=crop&w=1200&q=80',
    status: 'pending_review',
    reviewer_feedback:
      'Tələb olunan Sprite 0.5L məhsulları rəfdə tamamilə yoxdur (0/2 facing). Zəhmət olmasa Sprite məhsullarını soyuducunun sağ tərəfinə əlavə edib təkrar audit göndərin.',
    ai_score: 55,
    ai_summary:
      '❌ Planogram Uyğunluğu: 55% (Kritik uyğunsuzluq). Sprite 0.5L çatışmır: 0/2 facing (çatışmayan: 2 ədəd). Rəfdə 2 ədəd boşluq aşkarlandı (-30% cərimə). Supervayzer imtinası tövsiyə edilir.',
    ai_detections: [
      { id: 'det-c1', sku: 'coca_cola_classic', label: 'Coca-Cola Classic 0.5L', confidence: 0.95, box: { x: 8, y: 16, width: 14, height: 32 }, color: '#F40009', shelfRow: 1, facingIndex: 1 },
      { id: 'det-c2', sku: 'coca_cola_classic', label: 'Coca-Cola Classic 0.5L', confidence: 0.94, box: { x: 25, y: 16, width: 14, height: 32 }, color: '#F40009', shelfRow: 1, facingIndex: 2 },
      { id: 'det-c3', sku: 'coca_cola_classic', label: 'Coca-Cola Classic 0.5L', confidence: 0.96, box: { x: 42, y: 16, width: 14, height: 32 }, color: '#F40009', shelfRow: 1, facingIndex: 3 },
      { id: 'det-c4', sku: 'coca_cola_zero', label: 'Coca-Cola Zero Sugar 0.5L', confidence: 0.92, box: { x: 60, y: 16, width: 14, height: 32 }, color: '#111827', shelfRow: 1, facingIndex: 4 },
      { id: 'det-c5', sku: 'coca_cola_zero', label: 'Coca-Cola Zero Sugar 0.5L', confidence: 0.90, box: { x: 77, y: 16, width: 14, height: 32 }, color: '#111827', shelfRow: 1, facingIndex: 5 },
      { id: 'det-c6', sku: 'fanta', label: 'Fanta Orange 0.5L', confidence: 0.94, box: { x: 8, y: 52, width: 15, height: 32 }, color: '#FF7300', shelfRow: 2, facingIndex: 1 },
      { id: 'det-c7', sku: 'fanta', label: 'Fanta Orange 0.5L', confidence: 0.92, box: { x: 26, y: 52, width: 15, height: 32 }, color: '#FF7300', shelfRow: 2, facingIndex: 2 },
      { id: 'det-c8', sku: 'out_of_stock_gap', label: 'Boşluq (Out of Stock)', confidence: 0.89, box: { x: 44, y: 52, width: 18, height: 32 }, color: '#EF4444', shelfRow: 2, facingIndex: 3 },
      { id: 'det-c9', sku: 'out_of_stock_gap', label: 'Boşluq (Out of Stock)', confidence: 0.86, box: { x: 65, y: 52, width: 18, height: 32 }, color: '#EF4444', shelfRow: 2, facingIndex: 4 },
    ],
    metadata: {
      scenario: 'scenario_c_missing_sprite',
      telegram_user_id: 665544332,
      telegram_username: 'nicat_rahat',
      message_id: 290,
      captured_at: '2026-09-12T15:00:00Z',
      gps: { latitude: 40.370845, longitude: 49.849921 },
    },
    submitted_at: '2026-09-12T15:02:00Z',
    reviewed_at: null,
    submitter_name: 'Nicat Kərimov (Merchandiser)',
  },
  {
    // HISTORICAL AUDIT: Previously Rejected
    id: 'sub-004',
    task_id: '11111111-1111-1111-1111-111111111113',
    store_id: '22222222-2222-2222-2222-222222222223',
    photo_url:
      'https://images.unsplash.com/photo-1622483767028-3f66f32aef97?auto=format&fit=crop&w=800&q=80',
    status: 'rejected',
    reviewer_feedback:
      'Fanta 1.5L məhsulunun alt rəfində 2 facing çatışmır və etiketlər yan çevrilib. Düzəliş edib yenidən göndərin.',
    ai_score: 52,
    ai_summary:
      '❌ Planogram Uyğunluğu: 52%. Fanta 0.5L çatışmır: 1/2 facing. Rəfdə 2 ədəd boşluq (out of stock) aşkarlandı (-30% cərimə).',
    ai_detections: [
      { id: 'det-26', sku: 'coca_cola_classic', label: 'Coca-Cola Classic 0.5L', confidence: 0.95, box: { x: 8, y: 18, width: 15, height: 30 }, color: '#F40009', shelfRow: 1, facingIndex: 1 },
      { id: 'det-27', sku: 'coca_cola_classic', label: 'Coca-Cola Classic 0.5L', confidence: 0.92, box: { x: 25, y: 18, width: 15, height: 30 }, color: '#F40009', shelfRow: 1, facingIndex: 2 },
      { id: 'det-28', sku: 'coca_cola_zero', label: 'Coca-Cola Zero Sugar 0.5L', confidence: 0.91, box: { x: 43, y: 18, width: 15, height: 30 }, color: '#111827', shelfRow: 1, facingIndex: 3 },
      { id: 'det-29', sku: 'out_of_stock_gap', label: 'Boşluq (Out of Stock)', confidence: 0.87, box: { x: 62, y: 18, width: 15, height: 30 }, color: '#EF4444', shelfRow: 1, facingIndex: 4 },
      { id: 'det-30', sku: 'fanta', label: 'Fanta Orange 0.5L', confidence: 0.89, box: { x: 12, y: 54, width: 16, height: 30 }, color: '#FF7300', shelfRow: 2, facingIndex: 1 },
      { id: 'det-31', sku: 'sprite', label: 'Sprite 0.5L', confidence: 0.91, box: { x: 35, y: 54, width: 16, height: 30 }, color: '#008B47', shelfRow: 2, facingIndex: 2 },
      { id: 'det-32', sku: 'out_of_stock_gap', label: 'Boşluq (Out of Stock)', confidence: 0.85, box: { x: 75, y: 54, width: 16, height: 30 }, color: '#EF4444', shelfRow: 2, facingIndex: 3 },
    ],
    metadata: {
      telegram_user_id: 665544332,
      telegram_username: 'nicat_bazarstore',
      message_id: 250,
      captured_at: '2026-09-11T11:00:00Z',
    },
    submitted_at: '2026-09-11T11:05:00Z',
    reviewed_at: '2026-09-11T12:30:00Z',
    submitter_name: 'Nicat Kərimov (Store Staff)',
  },
];

class PortalDataService {
  private client: SupabaseClient | null = null;
  private stores: Store[] = [...INITIAL_STORES];
  private tasks: Task[] = [...INITIAL_TASKS];
  private submissions: Submission[] = [...INITIAL_SUBMISSIONS];

  constructor() {
    if (!isMockClient) {
      try {
        this.client = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
      } catch (e) {
        console.warn('Falling back to internal state:', e);
      }
    }
  }

  async getMetrics(): Promise<DashboardMetrics> {
    const totalStores = this.stores.filter((s) => s.is_active).length;
    const activeTasks = this.tasks.filter((t) => t.status === 'published').length;
    const pendingReviews = this.submissions.filter((s) => s.status === 'pending_review').length;
    const reviewedCount = this.submissions.filter((s) => s.status !== 'pending_review').length;
    const approvedCount = this.submissions.filter((s) => s.status === 'approved').length;

    const complianceRate =
      reviewedCount > 0 ? Math.round((approvedCount / reviewedCount) * 100) : 100;

    return {
      totalStores,
      activeTasks,
      pendingReviews,
      complianceRate,
    };
  }

  async getStores(): Promise<Store[]> {
    return [...this.stores];
  }

  async getTasks(): Promise<Task[]> {
    return [...this.tasks];
  }

  async createTask(data: {
    title: string;
    description: string;
    reference_image_url: string;
    priority: Task['priority'];
    deadline: string;
    assigned_stores: string[];
  }): Promise<Task> {
    const newTask: Task = {
      id: `task-${Date.now()}`,
      title: data.title,
      description: data.description,
      reference_image_url: data.reference_image_url,
      priority: data.priority,
      status: 'published',
      deadline: data.deadline,
      created_at: new Date().toISOString(),
      assigned_stores: data.assigned_stores,
    };

    this.tasks.unshift(newTask);
    return newTask;
  }

  async bulkDispatchTasks(data: {
    templateId?: string;
    title: string;
    description: string;
    reference_image_url: string;
    priority: Task['priority'];
    deadline: string;
    chainName?: string;
    storeFormat?: string;
    regionId?: string;
  }): Promise<{ success: boolean; count: number; matchedStores: Store[]; tasks: Task[] }> {
    let matched = this.stores.filter((s) => s.is_active);
    if (data.chainName && data.chainName !== 'all') {
      matched = matched.filter(
        (s) => s.chain_name?.toLowerCase() === data.chainName?.toLowerCase()
      );
    }
    if (data.storeFormat && data.storeFormat !== 'all') {
      matched = matched.filter(
        (s) => s.store_format?.toLowerCase() === data.storeFormat?.toLowerCase()
      );
    }
    if (data.regionId && data.regionId !== 'all') {
      matched = matched.filter((s) => s.region_id === data.regionId);
    }

    const storeIds = matched.map((s) => s.id);
    const newTask: Task = {
      id: `task-bulk-${Date.now()}`,
      title: data.title,
      description: data.description,
      reference_image_url: data.reference_image_url,
      priority: data.priority,
      status: 'published',
      deadline: data.deadline,
      created_at: new Date().toISOString(),
      assigned_stores: storeIds,
      requires_before_after_photo: true,
    };

    this.tasks.unshift(newTask);

    return {
      success: true,
      count: matched.length,
      matchedStores: matched,
      tasks: [newTask],
    };
  }

  async getSubmissions(statusFilter?: SubmissionStatus | 'all'): Promise<Submission[]> {
    let list = this.submissions.map((sub) => {
      const task = this.tasks.find((t) => t.id === sub.task_id);
      const store = this.stores.find((s) => s.id === sub.store_id);
      return {
        ...sub,
        task,
        store,
      };
    });

    if (statusFilter && statusFilter !== 'all') {
      list = list.filter((s) => s.status === statusFilter);
    }

    return list.sort(
      (a, b) => new Date(b.submitted_at).getTime() - new Date(a.submitted_at).getTime()
    );
  }

  async updateSubmissionStatus(
    id: string,
    status: SubmissionStatus,
    reviewer_feedback?: string
  ): Promise<Submission | null> {
    const sub = this.submissions.find((s) => s.id === id);
    if (!sub) return null;

    sub.status = status;
    sub.reviewer_feedback = reviewer_feedback || null;
    sub.reviewed_at = new Date().toISOString();

    return { ...sub };
  }

  async oneClickAIApprove(id: string): Promise<Submission | null> {
    const sub = this.submissions.find((s) => s.id === id);
    if (!sub) return null;

    const feedback = `⚡ AI Avtomatik Təsdiqi (Uyğunluq Balı: ${sub.ai_score ?? 100}%). Rəf planogram qaydalarına tam cavab verir.`;
    return this.updateSubmissionStatus(id, 'approved', feedback);
  }

  async uploadPlanogramImage(file: File): Promise<string> {
    // In real mode, would upload to Supabase Storage: storage.from('shelf-images').upload(...)
    // For fast reliable client-side execution, convert file to Object URL or Data URL
    return new Promise((resolve) => {
      const reader = new FileReader();
      reader.onloadend = () => {
        resolve(reader.result as string);
      };
      reader.readAsDataURL(file);
    });
  }
}

export const portalService = new PortalDataService();
