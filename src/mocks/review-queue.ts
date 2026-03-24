// ── Mock review queue data ────────────────────────────────────
// Simulates what a production system would return: scans processed
// by the auto-keypoint pipeline with confidence tiers.

export type ConfidenceTier = 'low' | 'medium' | 'high';
export type ReviewStatus = 'pending' | 'approved' | 'rejected' | 'manual_override';

export interface ReviewScanItem {
  id: string;
  scan_id: string;
  patient_id: string;
  patient_designation: string;
  side: 'left' | 'right';
  confidence_tier: ConfidenceTier;
  mean_confidence: number;
  min_confidence: number;
  keypoints_detected: number;
  null_keypoints: number;
  anomalies: string | null;
  scan_date: string;
  processed_at: string;
  review_status: ReviewStatus;
  model_keypoints: {
    name: string;
    x: number | null;
    y: number | null;
    confidence: number | null;
  }[];
}

// ── Deterministic mock generator ─────────────────────────────
function seededRandom(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };
}

const PATIENT_DESIGNATIONS = [
  'TT-0001', 'TT-0002', 'TT-0906', 'TT-1108', 'RM-3226',
  'JD-022952', 'RA-042239', 'BX-0773', 'CL-2290', 'WR-0445',
  'KT-1632', 'MH-4401', 'SP-0098', 'DV-3317', 'LR-2855',
  'NW-1423', 'CB-0561', 'FK-4072', 'HG-1890', 'PT-3654'
];

const PATIENT_IDS = [
  '64baf22aa00d633aed21f2b86979914e', 'fa4a56521d93238218b29d027b4d32c6',
  '0df791d8930313dee4d44e7e0cdc0993', '3e0ae38751022575a348ab642988aeae',
  'f210582200d7eaad76eddc25b83c034e', '3c0cb0a1fcaf2414056dc28062bf4445',
  'f20af594081957ad67181671dc99b1e5', 'e5f67890abcd2345def6789012345bcd',
  'f6a78901bcde3456ef78901234567cde', '07b89012cdef4567f089012345678def',
  '18c90123def05678a190123456789ef0', 'ab12cd34ef56789012345678abcdef01',
  'cd34ef56ab78901234567890cdef1234', 'ef56ab78cd90123456789012efab3456',
  'ab78cd90ef12345678901234abcd5678', '123456789abcdef012345678fedcba98',
  '98765432fedcba01234567890abcdef1', 'aabbccdd11223344556677889900aabb',
  'deadbeef12345678cafebabe87654321', 'f00dface98765432baadf00dcafed00d'
];

const KEYPOINT_NAMES = ['Hallux', '1st Metatarsal Head', '3rd Metatarsal Head', '5th Metatarsal Head', 'Arch', 'Heel'];

function generateKeypoints(rand: () => number, tier: ConfidenceTier) {
  const confBase = tier === 'high' ? 0.85 : tier === 'medium' ? 0.55 : 0.25;
  return KEYPOINT_NAMES.map((name) => {
    const isNull = tier === 'low' && rand() < 0.15;
    const conf = isNull ? null : Math.min(1, Math.max(0, confBase + (rand() - 0.5) * 0.3));
    return {
      name,
      x: isNull ? null : Math.round((0.2 + rand() * 0.6) * 1000) / 1000,
      y: isNull ? null : Math.round((0.1 + rand() * 0.8) * 1000) / 1000,
      confidence: conf ? Math.round(conf * 100) / 100 : null
    };
  });
}

function generateItems(count: number, tier: ConfidenceTier, startIdx: number, rand: () => number): Array<ReviewScanItem> {
  const items: Array<ReviewScanItem> = [];
  for (let i = 0; i < count; i++) {
    const idx = (startIdx + i) % PATIENT_DESIGNATIONS.length;
    const kps = generateKeypoints(rand, tier);
    const validConfs = kps.filter((k) => k.confidence !== null).map((k) => k.confidence!);
    const meanConf = validConfs.length > 0 ? validConfs.reduce((a, b) => a + b, 0) / validConfs.length : 0;
    const minConf = validConfs.length > 0 ? Math.min(...validConfs) : 0;
    const side = rand() > 0.5 ? 'left' : 'right';

    const hoursAgo = Math.floor(rand() * 24);
    const scanDate = new Date(Date.now() - hoursAgo * 3600000);
    const processedDate = new Date(scanDate.getTime() + 120000);

    items.push({
      id: `review-${tier}-${i}`,
      scan_id: `2026${String(3).padStart(2, '0')}${String(24 - Math.floor(hoursAgo / 24)).padStart(2, '0')}${String(Math.floor(rand() * 235959)).padStart(6, '0')}${String(Math.floor(rand() * 999)).padStart(3, '0')}${Array.from({ length: 14 }, () => 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'[Math.floor(rand() * 62)]).join('')}`,
      patient_id: PATIENT_IDS[idx],
      patient_designation: PATIENT_DESIGNATIONS[idx],
      side,
      confidence_tier: tier,
      mean_confidence: Math.round(meanConf * 100) / 100,
      min_confidence: Math.round(minConf * 100) / 100,
      keypoints_detected: kps.filter((k) => k.x !== null).length,
      null_keypoints: kps.filter((k) => k.x === null).length,
      anomalies: tier === 'low' && rand() < 0.4 ? 'Possible hallux amputation' : null,
      scan_date: scanDate.toISOString(),
      processed_at: processedDate.toISOString(),
      review_status: 'pending',
      model_keypoints: kps
    });
  }
  return items;
}

const rand = seededRandom(42);

export const mockReviewQueue: Array<ReviewScanItem> = [
  ...generateItems(7, 'low', 0, rand),
  ...generateItems(10, 'medium', 3, rand),
  ...generateItems(400, 'high', 7, rand)
];

export const mockQueueSummary = {
  total: mockReviewQueue.length,
  low: mockReviewQueue.filter((i) => i.confidence_tier === 'low').length,
  medium: mockReviewQueue.filter((i) => i.confidence_tier === 'medium').length,
  high: mockReviewQueue.filter((i) => i.confidence_tier === 'high').length,
  pending: mockReviewQueue.filter((i) => i.review_status === 'pending').length,
  processed_today: mockReviewQueue.length
};
