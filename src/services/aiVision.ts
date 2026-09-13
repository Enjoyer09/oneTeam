/**
 * ⚠️ THIS IS A SIMULATION. IT DOES NOT LOOK AT ANY PHOTO.
 * ============================================================================
 *
 * `detectShelfProducts` never reads the image. It picks one of four hardcoded
 * sets of bounding boxes by searching the *photo URL string* for words like
 * "gap", "missing" or "reject" (`inferScenario`), and generates a compliance
 * score from those fixed boxes.
 *
 * It was wired into the bot's submission path until recently, which meant every
 * merchandiser saw a confident-looking "AI Uyğunluq Balı" that had been produced
 * from a file name. Because the bot generated its own names
 * (`audits/<store>/<task>_<timestamp>.jpg`), none of the keywords ever matched,
 * so every photo scored the same flattering result.
 *
 * It is kept because `aiVision.test.ts` exercises it and because a real detector
 * is a plausible future feature. It is NOT used anywhere in production, and it
 * must not be re-wired into the submission path as if it were an analyser. The
 * score a supervisor acts on comes from `PortalService.autoApproveSubmission`,
 * which scores signals that genuinely exist on the record.
 */

import { spawnSync } from 'child_process';
import path from 'path';
import fs from 'fs';

export type CocaColaSKU =
  | 'coca_cola_classic'
  | 'coca_cola_zero'
  | 'fanta'
  | 'sprite'
  | 'out_of_stock_gap';

export interface BoundingBox {
  /** X coordinate percentage from left (0 - 100) */
  x: number;
  /** Y coordinate percentage from top (0 - 100) */
  y: number;
  /** Width percentage (0 - 100) */
  width: number;
  /** Height percentage (0 - 100) */
  height: number;
}

export interface DetectionItem {
  id: string;
  sku: CocaColaSKU;
  label: string;
  confidence: number;
  box: BoundingBox;
  color: string;
  shelfRow: number;
  facingIndex: number;
}

export interface PlanogramRequirement {
  sku: CocaColaSKU;
  label: string;
  minFacings: number;
}

export interface SKUComplianceItem {
  sku: CocaColaSKU;
  label: string;
  required: number;
  detected: number;
  isMet: boolean;
  matchPercentage: number;
}

export interface PlanogramComplianceEvaluation {
  complianceScore: number; // 0 - 100
  autoStatus: 'approved' | 'needs_manual_review';
  detectedCounts: Record<CocaColaSKU, number>;
  skuBreakdown: SKUComplianceItem[];
  outOfStockGaps: number;
  penaltiesApplied: number;
  missingItems: string[];
  aiSummary: string;
  detections: DetectionItem[];
  analyzedAt: string;
}

export interface AnalysisInput {
  photoUrl: string;
  imageBuffer?: Buffer;
  taskTitle?: string;
  taskDescription?: string;
  customRequirements?: PlanogramRequirement[];
  mockScenario?: 'compliant' | 'minor_gap' | 'missing_sku' | 'severe_issues';
  useUltralytics?: boolean;
}

export const SKU_METADATA: Record<CocaColaSKU, { label: string; color: string; defaultMin: number }> = {
  coca_cola_classic: {
    label: 'Coca-Cola Classic 0.5L',
    color: '#F40009', // Coke Red
    defaultMin: 3,
  },
  coca_cola_zero: {
    label: 'Coca-Cola Zero Sugar 0.5L',
    color: '#111827', // Slate Dark / Black
    defaultMin: 2,
  },
  fanta: {
    label: 'Fanta Orange 0.5L',
    color: '#FF7300', // Vibrant Fanta Orange
    defaultMin: 2,
  },
  sprite: {
    label: 'Sprite 0.5L',
    color: '#008B47', // Sprite Green
    defaultMin: 2,
  },
  out_of_stock_gap: {
    label: 'Boşluq (Out of Stock)',
    color: '#EF4444', // Warning Red
    defaultMin: 0,
  },
};

