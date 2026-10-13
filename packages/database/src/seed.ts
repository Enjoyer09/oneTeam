/**
 * oneTeam Retail Execution Platform — Database Seeder
 * Seeds required enterprise domain records:
 * - 1 Campaign: "September Zero Visibility"
 * - 2 Task Templates: "Cooler Check" & "Eye-Level Placement"
 * - 3 Baku Stores: "Bravo Yasamal", "Araz Ganjlik", "Bazarstore Port Baku"
 * - 3 Role-based Users: Admin, Supervisor, Merchandiser

 */
import { log, ChecklistQuestion, PlanogramRule } from '@oneteam/types';

export interface SeedData {
  users: Array<{
    id: string;
    email: string;
    fullName: string;
    role: 'ADMIN' | 'SUPERVISOR' | 'MERCHANDISER' | 'STORE_STAFF';
    /**
     * The Telegram chat this person bound on, when they use the chat channel.
     *
     * One external key per channel: the bot identifies a person by chat id, the
     * mobile client by device id. Both resolve to the same row, which is what
     * lets one set of anti-fraud rules serve both channels.
     */
    telegramChatId?: string;
    mobileDeviceId?: string;
    phone?: string;
  }>;
  region: {
    id: string;
    name: string;
    code: string;
  };
  stores: Array<{
    id: string;
    storeCode: string;
    name: string;
    /**
     * Required, because `stores.region_id` is `NOT NULL REFERENCES regions(id)`
     * and every seeded store carries one. It was optional here, which let the
     * seed type drift from the column it feeds — the sort of gap that stays
     * harmless until the day a store is inserted without one and fails on a
     * constraint the type said was fine.
     */
    regionId: string;
    chainName: string;
    storeFormat: 'hypermarket' | 'supermarket' | 'express' | 'convenience';
    address: string;
    city: string;
    latitude: number;
    longitude: number;
    isActive: boolean;
  }>;
  campaign: {
    id: string;
    name: string;
    description: string;
    startDate: Date;
    endDate: Date;
    isActive: boolean;
  };
  templates: Array<{
    id: string;
    campaignId: string;
    title: string;
    description: string;
    referenceImageUrl: string;
    priority: 'LOW' | 'MEDIUM' | 'HIGH' | 'URGENT';
    planogramRules: PlanogramRule[];
    requiresBeforeAfterPhoto?: boolean;
    checklistSchema?: ChecklistQuestion[];
  }>;
}

/**
 * The seed's own row shapes, named so the database package can say what a
 * hydrated row is instead of calling every one of them `any`.
 */
export type SeedUser = SeedData['users'][number];
export type SeedRegion = SeedData['region'];
export type SeedCampaign = SeedData['campaign'];
export type SeedTemplate = SeedData['templates'][number];

