/**
 * oneTeam — Shelf-vision provider seam
 * ============================================================================
 *
 * WHAT THIS IS, AND WHY IT IS A SEAM RATHER THAN A SERVICE
 * -------------------------------------------------------
 * Production does not judge a shelf photo today. `AIVisionService` is a
 * quarantined simulation (it reads the file *name*, never the pixels — see the
 * banner at the top of `aiVision.ts`), and the score a supervisor acts on comes
 * from `PortalService.autoApproveSubmission`, which scores signals that really
 * exist on the record (geolocation, checklist completeness, before/after).
 *
 * That method already has the plug for real vision: `if (typeof
 * evidence.aiScore === 'number')` uses a score that was set earlier over its own
 * rule-based fallback. So a vision pipeline's whole job is to *produce a
 * trustworthy `aiScore` + detections* for an evidence record — nothing here
 * needs to reach into the review logic.
 *
 * This file defines the boundary every engine plugs into: one `analyze` call,
 * one `VisionAnalysis` out. A deterministic detector (TorchVision), a vision-LLM
 * (OpenRouter / Anthropic), the existing simulation, and the hybrid that
 * combines them are all just `VisionProvider`s. Which one runs is chosen by env
 * at the edge (`resolveVisionProvider`), so swapping OpenRouter for a paid model
 * — or turning vision off entirely — is a config change, not a code change.
 */
import type {
  AnalysisEngine,
  ProductSKU,
  DetectionItem,
  PlanogramRequirement,
  SKUComplianceItem,
} from '../aiVision';

/** What an engine is given to look at, plus the rules it is judged against. */
export interface VisionInput {
  /** Where the photo lives. Always present; the URL is the record's anchor. */
  photoUrl: string;
  /**
   * The decoded image. Optional because the simulation never needs it and a URL
   * engine may fetch its own — but a local detector or an LLM that inlines the
   * image as base64 needs the bytes, and passing them avoids a second download.
   */
  imageBuffer?: Buffer;
  taskTitle?: string;
  taskDescription?: string;
  /** The planogram this shelf must satisfy. Defaulted from task text when absent. */
  requirements?: PlanogramRequirement[];
}

/**
 * How sure the engine is of its own answer — the hinge the hybrid turns on.
 *
 * Kept separate from `complianceScore` on purpose: a shelf can be *confidently*
 * 20% compliant (clearly empty) or *uncertainly* 80% (a blurry photo the
 * detector half-read). Only the second should escalate, so the two numbers must
 * not be collapsed into one.
 */
export type VisionConfidence = number; // 0 - 1

export interface VisionAnalysis {
  /** 0 - 100, comparable to the rule-based score `autoApproveSubmission` uses. */
  complianceScore: number;
  confidence: VisionConfidence;
  /**
   * True when the engine will not stand behind its own answer and a human must
   * look. The hybrid sets this when neither layer cleared its bar; a single
   * engine sets it when it ran but could not decide.
   */
  needsHumanReview: boolean;
  detectedCounts: Partial<Record<ProductSKU, number>>;
  skuBreakdown: SKUComplianceItem[];
  detections: DetectionItem[];
  summary: string;
  /** Which engine produced this. Never let a simulation masquerade as a detector. */
  engine: AnalysisEngine;
  /** The provider name + concrete model, for the audit trail and A/B analysis. */
  provider: string;
  model?: string;
  analyzedAt: string;
}

/** The one method every engine implements. */
export interface VisionProvider {
  /** Stable identifier, e.g. `torchvision`, `openrouter`, `hybrid`. Logged and audited. */
  readonly name: string;
  analyze(input: VisionInput): Promise<VisionAnalysis>;
}

/**
 * The vision-LLM transport, injected rather than imported.
 *
 * A provider that talks to OpenRouter or Anthropic must not hard-wire `fetch`,
 * a URL or a key: tests need a fake, and the production client is chosen by env.
 * So the LLM provider takes a client of this shape and never reaches for the
 * network itself.
 */
export interface VisionLLMClient {
  /** Provider label, e.g. `openrouter:google/gemini-flash-1.5`. */
  readonly label: string;
  readonly model: string;
  /**
   * Send the image + planogram prompt to a vision model and return its raw
   * judgement. Throws on transport/HTTP failure so the caller can escalate to a
   * human rather than trust a guess.
   */
  judge(input: VisionInput): Promise<VisionLLMJudgement>;
}

/** The normalized answer a vision-LLM returns, before it becomes a `VisionAnalysis`. */
export interface VisionLLMJudgement {
  complianceScore: number; // 0 - 100
  confidence: VisionConfidence; // 0 - 1
  /** Absent or false cannot authorize a shelf verdict. */
  isBeverageShelf?: boolean;
  detectedCounts: Partial<Record<ProductSKU, number>>;
  missingItems: string[];
  summary: string;
}