export class AIVisionService {
  /**
   * Parse planogram requirements from task text or return standard Coca-Cola cooler rules.
   */
  public extractPlanogramRequirements(
    title = '',
    description = '',
    custom?: PlanogramRequirement[]
  ): PlanogramRequirement[] {
    if (custom && custom.length > 0) {
      return custom;
    }

    const text = `${title} ${description}`.toLowerCase();

    // If task is specifically Zero Sugar focused
    if (text.includes('zero') && !text.includes('classic')) {
      return [
        { sku: 'coca_cola_zero', label: SKU_METADATA.coca_cola_zero.label, minFacings: 4 },
        { sku: 'coca_cola_classic', label: SKU_METADATA.coca_cola_classic.label, minFacings: 2 },
      ];
    }

    // If task is Fanta & Sprite focused
    if ((text.includes('fanta') || text.includes('sprite')) && !text.includes('classic')) {
      return [
        { sku: 'fanta', label: SKU_METADATA.fanta.label, minFacings: 3 },
        { sku: 'sprite', label: SKU_METADATA.sprite.label, minFacings: 3 },
      ];
    }

    // Default Full Cooler Planogram Rule
    return [
      { sku: 'coca_cola_classic', label: SKU_METADATA.coca_cola_classic.label, minFacings: 3 },
      { sku: 'coca_cola_zero', label: SKU_METADATA.coca_cola_zero.label, minFacings: 2 },
      { sku: 'fanta', label: SKU_METADATA.fanta.label, minFacings: 2 },
      { sku: 'sprite', label: SKU_METADATA.sprite.label, minFacings: 2 },
    ];
  }

  /**
   * Run official Ultralytics YOLO inference via local Python worker.
   */
  public runUltralyticsInference(imageSource: string): DetectionItem[] | null {
    try {
      const venvPython = path.resolve(process.cwd(), '.venv/bin/python');
      const scriptPath = path.resolve(process.cwd(), 'scripts/yolo_inference.py');

      if (!fs.existsSync(venvPython) || !fs.existsSync(scriptPath)) {
        return null;
      }

      const configDir = path.resolve(process.cwd(), '.yolo_config');
      if (!fs.existsSync(configDir)) {
        fs.mkdirSync(configDir, { recursive: true });
      }

      const res = spawnSync(
        venvPython,
        [scriptPath, '--image', imageSource, '--model', 'yolov8n.pt'],
        {
          encoding: 'utf-8',
          // A cold start has to load yolov8n.pt and initialise torch before it
          // can infer anything, and that is materially slower when the machine
          // is busy (for example while the full test suite is running). The
          // previous 20s cap made this call fail intermittently under load,
          // which surfaced as a flaky test rather than a real defect.
          // Override with ONETEAM_YOLO_TIMEOUT_MS when running on slow CI.
          timeout: Number(process.env.ONETEAM_YOLO_TIMEOUT_MS) || 60000,
          maxBuffer: 10 * 1024 * 1024,
          env: {
            ...process.env,
            YOLO_CONFIG_DIR: configDir,
            ULTRALYTICS_CONFIG_DIR: configDir,
            YOLO_VERBOSE: 'False',
          },
        }
      );

      if (res.status === 0 && res.stdout) {
        const lines = res.stdout.trim().split('\n');
        for (let i = lines.length - 1; i >= 0; i--) {
          const candidate = lines[i].trim();
          if (candidate.startsWith('{') && candidate.endsWith('}')) {
            try {
              const parsed = JSON.parse(candidate);
              if (parsed.success && Array.isArray(parsed.detections) && parsed.detections.length > 0) {
                return parsed.detections as DetectionItem[];
              }
            } catch {
              // try previous line
            }
          }
        }
      }
    } catch (err: any) {
      console.warn('Ultralytics inference notice:', err?.message || err);
    }
    return null;
  }

