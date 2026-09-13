import { createClient, SupabaseClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import { Database, SubmissionStatus, TaskPriority, TaskStatus, UserRole } from '../../types/database.types';
import { StoreRecord, TaskRecord, SubmissionRecord } from '../bot/types';
import { aiVisionService } from './aiVision';

dotenv.config();

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://mock-oneteam.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || 'mock-key';

export const isMockMode = SUPABASE_URL.includes('mock-oneteam') || SUPABASE_URL.includes('mock');

/**
 * In-Memory Mock Store for Offline / Automated Testing Mode
 */
interface MockStoreDb {
  stores: StoreRecord[];
  tasks: TaskRecord[];
  taskAssignments: { task_id: string; store_id: string }[];
  profiles: {
    id: string;
    full_name: string;
    role: UserRole;
    telegram_chat_id: number | null;
    phone_number?: string | null;
  }[];
  submissions: (SubmissionRecord & {
    submitted_by?: string;
    metadata: Record<string, unknown>;
  })[];
  storageObjects: {
    bucket: string;
    name: string;
    data: Buffer;
    contentType: string;
  }[];
}

const mockDb: MockStoreDb = {
  stores: [
    {
      id: '22222222-2222-2222-2222-222222222221',
      store_code: 'BRAVO_28MAY_01',
      name: 'Bravo Supermarket - 28 Mall',
      address: '28 May Street, Nasimi district, Baku',
      city: 'Baku',
      is_active: true,
    },
    {
      id: '22222222-2222-2222-2222-222222222222',
      store_code: 'ARAZ_GENJLIK_02',
      name: 'Araz Superstore - Ganjlik',
      address: 'Fatali Khan Khoyski Ave 14, Narimanov, Baku',
      city: 'Baku',
      is_active: true,
    },
  ],
  tasks: [
    {
      id: '11111111-1111-1111-1111-111111111111',
      title: 'Coca-Cola 0.5L Cooler Placement Check',
      description:
        'Planogram Audit Instructions:\n' +
        '1. Verify Coca-Cola Classic, Zero Sugar, Sprite, and Fanta 0.5L PET are placed in the dedicated front cooler.\n' ||
        '2. Eye-level positioning with all brand labels facing outward.\n' +
        '3. Minimum 3 facings per SKU with zero out-of-stock gaps.\n' +
        '4. Confirm cooler temperature is <= 4°C.\n' +
        '5. Verify promotional price tags (AZN) are present.',
      reference_image_url:
        'https://raw.githubusercontent.com/supabase/supabase/master/apps/docs/public/img/supabase-logo.png',
      priority: 'high',
      status: 'published',
      deadline: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
    },
  ],
  taskAssignments: [
    {
      task_id: '11111111-1111-1111-1111-111111111111',
      store_id: '22222222-2222-2222-2222-222222222221',
    },
    {
      task_id: '11111111-1111-1111-1111-111111111111',
      store_id: '22222222-2222-2222-2222-222222222222',
    },
  ],
  profiles: [],
  submissions: [],
  storageObjects: [],
};

class SupabaseService {
  private client: SupabaseClient<Database> | null = null;

  constructor() {
    if (!isMockMode) {
      this.client = createClient<Database>(SUPABASE_URL, SUPABASE_KEY);
    }
  }

  /**
   * Validate store code and return store record
   */
  async validateAndGetStore(storeCode: string): Promise<StoreRecord | null> {
    const normalizedCode = storeCode.trim().toUpperCase();

    if (isMockMode || !this.client) {
      const store = mockDb.stores.find(
        (s) => s.store_code.toUpperCase() === normalizedCode && s.is_active
      );
      return store || null;
    }

    const { data, error } = await this.client
      .from('stores')
      .select('id, store_code, name, address, city, is_active')
      .eq('store_code', normalizedCode)
      .eq('is_active', true)
      .single();

    if (error || !data) return null;
    return data as StoreRecord;
  }

  /**
   * Bind Telegram Chat ID to Profile
   */
  async bindTelegramUser(params: {
    telegramChatId: number;
    fullName: string;
    username?: string;
  }): Promise<{ id: string; role: UserRole }> {
    const { telegramChatId, fullName } = params;

    if (isMockMode || !this.client) {
      let profile = mockDb.profiles.find(
        (p) => p.telegram_chat_id === telegramChatId
      );
      if (profile) {
        profile.full_name = fullName;
      } else {
        profile = {
          id: `profile-${Date.now()}`,
          full_name: fullName,
          role: 'merchandiser',
          telegram_chat_id: telegramChatId,
        };
        mockDb.profiles.push(profile);
      }
      return { id: profile.id, role: profile.role };
    }

    // Try finding existing profile by telegram_chat_id
    const { data: existing } = await (this.client as any)
      .from('profiles')
      .select('id, role')
      .eq('telegram_chat_id', telegramChatId)
      .maybeSingle();

    if (existing) {
      await (this.client as any)
        .from('profiles')
        .update({ full_name: fullName })
        .eq('id', existing.id);
      return { id: existing.id, role: existing.role };
    }

    // For real Supabase, a profile ID must reference auth.users.
    // If not found, use a deterministic or service role upsert
    const fallbackId = '00000000-0000-0000-0000-' + telegramChatId.toString().padStart(12, '0');
    
    // Ensure mock auth user exists if running locally
    await (this.client as any).from('profiles').upsert({
      id: fallbackId,
      full_name: fullName,
      role: 'merchandiser',
      telegram_chat_id: telegramChatId,
    });

    return { id: fallbackId, role: 'merchandiser' };
  }

  /**
   * Get active/published tasks assigned to a specific store
   */
  async getTasksForStore(storeId: string): Promise<TaskRecord[]> {
    if (isMockMode || !this.client) {
      const assignedTaskIds = mockDb.taskAssignments
        .filter((a) => a.store_id === storeId)
        .map((a) => a.task_id);

      return mockDb.tasks.filter(
        (t) => assignedTaskIds.includes(t.id) && t.status === 'published'
      );
    }

    const { data, error } = await (this.client as any)
      .from('task_assignments')
      .select(`
        tasks:task_id (
          id,
          title,
          description,
          reference_image_url,
          priority,
          status,
          deadline
        )
      `)
      .eq('store_id', storeId);

    if (error || !data) return [];

    const tasks: TaskRecord[] = [];
    for (const item of data) {
      const task = item.tasks as unknown as TaskRecord;
      if (task && task.status === 'published') {
        tasks.push(task);
      }
    }
    return tasks;
  }

  /**
   * Fetch single task details by ID
   */
  async getTaskById(taskId: string): Promise<TaskRecord | null> {
    if (isMockMode || !this.client) {
      const task = mockDb.tasks.find((t) => t.id === taskId);
      return task || null;
    }

    const { data, error } = await (this.client as any)
      .from('tasks')
      .select('id, title, description, reference_image_url, priority, status, deadline')
      .eq('id', taskId)
      .single();

    if (error || !data) return null;
    return data as TaskRecord;
  }

  /**
   * Upload shelf photo to Supabase Storage bucket ('shelf-images')
   */
  async uploadShelfPhoto(params: {
    fileBuffer: Buffer;
    fileName: string;
    contentType?: string;
  }): Promise<string> {
    const { fileBuffer, fileName, contentType = 'image/jpeg' } = params;
    const bucketName = 'shelf-images';

    if (isMockMode || !this.client) {
      mockDb.storageObjects.push({
        bucket: bucketName,
        name: fileName,
        data: fileBuffer,
        contentType,
      });
      return `${SUPABASE_URL}/storage/v1/object/public/${bucketName}/${fileName}`;
    }

    const { error } = await this.client.storage
      .from(bucketName)
      .upload(fileName, fileBuffer, {
        contentType,
        upsert: true,
      });

    if (error) {
      throw new Error(`Storage upload failed: ${error.message}`);
    }

    const { data: publicUrlData } = this.client.storage
      .from(bucketName)
      .getPublicUrl(fileName);

    return publicUrlData.publicUrl;
  }

  /**
   * Record a new shelf photo audit submission
   */
  async createSubmission(params: {
    taskId: string;
    storeId: string;
    submittedBy?: string;
    photoUrl: string;
    metadata: Record<string, unknown>;
  }): Promise<SubmissionRecord> {
    const { taskId, storeId, submittedBy, photoUrl, metadata } = params;

    const task = isMockMode || !this.client ? mockDb.tasks.find((t) => t.id === taskId) : await this.getTaskById(taskId);
    const store = isMockMode || !this.client ? mockDb.stores.find((s) => s.id === storeId) : null;

    // Run automated AI Vision & Planogram Compliance Analysis
    const aiEvaluation = aiVisionService.analyzeShelfPhoto({
      photoUrl,
      taskTitle: task?.title,
      taskDescription: task?.description,
    });

    if (isMockMode || !this.client) {
      const submissionId = `sub-${Date.now()}`;

      const record: SubmissionRecord & {
        submitted_by?: string;
        metadata: Record<string, unknown>;
      } = {
        id: submissionId,
        task_id: taskId,
        store_id: storeId,
        submitted_by: submittedBy,
        photo_url: photoUrl,
        status: 'pending_review',
        reviewer_feedback: null,
        ai_score: aiEvaluation.complianceScore,
        ai_detections: aiEvaluation.detections,
        ai_summary: aiEvaluation.aiSummary,
        submitted_at: new Date().toISOString(),
        metadata: {
          ...metadata,
          ai_evaluation: aiEvaluation,
        },
        task: task ? { title: task.title } : undefined,
        store: store ? { name: store.name, store_code: store.store_code } : undefined,
      };

      mockDb.submissions.push(record);
      return record;
    }

    const { data, error } = await (this.client as any)
      .from('submissions')
      .insert({
        task_id: taskId,
        store_id: storeId,
        submitted_by: submittedBy || null,
        photo_url: photoUrl,
        status: 'pending_review',
        ai_score: aiEvaluation.complianceScore,
        ai_detections: aiEvaluation.detections,
        ai_summary: aiEvaluation.aiSummary,
        metadata: {
          ...metadata,
          ai_evaluation: aiEvaluation,
        } as any,
      })
      .select('id, task_id, store_id, photo_url, status, reviewer_feedback, ai_score, ai_detections, ai_summary, submitted_at')
      .single();

    if (error || !data) {
      throw new Error(`Failed to create submission: ${error?.message}`);
    }

    return data as SubmissionRecord;
  }

  /**
   * Retrieve recent submissions by user's telegram chat ID
   */
  async getSubmissionsByChatId(
    chatId: number,
    limit: number = 5
  ): Promise<SubmissionRecord[]> {
    if (isMockMode || !this.client) {
      return mockDb.submissions
        .filter((s) => s.metadata?.telegram_user_id === chatId)
        .slice(-limit)
        .reverse();
    }

    const { data: profile } = await (this.client as any)
      .from('profiles')
      .select('id')
      .eq('telegram_chat_id', chatId)
      .maybeSingle();

    if (!profile) return [];

    const { data, error } = await (this.client as any)
      .from('submissions')
      .select(`
        id,
        task_id,
        store_id,
        photo_url,
        status,
        reviewer_feedback,
        submitted_at,
        tasks:task_id (title),
        stores:store_id (name, store_code)
      `)
      .eq('submitted_by', profile.id)
      .order('submitted_at', { ascending: false })
      .limit(limit);

    if (error || !data) return [];

    return data.map((item: any) => ({
      id: item.id,
      task_id: item.task_id,
      store_id: item.store_id,
      photo_url: item.photo_url,
      status: item.status,
      reviewer_feedback: item.reviewer_feedback,
      submitted_at: item.submitted_at,
      task: item.tasks,
      store: item.stores,
    }));
  }

  /**
   * Helper to inspect mock database state (for testing)
   */
  getMockDbState() {
    return mockDb;
  }
}

export const supabaseService = new SupabaseService();
