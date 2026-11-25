-- ============================================================================
-- oneTeam — seed data for the API schema
-- File: db/api-seed.sql
-- Target: plain PostgreSQL 16
-- ============================================================================
--
-- Runs once, on first boot, after db/api-schema.sql. Every statement is
-- idempotent (ON CONFLICT DO NOTHING), so re-running it against a populated
-- database is harmless.
--
-- The rows mirror SEED_DATA in packages/database/src/seed.ts, id for id. That
-- is deliberate: if the two ever drift, the API would hydrate a database that
-- disagrees with the demo data its own fallback uses, and the difference would
-- only show up as a confusing "some tasks are missing" report.
--
-- The three demo store tasks are seeded here rather than created by the
-- application, so that a freshly provisioned database is immediately useful:
-- one PUBLISHED task to work, one DRAFT task that is not dispatched yet, and
-- one SUBMITTED task waiting for review. Their deadlines are relative to the
-- moment of seeding.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- Users
-- ----------------------------------------------------------------------------
INSERT INTO users (id, email, full_name, role, telegram_chat_id, phone) VALUES
    ('usr-admin-001',  'admin@retail.oneteam.az',        'Kamran Əhmədov (Head of Retail)',        'ADMIN',        NULL,        '+994501112233'),
    ('usr-super-002',  'supervisor@retail.oneteam.az',   'Leyla Qasımova (Baku North Supervisor)', 'SUPERVISOR',   NULL,        '+994502223344'),
    ('usr-merch-003',  'merchandiser@retail.oneteam.az', 'Eldar Məmmədov (Field Merchandiser)',    'MERCHANDISER', '998877665', '+994503334455')
ON CONFLICT (id) DO NOTHING;

-- ----------------------------------------------------------------------------
-- Region
-- ----------------------------------------------------------------------------
INSERT INTO regions (id, name, code) VALUES
    ('reg-baku-central', 'Bakı Şəhəri və Ətraf Ərazilər', 'AZ-BAK-01')
ON CONFLICT (id) DO NOTHING;

-- ----------------------------------------------------------------------------
-- Stores
-- ----------------------------------------------------------------------------
INSERT INTO stores
    (id, store_code, name, region_id, chain_name, store_format, address, city, latitude, longitude, is_active)
VALUES
    ('str-bravo-yasamal', 'BRAVO_YASAMAL_01', 'Bravo Hypermarket - Yasamal', 'reg-baku-central',
     'Bravo', 'hypermarket', 'Həsən bəy Zərdabi pr. 92, Yasamal, Bakı', 'Bakı',
     40.385012, 49.810541, TRUE),

    ('str-araz-ganjlik', 'ARAZ_GENJLIK_02', 'Araz Superstore - Gənclik Mall', 'reg-baku-central',
     'Araz', 'supermarket', 'Fətəli Xan Xoyski pr. 14, Nərimanov, Bakı', 'Bakı',
     40.400215, 49.852441, TRUE),

    ('str-bazarstore-portbaku', 'BAZAR_PORTBAKU_03', 'Bazarstore Gourmet - Port Baku', 'reg-baku-central',
     'Bazarstore', 'supermarket', 'Neftçilər pr. 151, Səbail, Bakı', 'Bakı',
     40.375112, 49.863145, TRUE)
ON CONFLICT (id) DO NOTHING;

-- ----------------------------------------------------------------------------
-- Campaign
-- ----------------------------------------------------------------------------
INSERT INTO campaigns (id, name, description, start_date, end_date, is_active) VALUES
    ('cmp-sept-zero-2026',
     'September Zero Visibility',
     'Q2/Q3 Zero Sugar Beverage və Orange Soda Zero məhsullarının supermarket vitrinlərində 100% ön sıra görünürlüyünün təmin edilməsi kampaniyası.',
     '2026-09-01T00:00:00Z',
     '2026-09-30T23:59:59Z',
     TRUE)
ON CONFLICT (id) DO NOTHING;

-- ----------------------------------------------------------------------------
-- Task templates
-- ----------------------------------------------------------------------------
-- Descriptions are dollar-quoted ($tpl$) so the embedded newlines survive
-- verbatim without E'' escape sequences.

INSERT INTO task_templates
    (id, campaign_id, title, description, reference_image_url, priority,
     requires_before_after_photo, checklist_schema, planogram_rules)
