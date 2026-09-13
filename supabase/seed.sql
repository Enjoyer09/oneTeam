-- ============================================================================
-- oneTeam: Shelf Monitoring Platform (Retail FMCG - Coca-Cola Distribution)
-- Seed Data Script
-- File: supabase/seed.sql
-- ============================================================================

DO $$
DECLARE
    v_admin_id UUID := '00000000-0000-0000-0000-000000000001'::uuid;
    v_task_id UUID := '11111111-1111-1111-1111-111111111111'::uuid;
    v_store_1_id UUID := '22222222-2222-2222-2222-222222222221'::uuid;
    v_store_2_id UUID := '22222222-2222-2222-2222-222222222222'::uuid;
BEGIN
    -- ------------------------------------------------------------------------
    -- 1. SEED SYSTEM SUPERVISOR (For created_by references)
    -- ------------------------------------------------------------------------
    IF NOT EXISTS (SELECT 1 FROM auth.users WHERE id = v_admin_id) THEN
        INSERT INTO auth.users (id, email, raw_user_meta_data)
        VALUES (
            v_admin_id,
            'supervisor@oneteam.az',
            '{"full_name": "Supervisor Admin", "role": "supervisor"}'::jsonb
        )
        ON CONFLICT (id) DO NOTHING;
    END IF;

    INSERT INTO public.profiles (id, full_name, role, phone_number)
    VALUES (
        v_admin_id,
        'Supervisor Admin',
        'supervisor',
        '+994501234567'
    )
    ON CONFLICT (id) DO UPDATE SET
        full_name = EXCLUDED.full_name,
        role = EXCLUDED.role,
        phone_number = EXCLUDED.phone_number;

    -- ------------------------------------------------------------------------
    -- 2. SEED STORES (2 Sample FMCG Retail Locations in Baku)
    -- ------------------------------------------------------------------------
    -- Store 1: Bravo 28 Mall
    INSERT INTO public.stores (id, store_code, name, address, city, latitude, longitude, is_active)
    VALUES (
        v_store_1_id,
        'BRAVO_28MAY_01',
        'Bravo Supermarket - 28 Mall',
        '28 May Street, Nasimi district, Baku',
        'Baku',
        40.37989300,
        49.84751200,
        TRUE
    )
    ON CONFLICT (store_code) DO UPDATE SET
        name = EXCLUDED.name,
        address = EXCLUDED.address,
        latitude = EXCLUDED.latitude,
        longitude = EXCLUDED.longitude,
        is_active = EXCLUDED.is_active;

    -- Store 2: Araz Superstore Ganjlik
    INSERT INTO public.stores (id, store_code, name, address, city, latitude, longitude, is_active)
    VALUES (
        v_store_2_id,
        'ARAZ_GENJLIK_02',
        'Araz Superstore - Ganjlik',
        'Fatali Khan Khoyski Ave 14, Narimanov, Baku',
        'Baku',
        40.40021500,
        49.85244100,
        TRUE
    )
    ON CONFLICT (store_code) DO UPDATE SET
        name = EXCLUDED.name,
        address = EXCLUDED.address,
        latitude = EXCLUDED.latitude,
        longitude = EXCLUDED.longitude,
        is_active = EXCLUDED.is_active;

    -- Retrieve actual store IDs in case store_code already existed with different IDs
    SELECT id INTO v_store_1_id FROM public.stores WHERE store_code = 'BRAVO_28MAY_01';
    SELECT id INTO v_store_2_id FROM public.stores WHERE store_code = 'ARAZ_GENJLIK_02';

    -- ------------------------------------------------------------------------
    -- 3. SEED AUDIT TASK (Coca-Cola 0.5L Cooler Placement Check)
    -- ------------------------------------------------------------------------
    INSERT INTO public.tasks (
        id,
        title,
        description,
        reference_image_url,
        priority,
        status,
        deadline,
        created_by
    )
    VALUES (
        v_task_id,
        'Coca-Cola 0.5L Cooler Placement Check',
        E'Planogram Audit Instructions:\n' ||
        E'1. Verify Coca-Cola Classic, Coca-Cola Zero Sugar, Sprite, and Fanta 0.5L PET bottles are placed inside the branded front cooler.\n' ||
        E'2. Maintain eye-level positioning with all brand labels facing outward (front-facing) toward store shoppers.\n' ||
        E'3. Ensure minimum of 3 facings per SKU with zero out-of-stock gaps.\n' ||
        E'4. Confirm cooler temperature display is at or below 4°C.\n' ||
        E'5. Verify promotional price tags (AZN) are present, clean, and positioned under each SKU.\n' ||
        E'6. Take a clear, well-lit photo of the entire cooler unit.',
        'https://raw.githubusercontent.com/supabase/supabase/master/apps/docs/public/img/supabase-logo.png',
        'high',
        'published',
        NOW() + INTERVAL '7 days',
        v_admin_id
    )
    ON CONFLICT (id) DO UPDATE SET
        title = EXCLUDED.title,
        description = EXCLUDED.description,
        priority = EXCLUDED.priority,
        status = EXCLUDED.status,
        deadline = EXCLUDED.deadline;

    -- ------------------------------------------------------------------------
    -- 4. SEED TASK ASSIGNMENTS (Assign task to both stores)
    -- ------------------------------------------------------------------------
    INSERT INTO public.task_assignments (task_id, store_id)
    VALUES 
        (v_task_id, v_store_1_id),
        (v_task_id, v_store_2_id)
    ON CONFLICT (task_id, store_id) DO NOTHING;

    RAISE NOTICE 'oneTeam seed data successfully loaded: 2 stores, 1 task, 2 assignments.';
END $$;