  /**
   * Run Computer Vision inference on shelf photo.
   * Generates realistic YOLO-style bounding boxes with confidence scores.
   */
  public detectShelfProducts(input: AnalysisInput): DetectionItem[] {
    // 1. Try real Ultralytics YOLO if explicitly requested or if no mockScenario override
    if (input.useUltralytics || (!input.mockScenario && input.photoUrl)) {
      const yoloDetections = this.runUltralyticsInference(input.photoUrl);
      if (yoloDetections && yoloDetections.length > 0) {
        return yoloDetections;
      }
    }

    // 2. Fallback to heuristic / simulated computer vision engine
    const detections: DetectionItem[] = [];
    const scenario = input.mockScenario || this.inferScenario(input);

    let idCounter = 1;
    const addDetection = (
      sku: CocaColaSKU,
      x: number,
      y: number,
      width: number,
      height: number,
      confidence: number,
      shelfRow: number,
      facingIndex: number
    ) => {
      detections.push({
        id: `det-${idCounter++}`,
        sku,
        label: SKU_METADATA[sku].label,
        confidence: Number(confidence.toFixed(2)),
        box: {
          x: Math.round(x),
          y: Math.round(y),
          width: Math.round(width),
          height: Math.round(height),
        },
        color: SKU_METADATA[sku].color,
        shelfRow,
        facingIndex,
      });
    };

    // Layout configuration across 2 shelf rows
    // Row 1: Eye-level (Y: ~18% to ~48%)
    // Row 2: Lower shelf (Y: ~52% to ~82%)

    if (scenario === 'compliant') {
      // Shelf Row 1: 3x Classic, 2x Zero
      addDetection('coca_cola_classic', 8, 18, 14, 30, 0.96, 1, 1);
      addDetection('coca_cola_classic', 24, 18, 14, 30, 0.94, 1, 2);
      addDetection('coca_cola_classic', 40, 18, 14, 30, 0.97, 1, 3);
      addDetection('coca_cola_zero', 58, 18, 14, 30, 0.93, 1, 4);
      addDetection('coca_cola_zero', 74, 18, 14, 30, 0.95, 1, 5);

      // Shelf Row 2: 2x Fanta, 2x Sprite, 1x Classic
      addDetection('fanta', 8, 54, 15, 30, 0.92, 2, 1);
      addDetection('fanta', 25, 54, 15, 30, 0.91, 2, 2);
      addDetection('sprite', 44, 54, 15, 30, 0.95, 2, 3);
      addDetection('sprite', 61, 54, 15, 30, 0.94, 2, 4);
      addDetection('coca_cola_classic', 78, 54, 15, 30, 0.89, 2, 5);
    } else if (scenario === 'minor_gap') {
      // Row 1: 3x Classic, 1x Zero, 1x GAP
      addDetection('coca_cola_classic', 8, 18, 14, 30, 0.95, 1, 1);
      addDetection('coca_cola_classic', 24, 18, 14, 30, 0.93, 1, 2);
      addDetection('coca_cola_classic', 40, 18, 14, 30, 0.96, 1, 3);
      addDetection('coca_cola_zero', 58, 18, 14, 30, 0.91, 1, 4);
      addDetection('out_of_stock_gap', 74, 18, 14, 30, 0.88, 1, 5); // 1 gap

      // Row 2: 2x Fanta, 2x Sprite
      addDetection('fanta', 10, 54, 16, 30, 0.94, 2, 1);
      addDetection('fanta', 28, 54, 16, 30, 0.92, 2, 2);
      addDetection('sprite', 48, 54, 16, 30, 0.90, 2, 3);
      addDetection('sprite', 66, 54, 16, 30, 0.93, 2, 4);
    } else if (scenario === 'missing_sku') {
      // Missing Fanta facings and 1 gap
      addDetection('coca_cola_classic', 8, 18, 15, 30, 0.95, 1, 1);
      addDetection('coca_cola_classic', 25, 18, 15, 30, 0.92, 1, 2);
      addDetection('coca_cola_zero', 43, 18, 15, 30, 0.91, 1, 3);
      addDetection('out_of_stock_gap', 62, 18, 15, 30, 0.87, 1, 4); // gap

      // Row 2: 1x Fanta (missing 1), 2x Sprite
      addDetection('fanta', 12, 54, 16, 30, 0.89, 2, 1);
      addDetection('sprite', 35, 54, 16, 30, 0.91, 2, 2);
      addDetection('sprite', 55, 54, 16, 30, 0.93, 2, 3);
      addDetection('out_of_stock_gap', 75, 54, 16, 30, 0.85, 2, 4); // second gap
    } else {
      // Severe issues: multiple gaps, low facings
      addDetection('coca_cola_classic', 10, 18, 16, 30, 0.92, 1, 1);
      addDetection('out_of_stock_gap', 32, 18, 18, 30, 0.89, 1, 2);
      addDetection('out_of_stock_gap', 55, 18, 18, 30, 0.91, 1, 3);
      addDetection('coca_cola_zero', 76, 18, 16, 30, 0.86, 1, 4);

      addDetection('fanta', 15, 54, 16, 30, 0.88, 2, 1);
      addDetection('out_of_stock_gap', 40, 54, 20, 30, 0.93, 2, 2);
      addDetection('sprite', 68, 54, 16, 30, 0.87, 2, 3);
    }

    return detections;
  }

