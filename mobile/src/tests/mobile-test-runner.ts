/**
 * oneTeam iOS Mobile Client — Automated Test Runner
 * Validates:
 * 1. Anti-Fraud Geofencing & GPS Haversine Calculations (100m rule)
 * 2. Smart Camera Ghost Overlay & Anti-Gallery restrictions
 * 3. Offline in-store queuing & background synchronization
 * 4. Submission payload schema formatting
 */

import { calculateDistanceMeters, verifyStoreGeofence } from '../utils/geofence';
import { offlineQueueService } from '../services/offlineQueue';
import { mobileSupabase } from '../services/supabaseMobile';
import { CameraAuditController } from '../screens/CameraAuditScreen';
import { assertLiveCameraCapture } from '../components/SmartCameraOverlay';
import { GPSCoordinates, MobileStore, MobileTask } from '../types';

const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  green: '\x1b[32m',
  cyan: '\x1b[36m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
};

function logStep(num: number, title: string) {
  console.log(`\n${colors.bright}${colors.cyan}[TEST SUITE ${num}] ${title}${colors.reset}`);
}

function logPass(msg: string) {
  console.log(`${colors.green}  ✓ ${msg}${colors.reset}`);
}

function logInfo(msg: string) {
  console.log(`${colors.yellow}  ℹ ${msg}${colors.reset}`);
}

