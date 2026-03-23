import type { BrannockPatient, BrannockScan, PatientMetadata, TemplateBuildResponse } from '@/schemas/brannock';

// ── Mock patients — varied affiliations for filter testing ────
export const mockPatients: Array<BrannockPatient> = [
  {
    patient_id: 'patient-001',
    first_name: 'John',
    last_name: 'Doe',
    affiliations: ['clinic-a'],
    scans_url: 'https://app.podimetrics.com/api/v1/patients/patient-001/scans'
  },
  {
    patient_id: 'patient-002',
    first_name: 'Jane',
    last_name: 'Smith',
    affiliations: ['demo'],
    scans_url: 'https://app.podimetrics.com/api/v1/patients/patient-002/scans'
  },
  {
    patient_id: 'patient-003',
    first_name: 'Robert',
    last_name: 'Johnson',
    affiliations: ['clinic-b'],
    scans_url: 'https://app.podimetrics.com/api/v1/patients/patient-003/scans'
  },
  {
    patient_id: 'patient-004',
    first_name: 'Maria',
    last_name: 'Garcia',
    affiliations: ['p04'],
    scans_url: 'https://app.podimetrics.com/api/v1/patients/patient-004/scans'
  },
  {
    patient_id: 'patient-005',
    first_name: 'David',
    last_name: 'Brown',
    affiliations: ['clinic-a', 'clinic-c'],
    scans_url: 'https://app.podimetrics.com/api/v1/patients/patient-005/scans'
  },
  {
    patient_id: 'patient-006',
    first_name: 'Susan',
    last_name: 'Williams',
    affiliations: ['clinic-b'],
    scans_url: 'https://app.podimetrics.com/api/v1/patients/patient-006/scans'
  },
  {
    patient_id: 'patient-007',
    first_name: 'James',
    last_name: 'Miller',
    affiliations: ['Demo'],
    scans_url: 'https://app.podimetrics.com/api/v1/patients/patient-007/scans'
  },
  {
    patient_id: 'patient-008',
    first_name: 'Patricia',
    last_name: 'Davis',
    affiliations: ['clinic-a'],
    scans_url: 'https://app.podimetrics.com/api/v1/patients/patient-008/scans'
  },
  {
    patient_id: 'patient-009',
    first_name: 'Michael',
    last_name: 'Wilson',
    affiliations: ['clinic-c'],
    scans_url: 'https://app.podimetrics.com/api/v1/patients/patient-009/scans'
  },
  {
    patient_id: 'patient-010',
    first_name: 'Linda',
    last_name: 'Anderson',
    affiliations: [null],
    scans_url: 'https://app.podimetrics.com/api/v1/patients/patient-010/scans'
  }
];

// ── Mock scans — varied dates and scan IDs ────────────────────
export const mockScans: Array<BrannockScan> = [
  {
    scan_id: '20250315143000000001',
    when_scan_completed: '2025-03-15T14:30:00',
    mat_thermogram_url: 'https://example.com/thermogram/1',
    schema_id: 7
  },
  {
    scan_id: '20250314120000000001',
    when_scan_completed: '2025-03-14T12:00:00',
    mat_thermogram_url: 'https://example.com/thermogram/2',
    schema_id: 7
  },
  {
    scan_id: '20250313093000000001',
    when_scan_completed: '2025-03-13T09:30:00',
    mat_thermogram_url: 'https://example.com/thermogram/3',
    schema_id: 7
  },
  {
    scan_id: '20250312160000000001',
    when_scan_completed: '2025-03-12T16:00:00',
    mat_thermogram_url: 'https://example.com/thermogram/4',
    schema_id: 7
  },
  {
    scan_id: '20250311110000000001',
    when_scan_completed: '2025-03-11T11:00:00',
    mat_thermogram_url: 'https://example.com/thermogram/5',
    schema_id: 7
  },
  {
    scan_id: '20250310080000000001',
    when_scan_completed: '2025-03-10T08:00:00',
    mat_thermogram_url: 'https://example.com/thermogram/6',
    schema_id: 7
  },
  {
    scan_id: '20250309143000000001',
    when_scan_completed: '2025-03-09T14:30:00',
    mat_thermogram_url: 'https://example.com/thermogram/7',
    schema_id: 7
  },
  {
    scan_id: '20250308100000000001',
    when_scan_completed: '2025-03-08T10:00:00',
    mat_thermogram_url: 'https://example.com/thermogram/8',
    schema_id: 7
  },
  {
    scan_id: '20250307070000000001',
    when_scan_completed: '2025-03-07T07:00:00',
    mat_thermogram_url: 'https://example.com/thermogram/9',
    schema_id: 7
  },
  {
    scan_id: '20250306153000000001',
    when_scan_completed: '2025-03-06T15:30:00',
    mat_thermogram_url: 'https://example.com/thermogram/10',
    schema_id: 7
  },
  {
    scan_id: '20250305120000000001',
    when_scan_completed: '2025-03-05T12:00:00',
    mat_thermogram_url: 'https://example.com/thermogram/11',
    schema_id: 7
  },
  {
    scan_id: '20250304093000000001',
    when_scan_completed: '2025-03-04T09:30:00',
    mat_thermogram_url: 'https://example.com/thermogram/12',
    schema_id: 7
  }
];

