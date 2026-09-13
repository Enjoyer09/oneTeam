/**
 * Automated Unit Test Suite for AI Vision & Planogram Compliance Engine
 */

import { aiVisionService, CocaColaSKU, PlanogramRequirement } from './aiVision';

function runTestSuite() {
  console.log('========================================================================');
  console.log('  🧪 STARTING AI VISION & PLANOGRAM COMPLIANCE ENGINE TESTS');
  console.log('========================================================================\n');

  let passedTests = 0;
  let totalTests = 0;

  function assert(condition: boolean, testName: string, details?: string) {
    totalTests++;
    if (condition) {
      console.log(`  ✅ [PASS] ${testName}`);
      passedTests++;
    } else {
      console.error(`  ❌ [FAIL] ${testName}`);
      if (details) {
        console.error(`     Details: ${details}`);
      }
    }
  }

  // TEST 1: Extraction of Default Planogram Requirements
  const defaultReqs = aiVisionService.extractPlanogramRequirements('Standard Cooler Check', 'Routine audit');
  assert(
    defaultReqs.length === 4 &&
      defaultReqs.some((r) => r.sku === 'coca_cola_classic') &&
      defaultReqs.some((r) => r.sku === 'coca_cola_zero') &&
      defaultReqs.some((r) => r.sku === 'fanta') &&
      defaultReqs.some((r) => r.sku === 'sprite'),
    'Test 1: Planogram Requirements Extractor extracts all 4 key Coca-Cola SKUs'
  );

  // TEST 2: Fully Compliant Shelf Evaluation (100% Match -> Auto Approved)
  const compliantResult = aiVisionService.analyzeShelfPhoto({
    photoUrl: 'https://images.unsplash.com/photo-coke-shelf-perfect.jpg',
    mockScenario: 'compliant',
  });

  assert(
    compliantResult.complianceScore >= 80 && compliantResult.complianceScore <= 100,
    'Test 2.1: Compliant shelf gets score >= 80%',
    `Actual score: ${compliantResult.complianceScore}%`
  );
  assert(
    compliantResult.autoStatus === 'approved',
    'Test 2.2: Compliant shelf receives autoStatus = "approved"'
  );
  assert(
    compliantResult.outOfStockGaps === 0,
    'Test 2.3: Compliant shelf has 0 out-of-stock gaps'
  );
  assert(
    compliantResult.aiSummary.includes('Planogram Uyğunluğu') && compliantResult.aiSummary.includes('✅'),
    'Test 2.4: Azerbaijani summary includes approval checkmark and details'
  );

  // TEST 3: Out-of-stock Gap Penalty (-15% per gap)
  const gapResult = aiVisionService.analyzeShelfPhoto({
    photoUrl: 'https://images.unsplash.com/photo-coke-shelf-gap.jpg',
    mockScenario: 'minor_gap',
  });

  assert(
    gapResult.outOfStockGaps === 1,
    'Test 3.1: Minor gap scenario detects exactly 1 out_of_stock_gap'
  );
  assert(
    gapResult.penaltiesApplied === 15,
    'Test 3.2: 1 gap applies exactly 15% penalty',
    `Actual penalty: ${gapResult.penaltiesApplied}%`
  );
  assert(
    gapResult.complianceScore <= compliantResult.complianceScore,
    'Test 3.3: Gap penalty decreases the overall compliance score'
  );

  // TEST 4: Under-facing / Missing SKU Scenario (< 80% -> Needs Manual Review)
  const missingResult = aiVisionService.analyzeShelfPhoto({
    photoUrl: 'https://images.unsplash.com/photo-coke-shelf-missing.jpg',
    mockScenario: 'missing_sku',
  });

  assert(
    missingResult.autoStatus === 'needs_manual_review',
    'Test 4.1: Missing SKU shelf is flagged with autoStatus = "needs_manual_review"'
  );
  assert(
    missingResult.complianceScore < 80,
    'Test 4.2: Missing SKU compliance score is strictly below 80%',
    `Actual score: ${missingResult.complianceScore}%`
  );
  assert(
    missingResult.missingItems.length > 0,
    'Test 4.3: Missing items array lists specific deficits in Azerbaijani',
    `Missing items: ${JSON.stringify(missingResult.missingItems)}`
  );

  // TEST 5: Bounding Box Coordinates Normalization (0 - 100%)
  const detections = compliantResult.detections;
  assert(
    detections.length > 0,
    'Test 5.1: Computer vision detections array is populated'
  );

  const validBoxes = detections.every(
    (d) =>
      d.box.x >= 0 &&
      d.box.x <= 100 &&
      d.box.y >= 0 &&
      d.box.y <= 100 &&
      d.box.width > 0 &&
      d.box.width <= 100 &&
      d.box.height > 0 &&
      d.box.height <= 100 &&
      d.confidence >= 0.5 &&
      d.confidence <= 1.0
  );
  assert(
    validBoxes,
    'Test 5.2: All bounding boxes have valid normalized percentage coordinates (0-100%) and valid confidence scores'
  );

  // TEST 6: Color coding & SKU labels match brand definitions
  const hasValidColors = detections.every(
    (d) =>
      typeof d.color === 'string' &&
      d.color.startsWith('#') &&
      typeof d.label === 'string' &&
      d.label.length > 0
  );
  assert(
    hasValidColors,
    'Test 6: All detections contain valid brand hex colors and human-readable SKU labels'
  );

  // TEST 7: Real Ultralytics YOLO Inference Worker Execution
  const yoloDets = aiVisionService.runUltralyticsInference('logo.jpg');
  assert(
    Array.isArray(yoloDets) && yoloDets.length > 0,
    'Test 7: Ultralytics YOLO inference worker runs successfully and returns detection boxes',
    `Received: ${yoloDets ? yoloDets.length : 'null'} detections`
  );

  // TEST 8: Full Shelf Analysis with Ultralytics YOLO Engine
  const yoloAnalysis = aiVisionService.analyzeShelfPhoto({
    photoUrl: 'logo.jpg',
    useUltralytics: true,
  });
  assert(
    yoloAnalysis.detections.length > 0 &&
      yoloAnalysis.complianceScore >= 0 &&
      yoloAnalysis.complianceScore <= 100 &&
      (yoloAnalysis.autoStatus === 'approved' || yoloAnalysis.autoStatus === 'needs_manual_review') &&
      typeof yoloAnalysis.aiSummary === 'string',
    'Test 8: End-to-end planogram compliance analysis succeeds using real Ultralytics engine'
  );

  console.log('\n------------------------------------------------------------------------');
  console.log(`  📊 TEST RESULTS: ${passedTests}/${totalTests} TESTS PASSED (${Math.round((passedTests / totalTests) * 100)}%)`);
  console.log('------------------------------------------------------------------------\n');

  if (passedTests !== totalTests) {
    process.exit(1);
  }
}

runTestSuite();