async function runMobileTests() {
  console.log(`${colors.bright}========================================================================${colors.reset}`);
  console.log(`${colors.bright}  oneTeam iOS FIELD CLIENT — AUTOMATED MOBILE VERIFICATION TESTS        ${colors.reset}`);
  console.log(`${colors.bright}========================================================================${colors.reset}`);

  // Reference Store: Bravo Supermarket 28 Mall
  const store: MobileStore = {
    id: '22222222-2222-2222-2222-222222222221',
    store_code: 'BRAVO_28MAY_01',
    name: 'Bravo Supermarket - 28 Mall',
    address: '28 May küç., Nəsimi, Bakı',
    city: 'Bakı',
    latitude: 40.379893,
    longitude: 49.847512,
    is_active: true,
  };

  const task: MobileTask = {
    id: '11111111-1111-1111-1111-111111111111',
    title: 'Coca-Cola 0.5L Cooler Placement Check',
    description: 'Ensure 3 facings per SKU, labels facing outward, cooler <= 4°C.',
    reference_image_url: 'https://mock-oneteam.supabase.co/planogram.jpg',
    priority: 'high',
    status: 'published',
    deadline: '2026-09-20T18:00:00Z',
    cooling_requirement: '≤ 4°C',
    facings_per_sku: 3,
  };

  // --------------------------------------------------------------------------
  // TEST 1: GPS Geofencing (Anti-Fraud Location Verification)
  // --------------------------------------------------------------------------
  logStep(1, 'Anti-Fraud GPS Geofencing Verification (100m Perimeter)');

  // 1A: User inside store (approx 3.5 meters away from store center)
  const insideGPS: GPSCoordinates = {
    latitude: 40.379915,
    longitude: 49.847535,
    accuracy: 3.5,
  };

  const insideResult = verifyStoreGeofence(insideGPS, {
    latitude: store.latitude,
    longitude: store.longitude,
  });

  logInfo(`User location (inside): ${insideResult.distanceMeters} meters away.`);
  if (!insideResult.isWithinGeofence) {
    throw new Error(`Expected insideResult to be within geofence (< 100m), got ${insideResult.distanceMeters}m`);
  }
  logPass(`Store geofence confirmed within threshold: ${insideResult.message}`);

  // 1B: User outside store (approx 1,350 meters away at Fountain Square)
  const outsideGPS: GPSCoordinates = {
    latitude: 40.3705,
    longitude: 49.837,
    accuracy: 10,
  };

  const outsideResult = verifyStoreGeofence(outsideGPS, {
    latitude: store.latitude,
    longitude: store.longitude,
  });

  logInfo(`User location (outside): ${outsideResult.distanceMeters} meters away.`);
  if (outsideResult.isWithinGeofence) {
    throw new Error('Expected outsideResult to be rejected by geofence');
  }
  if (!outsideResult.message.includes('Siz mağaza ərazisində deyilsiniz')) {
    throw new Error('Expected anti-fraud warning message when outside store');
  }
  logPass(`Anti-fraud protection blocked audit outside geofence: "${outsideResult.message}"`);

  // --------------------------------------------------------------------------
  // TEST 2: Smart Camera & Anti-Gallery Enforcement
  // --------------------------------------------------------------------------
  logStep(2, 'Smart Camera Live Capture & Anti-Gallery Enforcement');

  // 2A: Test gallery rejection
  let galleryBlocked = false;
  try {
    assertLiveCameraCapture('gallery');
  } catch (err: any) {
    galleryBlocked = true;
    logPass(`Gallery photo upload rejected: "${err.message}"`);
  }
  if (!galleryBlocked) {
    throw new Error('Expected gallery photo selection to be blocked');
  }

  // 2B: Test live camera capture with Ghost Overlay
  const cameraController = new CameraAuditController(task, store);
  cameraController.setGhostOpacity(0.5);

  const capture = await cameraController.captureLiveAudit({
    source: 'camera',
    userGPS: insideGPS,
  });

  if (!capture.photoUri.startsWith('file://')) {
    throw new Error('Expected photoUri to be captured file path');
  }
  if (capture.metadata.capture_mode !== 'live_camera_only') {
    throw new Error('Expected metadata capture_mode to be live_camera_only');
  }
  if (!capture.metadata.ghost_overlay_used) {
    throw new Error('Expected ghost_overlay_used to be true in metadata');
  }

  logPass(`Live camera photo captured: ${capture.photoUri}`);
  logPass(`Telemetry metadata stamped: GPS(${capture.metadata.gps.latitude}, ${capture.metadata.gps.longitude}), Distance=${capture.metadata.distance_from_store_meters}m, Device=${capture.metadata.device_model}`);

  // --------------------------------------------------------------------------
  // TEST 3: Offline Queue & In-Store Background Synchronization
  // --------------------------------------------------------------------------
  logStep(3, 'Offline In-Store Queue & Background Sync Engine');

  // Simulate loss of signal inside basement store
  offlineQueueService.setOnlineStatus(false);
  logInfo('Network status changed: OFFLINE (Basement retail store)');

  const offlineSubmissionResult = await cameraController.processAuditSubmission({
    photoUri: capture.photoUri,
    metadata: capture.metadata,
  });

  if (offlineSubmissionResult.status !== 'queued_offline') {
    throw new Error('Expected submission to be queued offline when disconnected');
  }
  if (offlineQueueService.getPendingCount() !== 1) {
    throw new Error(`Expected pending count 1, got ${offlineQueueService.getPendingCount()}`);
  }
  logPass(`Audit successfully stored in offline queue (ID: ${offlineSubmissionResult.queueItem?.id})`);

  // Simulate signal restoration (merchandiser steps outside / connects to Wi-Fi)
  offlineQueueService.setOnlineStatus(true);
  logInfo('Network status changed: ONLINE (Connected)');

  const syncResult = await offlineQueueService.processQueue(async (item) => {
    const photoUrl = await mobileSupabase.uploadPhotoToStorage(
      item.photo_uri,
      item.store_id,
      item.task_id
    );
    const sub = await mobileSupabase.submitAudit({
      taskId: item.task_id,
      storeId: item.store_id,
      photoUrl,
      metadata: item.metadata,
    });
    return { photoUrl, submissionId: sub.id };
  });

  if (syncResult.syncedCount !== 1) {
    throw new Error(`Expected 1 item synced, got ${syncResult.syncedCount}`);
  }
  if (offlineQueueService.getPendingCount() !== 0) {
    throw new Error(`Expected queue to be drained, got ${offlineQueueService.getPendingCount()}`);
  }
  logPass(`Background sync processed queued items: ${syncResult.syncedCount} uploaded to Supabase`);

  // --------------------------------------------------------------------------
  // TEST 4: Supabase Submission Payload Validation
  // --------------------------------------------------------------------------
  logStep(4, 'Supabase Submissions Schema Payload Compliance');

  const allSubmissions = mobileSupabase.getAllSubmissions();
  if (allSubmissions.length === 0) {
    throw new Error('Expected at least 1 submission in Supabase');
  }

  const latest = allSubmissions[0];
  if (!latest.photo_url.includes('shelf-images')) {
    throw new Error(`Invalid bucket URL: ${latest.photo_url}`);
  }
  if (latest.status !== 'pending_review') {
    throw new Error(`Expected pending_review, got ${latest.status}`);
  }
  if (!latest.metadata.gps || !latest.metadata.captured_at) {
    throw new Error('Missing GPS or timestamp in submission metadata');
  }

  logPass(`Submission record valid: ID=${latest.id}`);
  logPass(`Storage URL: ${latest.photo_url}`);
  logPass(`Initial Status: ${latest.status}`);

  console.log(`\n${colors.bright}${colors.green}========================================================================${colors.reset}`);
  console.log(`${colors.bright}${colors.green}  ALL iOS FIELD CLIENT TESTS PASSED! (100% OPERATIONAL & VERIFIED)      ${colors.reset}`);
  console.log(`${colors.bright}${colors.green}========================================================================${colors.reset}\n`);
}

runMobileTests().catch((err) => {
  console.error('\n❌ Mobile test runner failed:', err);
  process.exit(1);
});
