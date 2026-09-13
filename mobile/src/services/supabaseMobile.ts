import { MobileStore, MobileTask, MobileSubmission, AuditMetadata } from '../types';
import { aiVisionService } from '../../../src/services/aiVision';

const INITIAL_STORES: MobileStore[] = [
  {
    id: '22222222-2222-2222-2222-222222222221',
    store_code: 'BRAVO_28MAY_01',
    name: 'Bravo Supermarket - 28 Mall',
    address: '28 May küç., Nəsimi, Bakı',
    city: 'Bakı',
    latitude: 40.379893,
    longitude: 49.847512,
    is_active: true,
  },
  {
    id: '22222222-2222-2222-2222-222222222222',
    store_code: 'ARAZ_GENJLIK_02',
    name: 'Araz Superstore - Gənclik',
    address: 'Fətəli Xan Xoyski pr. 14, Bakı',
    city: 'Bakı',
    latitude: 40.400215,
    longitude: 49.852441,
    is_active: true,
  },
];

const INITIAL_TASKS: MobileTask[] = [
  {
    id: '11111111-1111-1111-1111-111111111111',
    title: 'Coca-Cola 0.5L Cooler Placement Check',
    description:
      'Planogram Təlimatı: 1. Coca-Cola Classic, Zero Sugar, Sprite, Fanta 0.5L PET şüşələri ön vitrin soyuducusunda yerləşdirilməlidir.\n2. Bütün brend loqoları alıcıya doğru baxmalıdır.\n3. Hər SKU üçün minimum 3 facing təmin edilməlidir.\n4. Soyuducu temperaturu <= 4°C olmalıdır.',
    reference_image_url:
      'https://images.unsplash.com/photo-1622483767028-3f66f32aef97?auto=format&fit=crop&w=800&q=80',
    priority: 'high',
    status: 'published',
    deadline: '2026-09-20T18:00:00Z',
    cooling_requirement: '≤ 4°C',
    facings_per_sku: 3,
  },
  {
    id: '11111111-1111-1111-1111-111111111112',
    title: 'Coca-Cola Zero Sugar Promo Stand Check',
    description:
      'Kassa zonası yaxınlığında Zero Sugar xüsusi qara stendinin tam dolu və təmiz olmasını yoxlayın.',
    reference_image_url:
      'https://images.unsplash.com/photo-1554866585-cd94860890b7?auto=format&fit=crop&w=800&q=80',
    priority: 'urgent',
    status: 'published',
    deadline: '2026-09-18T12:00:00Z',
    cooling_requirement: 'Otaq temp. / ≤ 18°C',
    facings_per_sku: 4,
  },
];

export class MobileSupabaseService {
  private stores: MobileStore[] = [...INITIAL_STORES];
  private tasks: MobileTask[] = [...INITIAL_TASKS];
  private submissions: MobileSubmission[] = [];

  async getStores(): Promise<MobileStore[]> {
    return [...this.stores];
  }

  async getStoreByCode(code: string): Promise<MobileStore | null> {
    const s = this.stores.find(
      (store) => store.store_code.toUpperCase() === code.trim().toUpperCase()
    );
    return s || null;
  }

  async getTasksForStore(storeId: string): Promise<MobileTask[]> {
    return [...this.tasks];
  }

  async uploadPhotoToStorage(fileUriOrBase64: string, storeId: string, taskId: string): Promise<string> {
    const timestamp = Date.now();
    const fileName = `audits/${storeId}/${taskId}_${timestamp}.jpg`;
    return `https://mock-oneteam.supabase.co/storage/v1/object/public/shelf-images/${fileName}`;
  }

  async submitAudit(params: {
    taskId: string;
    storeId: string;
    photoUrl: string;
    metadata: AuditMetadata;
  }): Promise<MobileSubmission> {
    const task = this.tasks.find((t) => t.id === params.taskId);

    // Automated AI Planogram evaluation
    const aiEvaluation = aiVisionService.analyzeShelfPhoto({
      photoUrl: params.photoUrl,
      taskTitle: task?.title,
      taskDescription: task?.description,
    });

    const newSubmission: MobileSubmission = {
      id: `sub-mob-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`,
      task_id: params.taskId,
      store_id: params.storeId,
      photo_url: params.photoUrl,
      status: 'pending_review',
      reviewer_feedback: null,
      ai_score: aiEvaluation.complianceScore,
      ai_detections: aiEvaluation.detections,
      ai_summary: aiEvaluation.aiSummary,
      submitted_at: new Date().toISOString(),
      metadata: params.metadata,
      is_offline_synced: false,
    };

    this.submissions.unshift(newSubmission);
    return newSubmission;
  }

  async getSubmissionsForStore(storeId: string): Promise<MobileSubmission[]> {
    return this.submissions.filter((s) => s.store_id === storeId);
  }

  getAllSubmissions(): MobileSubmission[] {
    return [...this.submissions];
  }
}

export const mobileSupabase = new MobileSupabaseService();