  /**
   * Evaluate compliance of detected products against Planogram requirements.
   */
  public evaluateCompliance(
    detections: DetectionItem[],
    requirements: PlanogramRequirement[]
  ): PlanogramComplianceEvaluation {
    const counts: Record<CocaColaSKU, number> = {
      coca_cola_classic: 0,
      coca_cola_zero: 0,
      fanta: 0,
      sprite: 0,
      out_of_stock_gap: 0,
    };

    detections.forEach((d) => {
      counts[d.sku] = (counts[d.sku] || 0) + 1;
    });

    const skuBreakdown: SKUComplianceItem[] = requirements.map((req) => {
      const detected = counts[req.sku] || 0;
      const matchPercentage = Math.min(100, Math.round((detected / req.minFacings) * 100));
      return {
        sku: req.sku,
        label: req.label,
        required: req.minFacings,
        detected,
        isMet: detected >= req.minFacings,
        matchPercentage,
      };
    });

    // 1. Calculate Base SKU Fulfillment Score (average of match percentages)
    const totalRequiredSKUs = skuBreakdown.length || 1;
    const sumFulfillment = skuBreakdown.reduce((acc, item) => acc + item.matchPercentage, 0);
    const baseScore = sumFulfillment / totalRequiredSKUs;

    // 2. Out-of-stock Gap Penalty (-15% per gap detected)
    const outOfStockGaps = counts.out_of_stock_gap || 0;
    const penaltyPerGap = 15;
    const penaltiesApplied = outOfStockGaps * penaltyPerGap;

    // 3. Final Compliance Score (Bounded between 0 and 100)
    const complianceScore = Math.max(0, Math.min(100, Math.round(baseScore - penaltiesApplied)));

    // 4. Automated Verdict
    // Score >= 80% is Auto-Approved, otherwise needs manual supervisor review
    const autoStatus: 'approved' | 'needs_manual_review' =
      complianceScore >= 80 ? 'approved' : 'needs_manual_review';

    // 5. Generate Missing Items & Azerbaijani Summary
    const missingItems: string[] = [];
    skuBreakdown.forEach((item) => {
      if (!item.isMet) {
        const diff = item.required - item.detected;
        missingItems.push(
          `${item.label} çatışmır: ${item.detected}/${item.required} facing (çatışmayan: ${diff})`
        );
      }
    });

    if (outOfStockGaps > 0) {
      missingItems.push(`Rəfdə ${outOfStockGaps} ədəd boşluq (out of stock) aşkarlandı (-${penaltiesApplied}% cərimə)`);
    }

    // Build Azerbaijani summary string
    let aiSummary = '';
    if (autoStatus === 'approved') {
      aiSummary =
        `✅ Planogram Uyğunluğu: ${complianceScore}%. ` +
        `Rəf düzülüşü standartlara tam cavab verir. Aşkarlandı: ` +
        `${counts.coca_cola_classic}x Classic, ${counts.coca_cola_zero}x Zero, ` +
        `${counts.fanta}x Fanta, ${counts.sprite}x Sprite.` +
        (outOfStockGaps > 0 ? ` Xəbərdarlıq: ${outOfStockGaps} boşluq qeydə alındı.` : ' Boşluq yoxdur.');
    } else {
      aiSummary =
        `⚠️ Planogram Uyğunluğu: ${complianceScore}% (Supervayzer yoxlaması tələb olunur). ` +
        `Səbəb: ${missingItems.slice(0, 2).join('; ')}. ` +
        `Aşkarlandı: ${counts.coca_cola_classic}x Classic, ${counts.coca_cola_zero}x Zero, ` +
        `${counts.fanta}x Fanta, ${counts.sprite}x Sprite, ${outOfStockGaps}x boşluq.`;
    }

    return {
      complianceScore,
      autoStatus,
      detectedCounts: counts,
      skuBreakdown,
      outOfStockGaps,
      penaltiesApplied,
      missingItems,
      aiSummary,
      detections,
      analyzedAt: new Date().toISOString(),
    };
  }

  /**
   * Main entrypoint: analyze photo and return complete evaluation.
   */
  public analyzeShelfPhoto(input: AnalysisInput): PlanogramComplianceEvaluation {
    const requirements = this.extractPlanogramRequirements(
      input.taskTitle,
      input.taskDescription,
      input.customRequirements
    );
    const detections = this.detectShelfProducts(input);
    return this.evaluateCompliance(detections, requirements);
  }

  /**
   * Helper to infer scenario based on photo URL or text hints
   */
  private inferScenario(
    input: AnalysisInput
  ): 'compliant' | 'minor_gap' | 'missing_sku' | 'severe_issues' {
    const text = `${input.photoUrl} ${input.taskTitle || ''}`.toLowerCase();
    if (text.includes('reject') || text.includes('poor') || text.includes('empty')) {
      return 'severe_issues';
    }
    if (text.includes('gap') || text.includes('warning') || text.includes('sub-002')) {
      return 'minor_gap';
    }
    if (text.includes('sub-004') || text.includes('missing')) {
      return 'missing_sku';
    }
    return 'compliant';
  }
}

export const aiVisionService = new AIVisionService();