// ── Mock metadata — scan counts for patient filtering ─────────
export const mockPatientMetadata: PatientMetadata = {
  number_of_scans_for_patients_without_templates: {
    'patient-001': 8,
    'patient-002': 2,
    'patient-003': 6,
    'patient-005': 12,
    'patient-006': 4,
    'patient-009': 5,
    'patient-010': 1
  },
  number_of_single_foot_scans_for_single_foot_patients: {
    'patient-003': 3,
    'patient-006': 5
  },
  number_of_single_foot_scans_for_two_feet_patients: {
    'patient-005': 2,
    'patient-009': 1
  }
};

// ── Mock thermogram — 36x54 grid of temperature values ────────
export const generateMockThermogram = (): Array<Array<number>> => {
  return Array.from({ length: 36 }, (_, row) =>
    Array.from({ length: 54 }, (_, col) => {
      // Create a foot-like shape with warmer areas in the center
      const centerRow = 18;
      const centerCol = 27;
      const distance = Math.sqrt(Math.pow(row - centerRow, 2) + Math.pow(col - centerCol, 2));
      const baseTemp = 25;
      const warmth = Math.max(0, 8 - distance * 0.3);
      return baseTemp + warmth + (Math.random() - 0.5) * 2;
    })
  );
};

// ── Mock template build response (bilateral) ──────────────────
const generateMockFootTemplate = (rows: number, cols: number): Array<Array<number>> => {
  return Array.from({ length: rows }, (_, row) =>
    Array.from({ length: cols }, (_, col) => {
      // Create a foot-shaped mask: values 0-1, higher in the center
      const centerRow = rows / 2;
      const centerCol = cols / 2;
      const normalizedDist = Math.sqrt(Math.pow((row - centerRow) / rows, 2) + Math.pow((col - centerCol) / cols, 2));
      const value = Math.max(0, 1 - normalizedDist * 2.5);
      return Math.round(value * 100) / 100;
    })
  );
};

export const mockTemplateBuildResponse: TemplateBuildResponse = {
  left_foot: generateMockFootTemplate(25, 15),
  right_foot: generateMockFootTemplate(25, 15),
  left_threshold: 0.4,
  right_threshold: 0.4,
  earliest_scan_id: '20250305120000000001',
  date_created: '2025-03-05T12:00:00Z',
  foot_side: null
};

// ── Mock single-foot build response ───────────────────────────
export const mockSingleFootBuildResponse: TemplateBuildResponse = {
  left_foot: generateMockFootTemplate(25, 15),
  right_foot: null,
  left_threshold: 0.4,
  right_threshold: 0.4,
  earliest_scan_id: '20250305120000000001',
  date_created: '2025-03-05T12:00:00Z',
  foot_side: 1 // left foot
};
