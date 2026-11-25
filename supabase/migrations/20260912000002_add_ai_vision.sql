-- ============================================================================
-- MIGRATION: 20260912000002_add_ai_vision.sql
-- Description: Add AI Computer Vision & Planogram Compliance columns to submissions
-- ============================================================================

DO $$
BEGIN
    -- Add ai_score (0 - 100)
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_schema = 'public' 
        AND table_name = 'submissions' 
        AND column_name = 'ai_score'
    ) THEN
        ALTER TABLE public.submissions 
        ADD COLUMN ai_score INTEGER CHECK (ai_score >= 0 AND ai_score <= 100);
    END IF;

    -- Add ai_detections (JSONB bounding boxes and SKU labels)
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_schema = 'public' 
        AND table_name = 'submissions' 
        AND column_name = 'ai_detections'
    ) THEN
        ALTER TABLE public.submissions 
        ADD COLUMN ai_detections JSONB NOT NULL DEFAULT '[]'::jsonb;
    END IF;

    -- Add ai_summary (Azerbaijani compliance summary text)
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_schema = 'public' 
        AND table_name = 'submissions' 
        AND column_name = 'ai_summary'
    ) THEN
        ALTER TABLE public.submissions 
        ADD COLUMN ai_summary TEXT;
    END IF;
END $$;

-- Index for AI compliance score queries & analytics
CREATE INDEX IF NOT EXISTS idx_submissions_ai_score ON public.submissions(ai_score);
CREATE INDEX IF NOT EXISTS idx_submissions_ai_detections ON public.submissions USING gin(ai_detections);

COMMENT ON COLUMN public.submissions.ai_score IS 'Automated AI Planogram Compliance Score (0-100)';
COMMENT ON COLUMN public.submissions.ai_detections IS 'Detected oneTeam Retail SKUs with bounding boxes, confidence, and facings';
COMMENT ON COLUMN public.submissions.ai_summary IS 'Automated verdict and compliance notes in Azerbaijani';
