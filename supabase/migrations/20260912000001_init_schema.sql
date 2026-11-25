-- ============================================================================
-- oneTeam: Shelf Monitoring Platform (Retail FMCG - oneTeam Retail Distribution)
-- Database Architecture & Initial Schema Migration
-- File: supabase/migrations/20260912000001_init_schema.sql
-- Compatible with: Supabase (PostgreSQL 15+)
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 0. EXTENSIONS & COMPATIBILITY
-- ----------------------------------------------------------------------------
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- For standalone testing environments outside Supabase, ensure auth schema exists
CREATE SCHEMA IF NOT EXISTS auth;
CREATE TABLE IF NOT EXISTS auth.users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email VARCHAR(255),
    raw_user_meta_data JSONB DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ----------------------------------------------------------------------------
-- 1. ENUM TYPES
-- ----------------------------------------------------------------------------
DO $$ 
BEGIN
    -- User Roles across the platform
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'user_role') THEN
        CREATE TYPE user_role AS ENUM (
            'admin',
            'supervisor',
            'store_staff',
            'merchandiser'
        );
    END IF;

    -- Task Priority levels
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'task_priority') THEN
        CREATE TYPE task_priority AS ENUM (
            'low',
            'medium',
            'high',
            'urgent'
        );
    END IF;

    -- Task Lifecycle statuses
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'task_status') THEN
        CREATE TYPE task_status AS ENUM (
            'draft',
            'published',
            'completed',
            'archived'
        );
    END IF;

    -- Shelf Audit Submission statuses
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'submission_status') THEN
        CREATE TYPE submission_status AS ENUM (
            'pending_review',
            'approved',
            'rejected'
        );
    END IF;
END $$;

-- ----------------------------------------------------------------------------
-- 2. HELPER FUNCTIONS & TRIGGERS
-- ----------------------------------------------------------------------------

-- Function to automatically refresh `updated_at` column
CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ----------------------------------------------------------------------------
-- 3. TABLE DEFINITIONS
-- ----------------------------------------------------------------------------