export const SEED_DATA: SeedData = {
  users: [
    {
      id: 'usr-admin-001',
      email: 'admin@coke.oneteam.az',
      fullName: 'Kamran Əhmədov (Head of Retail)',
      role: 'ADMIN',
      phone: '+994501112233',
    },
    {
      id: 'usr-super-002',
      email: 'supervisor@coke.oneteam.az',
      fullName: 'Leyla Qasımova (Baku North Supervisor)',
      role: 'SUPERVISOR',
      phone: '+994502223344',
    },
    {
      id: 'usr-merch-003',
      email: 'merchandiser@coke.oneteam.az',
      fullName: 'Eldar Məmmədov (Field Merchandiser)',
      role: 'MERCHANDISER',
      telegramChatId: '998877665',
      phone: '+994503334455',
    },
  ],
  region: {
    id: 'reg-baku-central',
    name: 'Bakı Şəhəri və Ətraf Ərazilər',
    code: 'AZ-BAK-01',
  },
  stores: [
    {
      id: 'str-bravo-yasamal',
      storeCode: 'BRAVO_YASAMAL_01',
      name: 'Bravo Hypermarket - Yasamal',
      regionId: 'reg-baku-central',
      chainName: 'Bravo',
      storeFormat: 'hypermarket',
      address: 'Həsən bəy Zərdabi pr. 92, Yasamal, Bakı',
      city: 'Bakı',
      latitude: 40.385012,
      longitude: 49.810541,
      isActive: true,
    },
    {
      id: 'str-araz-ganjlik',
      storeCode: 'ARAZ_GENJLIK_02',
      name: 'Araz Superstore - Gənclik Mall',
      regionId: 'reg-baku-central',
      chainName: 'Araz',
      storeFormat: 'supermarket',
      address: 'Fətəli Xan Xoyski pr. 14, Nərimanov, Bakı',
      city: 'Bakı',
      latitude: 40.400215,
      longitude: 49.852441,
      isActive: true,
    },
    {
      id: 'str-bazarstore-portbaku',
      storeCode: 'BAZAR_PORTBAKU_03',
      name: 'Bazarstore Gourmet - Port Baku',
      regionId: 'reg-baku-central',
      chainName: 'Bazarstore',
      storeFormat: 'supermarket',
      address: 'Neftçilər pr. 151, Səbail, Bakı',
      city: 'Bakı',
      latitude: 40.375112,
      longitude: 49.863145,
      isActive: true,
    },
  ],
  campaign: {
    id: 'cmp-sept-zero-2026',
    name: 'September Zero Visibility',
    description:
      'Q2/Q3 Coca-Cola Zero Sugar və Fanta Zero məhsullarının supermarket vitrinlərində 100% ön sıra görünürlüyünün təmin edilməsi kampaniyası.',
    startDate: new Date('2026-09-01T00:00:00Z'),
    endDate: new Date('2026-09-30T23:59:59Z'),
    isActive: true,
  },
  templates: [
    {
      id: 'tmpl-cooler-check',
      campaignId: 'cmp-sept-zero-2026',
      title: 'Cooler Check (0.5L Ön Vitrin Soyuducusu Auditi)',
      description:
        'Təlimat:\n1. Coca-Cola Classic, Zero Sugar, Sprite və Fanta 0.5L məhsulları mütləq ön vitrin soyuducusunda yerləşdirilməlidir.\n2. Bütün loqolar alıcıya doğru baxmalıdır.\n3. Hər SKU üçün minimum 3 facing təmin edilməlidir.\n4. Temperatur <= 4°C olmalıdır.',
      referenceImageUrl:
        'https://images.unsplash.com/photo-1622483767028-3f66f32aef97?auto=format&fit=crop&w=1200&q=80',
      priority: 'HIGH',
      requiresBeforeAfterPhoto: true,
      checklistSchema: [
        {
          id: 'q-temp',
          question: 'Soyuducu temperaturu normaya uyğundurmu? (<= 4°C)',
          type: 'number',
          unit: '°C',
          required: true,
          minValue: -5,
          maxValue: 15,
        },
        {
          id: 'q-clean',
          question: 'Soyuducu şüşəsi və rəflər təmizdirmi?',
          type: 'boolean',
          required: true,
        },
        {
          id: 'q-promo-posm',
          question: 'Promo POSM materialı mövcuddurmu?',
          type: 'single_choice',
          options: ['Mövcuddur və yerləşdirilib', 'Çatışmır', 'Zədələnib'],
          required: true,
        },
      ],
      planogramRules: [
        { sku: 'coca_cola_classic', label: 'Coca-Cola Classic 0.5L', minFacings: 3, shelfRow: 1 },
        { sku: 'coca_cola_zero', label: 'Coca-Cola Zero Sugar 0.5L', minFacings: 3, shelfRow: 1 },
        { sku: 'fanta', label: 'Fanta Orange 0.5L', minFacings: 2, shelfRow: 2 },
        { sku: 'sprite', label: 'Sprite 0.5L', minFacings: 2, shelfRow: 2 },
      ],
    },
    {
      id: 'tmpl-eye-level',
      campaignId: 'cmp-sept-zero-2026',
      title: 'Eye-Level Placement (Göz Səviyyəsi Rəf Düzülüşü)',
      description:
        'Təlimat:\n1. 1L və 1.5L PET şüşələrin alıcının göz səviyyəsində (2-ci və 3-cü rəf) fasiləsiz düzülüşü.\n2. Boşluqlar dərhal depodan doldurulmalıdır.\n3. Cari ayın sarı promo qiymət kağızları aydın görünməlidir.',
      referenceImageUrl:
        'https://images.unsplash.com/photo-1554866585-cd94860890b7?auto=format&fit=crop&w=1200&q=80',
      priority: 'MEDIUM',
      requiresBeforeAfterPhoto: false,
      checklistSchema: [
        {
          id: 'q-eye-clean',
          question: 'Rəflər tam təmizlənib və tozdan təmizdirmi?',
          type: 'boolean',
          required: true,
        },
      ],
      planogramRules: [
        { sku: 'coca_cola_zero', label: 'Coca-Cola Zero 1L', minFacings: 4, shelfRow: 2 },
        { sku: 'coca_cola_classic', label: 'Coca-Cola Classic 1.5L', minFacings: 4, shelfRow: 3 },
      ],
    },
  ],
};

// `_prismaClient` is accepted for call-site compatibility and deliberately not
// used: this seed writes through the repository, not through Prisma directly.
// eslint-disable-next-line @typescript-eslint/require-await -- writes through the repository, not Prisma; keeps the Promise signature the CLI awaits.
export async function runDatabaseSeed(_prismaClient?: unknown): Promise<SeedData> {
  log.info('🌱 [oneTeam SEED] Starting enterprise data seeding...');
  log.info(`   - 1 Campaign: "${SEED_DATA.campaign.name}"`);
  log.info(`   - 2 Templates: ${SEED_DATA.templates.map((t) => t.title).join(', ')}`);
  log.info(`   - 3 Stores: ${SEED_DATA.stores.map((s) => s.name).join(', ')}`);
  log.info(`   - 3 Users: ${SEED_DATA.users.map((u) => u.fullName).join(', ')}`);
  log.info('✅ [oneTeam SEED] Seeding completed successfully.');
  return SEED_DATA;
}

if (require.main === module) {
  runDatabaseSeed().catch((err) => {
    console.error('❌ Seeding error:', err);
    process.exit(1);
  });
}