VALUES
    (
        'tmpl-cooler-check',
        'cmp-sept-zero-2026',
        'Cooler Check (0.5L Ön Vitrin Soyuducusu Auditi)',
        $tpl$Təlimat:
1. Classic Beverage, Zero Sugar, Lemon Soda və Orange Soda 0.5L məhsulları mütləq ön vitrin soyuducusunda yerləşdirilməlidir.
2. Bütün loqolar alıcıya doğru baxmalıdır.
3. Hər SKU üçün minimum 3 facing təmin edilməlidir.
4. Temperatur <= 4°C olmalıdır.$tpl$,
        'https://images.unsplash.com/photo-1622483767028-3f66f32aef97?auto=format&fit=crop&w=1200&q=80',
        'HIGH',
        TRUE,
        $chk$[
          {"id":"q-temp","question":"Soyuducu temperaturu normaya uyğundurmu? (<= 4°C)","type":"number","unit":"°C","required":true,"minValue":-5,"maxValue":15},
          {"id":"q-clean","question":"Soyuducu şüşəsi və rəflər təmizdirmi?","type":"boolean","required":true},
          {"id":"q-promo-posm","question":"Promo POSM materialı mövcuddurmu?","type":"single_choice","options":["Mövcuddur və yerləşdirilib","Çatışmır","Zədələnib"],"required":true}
        ]$chk$::jsonb,
        $plg$[
          {"sku":"classic_soda","label":"Classic Beverage 0.5L","minFacings":3,"shelfRow":1},
          {"sku":"zero_soda","label":"Zero Sugar Beverage 0.5L","minFacings":3,"shelfRow":1},
          {"sku":"orange_soda","label":"Orange Soda Orange 0.5L","minFacings":2,"shelfRow":2},
          {"sku":"lemon_soda","label":"Lemon Soda 0.5L","minFacings":2,"shelfRow":2}
        ]$plg$::jsonb
    ),
    (
        'tmpl-eye-level',
        'cmp-sept-zero-2026',
        'Eye-Level Placement (Göz Səviyyəsi Rəf Düzülüşü)',
        $tpl$Təlimat:
1. 1L və 1.5L PET şüşələrin alıcının göz səviyyəsində (2-ci və 3-cü rəf) fasiləsiz düzülüşü.
2. Boşluqlar dərhal depodan doldurulmalıdır.
3. Cari ayın sarı promo qiymət kağızları aydın görünməlidir.$tpl$,
        'https://images.unsplash.com/photo-1554866585-cd94860890b7?auto=format&fit=crop&w=1200&q=80',
        'MEDIUM',
        FALSE,
        $chk$[
          {"id":"q-eye-clean","question":"Rəflər tam təmizlənib və tozdan təmizdirmi?","type":"boolean","required":true}
        ]$chk$::jsonb,
        $plg$[
          {"sku":"zero_soda","label":"Zero Beverage 1L","minFacings":4,"shelfRow":2},
          {"sku":"classic_soda","label":"Classic Beverage 1.5L","minFacings":4,"shelfRow":3}
        ]$plg$::jsonb
    )
ON CONFLICT (id) DO NOTHING;

-- ----------------------------------------------------------------------------
-- Demo store tasks
-- ----------------------------------------------------------------------------
INSERT INTO store_tasks
    (id, template_id, store_id, assigned_user_id, status, deadline,
     published_at, delivered_at, acknowledged_at, submitted_at, created_at, updated_at)
VALUES
    -- Dispatched, waiting for the merchandiser to start.
    ('task-yasamal-cooler-01', 'tmpl-cooler-check', 'str-bravo-yasamal', 'usr-merch-003',
     'PUBLISHED', now() + interval '7 days',
     now(), NULL, NULL, NULL, now(), now()),

    -- Draft: not dispatched yet.
    ('task-ganjlik-eyelevel-02', 'tmpl-eye-level', 'str-araz-ganjlik', 'usr-merch-003',
     'DRAFT', now() + interval '5 days',
     NULL, NULL, NULL, NULL, now(), now()),

    -- Full happy path up to submission, waiting for review.
    ('task-portbaku-cooler-03', 'tmpl-cooler-check', 'str-bazarstore-portbaku', 'usr-merch-003',
     'SUBMITTED', now() + interval '4 days',
     now() - interval '1 hour',
     now() - interval '50 minutes',
     now() - interval '40 minutes',
     now() - interval '10 minutes',
     now() - interval '1 hour',
     now() - interval '10 minutes')
ON CONFLICT (id) DO NOTHING;

-- ----------------------------------------------------------------------------
-- Audit trail for the seeded tasks
-- ----------------------------------------------------------------------------
INSERT INTO audit_logs (id, entity_type, entity_id, action, from_state, to_state, actor_id, payload) VALUES
    ('audit-seed-0001', 'store_task', 'task-yasamal-cooler-01', 'TASK_BULK_DISPATCHED',
     'DRAFT', 'PUBLISHED', 'usr-super-002',
     '{"note":"Seeded demo task"}'::jsonb),

    ('audit-seed-0002', 'store_task', 'task-portbaku-cooler-03', 'TASK_BULK_DISPATCHED',
     'DRAFT', 'PUBLISHED', 'usr-super-002',
     '{"note":"Seeded demo task"}'::jsonb),

    ('audit-seed-0003', 'store_task', 'task-portbaku-cooler-03', 'TASK_SUBMITTED',
     'IN_PROGRESS', 'SUBMITTED', 'usr-merch-003',
     '{"note":"Seeded demo evidence submission"}'::jsonb)
ON CONFLICT (id) DO NOTHING;