-- 3.1 TABLE: profiles (Extends Supabase auth.users)
CREATE TABLE IF NOT EXISTS public.profiles (
    id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
    full_name VARCHAR(255),
    role user_role NOT NULL DEFAULT 'merchandiser',
    telegram_chat_id BIGINT UNIQUE,
    phone_number VARCHAR(50),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Trigger for profiles.updated_at
DROP TRIGGER IF EXISTS trigger_profiles_updated_at ON public.profiles;
CREATE TRIGGER trigger_profiles_updated_at
    BEFORE UPDATE ON public.profiles
    FOR EACH ROW
    EXECUTE FUNCTION public.set_updated_at();

-- Trigger to automatically create profile when new auth.user signs up
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER AS $$
BEGIN
    INSERT INTO public.profiles (id, full_name, role)
    VALUES (
        NEW.id,
        COALESCE(NEW.raw_user_meta_data->>'full_name', NEW.email, 'New User'),
        COALESCE((NEW.raw_user_meta_data->>'role')::user_role, 'merchandiser')
    )
    ON CONFLICT (id) DO NOTHING;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
    AFTER INSERT ON auth.users
    FOR EACH ROW
    EXECUTE FUNCTION public.handle_new_user();

-- 3.2 TABLE: stores
CREATE TABLE IF NOT EXISTS public.stores (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    store_code VARCHAR(100) NOT NULL UNIQUE,
    name VARCHAR(255) NOT NULL,
    address TEXT,
    city VARCHAR(100) NOT NULL DEFAULT 'Baku',
    latitude DECIMAL(10, 8),
    longitude DECIMAL(11, 8),
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 3.3 TABLE: tasks (Instructions / Planograms sent from Portal to Stores)
CREATE TABLE IF NOT EXISTS public.tasks (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    title VARCHAR(255) NOT NULL,
    description TEXT NOT NULL,
    reference_image_url TEXT,
    priority task_priority NOT NULL DEFAULT 'medium',
    status task_status NOT NULL DEFAULT 'published',
    deadline TIMESTAMPTZ NOT NULL,
    created_by UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Trigger for tasks.updated_at
DROP TRIGGER IF EXISTS trigger_tasks_updated_at ON public.tasks;
CREATE TRIGGER trigger_tasks_updated_at
    BEFORE UPDATE ON public.tasks
    FOR EACH ROW
    EXECUTE FUNCTION public.set_updated_at();

-- 3.4 TABLE: task_assignments (Mapping tasks to specific stores)
CREATE TABLE IF NOT EXISTS public.task_assignments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    task_id UUID NOT NULL REFERENCES public.tasks(id) ON DELETE CASCADE,
    store_id UUID NOT NULL REFERENCES public.stores(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_task_store UNIQUE (task_id, store_id)
);

-- 3.5 TABLE: submissions (Shelf photos uploaded from Telegram / Mobile App)
CREATE TABLE IF NOT EXISTS public.submissions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    task_id UUID NOT NULL REFERENCES public.tasks(id) ON DELETE RESTRICT,
    store_id UUID NOT NULL REFERENCES public.stores(id) ON DELETE RESTRICT,
    submitted_by UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
    photo_url TEXT NOT NULL,
    status submission_status NOT NULL DEFAULT 'pending_review',
    reviewer_feedback TEXT,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    submitted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    reviewed_at TIMESTAMPTZ
);

-- ----------------------------------------------------------------------------
-- 4. PERFORMANCE INDEXES
-- ----------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_profiles_role ON public.profiles(role);
CREATE INDEX IF NOT EXISTS idx_profiles_telegram_chat_id ON public.profiles(telegram_chat_id) WHERE telegram_chat_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_stores_code ON public.stores(store_code);
CREATE INDEX IF NOT EXISTS idx_stores_city_active ON public.stores(city, is_active);

CREATE INDEX IF NOT EXISTS idx_tasks_status_deadline ON public.tasks(status, deadline);
CREATE INDEX IF NOT EXISTS idx_tasks_priority ON public.tasks(priority);

CREATE INDEX IF NOT EXISTS idx_task_assignments_task_id ON public.task_assignments(task_id);
CREATE INDEX IF NOT EXISTS idx_task_assignments_store_id ON public.task_assignments(store_id);

CREATE INDEX IF NOT EXISTS idx_submissions_task_store ON public.submissions(task_id, store_id);
CREATE INDEX IF NOT EXISTS idx_submissions_status ON public.submissions(status);
CREATE INDEX IF NOT EXISTS idx_submissions_submitted_by ON public.submissions(submitted_by);
CREATE INDEX IF NOT EXISTS idx_submissions_metadata ON public.submissions USING gin(metadata);

-- ----------------------------------------------------------------------------
-- 5. STORAGE BUCKET CONFIGURATION (`shelf-images`)
-- ----------------------------------------------------------------------------
DO $$
BEGIN
    -- Ensure storage schema exists (standard in Supabase)
    IF EXISTS (SELECT 1 FROM information_schema.schemata WHERE schema_name = 'storage') THEN
        INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
        VALUES (
            'shelf-images',
            'shelf-images',
            TRUE,
            10485760, -- 10MB limit per image
            ARRAY['image/jpeg', 'image/png', 'image/webp', 'image/heic']
        )
        ON CONFLICT (id) DO UPDATE SET
            public = EXCLUDED.public,
            file_size_limit = EXCLUDED.file_size_limit,
            allowed_mime_types = EXCLUDED.allowed_mime_types;
    END IF;
END $$;

-- ----------------------------------------------------------------------------
-- 6. ROW LEVEL SECURITY (RLS) POLICIES
-- ----------------------------------------------------------------------------

-- Enable RLS on all domain tables
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.stores ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.task_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.submissions ENABLE ROW LEVEL SECURITY;

-- 6.1 POLICIES: profiles
-- Anyone authenticated can view user profiles (required for assigning & reviewer info)
DROP POLICY IF EXISTS "Authenticated users can read profiles" ON public.profiles;
CREATE POLICY "Authenticated users can read profiles"
    ON public.profiles FOR SELECT
    TO authenticated
    USING (true);

-- Users can update their own profile details
DROP POLICY IF EXISTS "Users can update own profile" ON public.profiles;
CREATE POLICY "Users can update own profile"
    ON public.profiles FOR UPDATE
    TO authenticated
    USING (auth.uid() = id)
    WITH CHECK (auth.uid() = id);

-- 6.2 POLICIES: stores
-- All authenticated users can view active stores
DROP POLICY IF EXISTS "Authenticated users can view stores" ON public.stores;
CREATE POLICY "Authenticated users can view stores"
    ON public.stores FOR SELECT
    TO authenticated
    USING (true);

-- Only admins and supervisors can insert/update stores
DROP POLICY IF EXISTS "Supervisors and admins can manage stores" ON public.stores;
CREATE POLICY "Supervisors and admins can manage stores"
    ON public.stores FOR ALL
    TO authenticated
    USING (
        EXISTS (
            SELECT 1 FROM public.profiles
            WHERE id = auth.uid() AND role IN ('admin', 'supervisor')
        )
    );

-- 6.3 POLICIES: tasks
-- Authenticated users can view published tasks (admins/supervisors can view all)
DROP POLICY IF EXISTS "Authenticated users can view tasks" ON public.tasks;
CREATE POLICY "Authenticated users can view tasks"
    ON public.tasks FOR SELECT
    TO authenticated
    USING (
        status = 'published'
        OR EXISTS (
            SELECT 1 FROM public.profiles
            WHERE id = auth.uid() AND role IN ('admin', 'supervisor')
        )
    );

-- Only supervisors and admins can create, update, or delete tasks
DROP POLICY IF EXISTS "Supervisors and admins can manage tasks" ON public.tasks;
CREATE POLICY "Supervisors and admins can manage tasks"
    ON public.tasks FOR ALL
    TO authenticated
    USING (
        EXISTS (
            SELECT 1 FROM public.profiles
            WHERE id = auth.uid() AND role IN ('admin', 'supervisor')
        )
    );

-- 6.4 POLICIES: task_assignments
-- Authenticated users can read task assignments
DROP POLICY IF EXISTS "Authenticated users can view assignments" ON public.task_assignments;
CREATE POLICY "Authenticated users can view assignments"
    ON public.task_assignments FOR SELECT
    TO authenticated
    USING (true);

-- Supervisors and admins can create/delete assignments
DROP POLICY IF EXISTS "Supervisors and admins can manage assignments" ON public.task_assignments;
CREATE POLICY "Supervisors and admins can manage assignments"
    ON public.task_assignments FOR ALL
    TO authenticated
    USING (
        EXISTS (
            SELECT 1 FROM public.profiles
            WHERE id = auth.uid() AND role IN ('admin', 'supervisor')
        )
    );

-- 6.5 POLICIES: submissions
-- Merchandisers can see their own submissions; supervisors and admins can see all
DROP POLICY IF EXISTS "Users can view submissions" ON public.submissions;
CREATE POLICY "Users can view submissions"
    ON public.submissions FOR SELECT
    TO authenticated
    USING (
        submitted_by = auth.uid()
        OR EXISTS (
            SELECT 1 FROM public.profiles
            WHERE id = auth.uid() AND role IN ('admin', 'supervisor')
        )
    );

-- Authenticated merchandisers and store staff can insert submissions
DROP POLICY IF EXISTS "Field staff can insert submissions" ON public.submissions;
CREATE POLICY "Field staff can insert submissions"
    ON public.submissions FOR INSERT
    TO authenticated
    WITH CHECK (
        auth.uid() = submitted_by
        OR submitted_by IS NULL
        OR EXISTS (
            SELECT 1 FROM public.profiles
            WHERE id = auth.uid() AND role IN ('admin', 'supervisor')
        )
    );

-- Supervisors and admins can review/update submissions (feedback and status)
DROP POLICY IF EXISTS "Supervisors and admins can update submissions" ON public.submissions;
CREATE POLICY "Supervisors and admins can update submissions"
    ON public.submissions FOR UPDATE
    TO authenticated
    USING (
        EXISTS (
            SELECT 1 FROM public.profiles
            WHERE id = auth.uid() AND role IN ('admin', 'supervisor')
        )
    );

-- 6.6 STORAGE POLICIES (on storage.objects)
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'storage' AND table_name = 'objects') THEN
        -- Allow public read access to shelf-images
        DROP POLICY IF EXISTS "Public can view shelf-images" ON storage.objects;
        CREATE POLICY "Public can view shelf-images"
            ON storage.objects FOR SELECT
            USING (bucket_id = 'shelf-images');

        -- Allow authenticated users to upload photos into shelf-images
        DROP POLICY IF EXISTS "Authenticated users can upload shelf-images" ON storage.objects;
        CREATE POLICY "Authenticated users can upload shelf-images"
            ON storage.objects FOR INSERT
            TO authenticated
            WITH CHECK (bucket_id = 'shelf-images');

        -- Allow users to update or delete images they uploaded
        DROP POLICY IF EXISTS "Owners can update own shelf-images" ON storage.objects;
        CREATE POLICY "Owners can update own shelf-images"
            ON storage.objects FOR UPDATE
            TO authenticated
            USING (bucket_id = 'shelf-images' AND auth.uid() = owner);

        DROP POLICY IF EXISTS "Owners can delete own shelf-images" ON storage.objects;
        CREATE POLICY "Owners can delete own shelf-images"
            ON storage.objects FOR DELETE
            TO authenticated
            USING (bucket_id = 'shelf-images' AND auth.uid() = owner);
    END IF;
END $$;
