import type { BrannockPatient, PatientMetadata } from '@/schemas/brannock';
import { getBrannockPatients, getPatientMetadata } from '@/services/brannock';
import { cn } from '@/utils/classes';
import { useQuery } from '@tanstack/react-query';
import { type FC, type KeyboardEvent, useMemo, useState } from 'react';

// ── Simple token-set similarity (mirrors fuzzywuzzy.fuzz.token_set_ratio) ──
function tokenSetRatio(query: string, target: string): number {
  const qTokens = new Set(query.toLowerCase().split(/\s+/).filter(Boolean));
  const tTokens = new Set(target.toLowerCase().split(/\s+/).filter(Boolean));
  if (qTokens.size === 0) return 0;
  let matches = 0;
  for (const qt of qTokens) {
    for (const tt of tTokens) {
      if (tt.includes(qt) || qt.includes(tt)) {
        matches++;
        break;
      }
    }
  }
  return Math.round((matches / qTokens.size) * 100);
}

// ── Patient filtering logic (mirrors legacy SelectPatientsWidget.get_patient_names) ──
function filterAndSortPatients(
  patients: Array<BrannockPatient>,
  metadata: PatientMetadata | undefined,
  filters: { showDemo: boolean; requiresTemplate: boolean; singleFoot: boolean; hasSingleFootScan: boolean },
  searchText: string
): Array<BrannockPatient> {
  let filtered = patients;

  if (!filters.showDemo) {
    filtered = filtered.filter((patient) => {
      const affiliations = patient.affiliations.filter((a): a is string => a !== null).map((a) => a.toLowerCase());
      return !affiliations.includes('p04') && !affiliations.includes('demo');
    });
  }

  if (filters.requiresTemplate && metadata) {
    filtered = filtered.filter((patient) => (metadata.number_of_scans_for_patients_without_templates[patient.patient_id] ?? 0) >= 4);
  }

  if (filters.singleFoot && metadata) {
    filtered = filtered.filter((patient) => (metadata.number_of_single_foot_scans_for_single_foot_patients[patient.patient_id] ?? 0) > 0);
  }

  if (filters.hasSingleFootScan && metadata) {
    filtered = filtered.filter((patient) => (metadata.number_of_single_foot_scans_for_two_feet_patients[patient.patient_id] ?? 0) > 0);
  }

  if (searchText.trim() === '') {
    filtered = [...filtered].sort((a, b) => a.last_name.localeCompare(b.last_name));
  } else {
    filtered = [...filtered].sort((a, b) => {
      const nameA = `${a.first_name} ${a.last_name}`;
      const nameB = `${b.first_name} ${b.last_name}`;
      return tokenSetRatio(searchText, nameB) - tokenSetRatio(searchText, nameA);
    });
  }

  return filtered.slice(0, 10);
}

// ── Loading skeleton ──
function PatientListSkeleton() {
  return (
    <div className="flex flex-col">
      {Array.from({ length: 4 }).map((_, i) => (
        <div key={i} className="border-b border-gray-100 px-3 py-2.5 last:border-b-0">
          <div className="h-4 w-3/4 animate-pulse rounded bg-gray-200" />
        </div>
      ))}
    </div>
  );
}

interface PatientSelectorProps {
  selectedPatientId: string | undefined;
  onPatientChange: (patient: BrannockPatient | null) => void;
}

export const PatientSelector: FC<PatientSelectorProps> = ({ selectedPatientId, onPatientChange }) => {
  const [searchText, setSearchText] = useState('');
  const [showDemo, setShowDemo] = useState(false);
  const [requiresTemplate, setRequiresTemplate] = useState(false);
  const [singleFoot, setSingleFoot] = useState(false);
  const [hasSingleFootScan, setHasSingleFootScan] = useState(false);

  const {
    data: patients = [],
    isLoading: patientsLoading,
    isError: patientsError
  } = useQuery({
    queryKey: ['brannock-patients'],
    queryFn: getBrannockPatients
  });

  const { data: metadata } = useQuery({
    queryKey: ['brannock-metadata'],
    queryFn: getPatientMetadata
  });

  const filteredPatients = useMemo(
    () => filterAndSortPatients(patients, metadata, { showDemo, requiresTemplate, singleFoot, hasSingleFootScan }, searchText),
    [patients, metadata, showDemo, requiresTemplate, singleFoot, hasSingleFootScan, searchText]
  );

  const handlePatientClick = (patient: BrannockPatient) => {
    onPatientChange(patient.patient_id === selectedPatientId ? null : patient);
  };

  const handleKeyDown = (e: KeyboardEvent, patient: BrannockPatient) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      handlePatientClick(patient);
    }
  };

  return (
    <div className="rounded-lg bg-white p-4 shadow-sm">
      <h3 className="text-lg font-semibold text-black">Select Patient</h3>

      {/* Filter checkboxes */}
      <div className="mt-3 flex flex-col gap-1.5">
        <label className="flex cursor-pointer items-center gap-2 text-sm text-gray-700">
          <input type="checkbox" checked={showDemo} onChange={(e) => setShowDemo(e.target.checked)} className="accent-gray-900" />
          Show Demo Patients
        </label>
        <label className="flex cursor-pointer items-center gap-2 text-sm text-gray-700">
          <input type="checkbox" checked={requiresTemplate} onChange={(e) => setRequiresTemplate(e.target.checked)} className="accent-gray-900" />
          Requires Template
        </label>
        <label className="flex cursor-pointer items-center gap-2 text-sm text-gray-700">
          <input type="checkbox" checked={singleFoot} onChange={(e) => setSingleFoot(e.target.checked)} className="accent-gray-900" />
          Single Foot Patients
        </label>
        <label className="flex cursor-pointer items-center gap-2 text-sm text-gray-700">
          <input type="checkbox" checked={hasSingleFootScan} onChange={(e) => setHasSingleFootScan(e.target.checked)} className="accent-gray-900" />
          Has Single Foot Scan
        </label>
      </div>

      {/* Search input */}
      <input
        type="text"
        value={searchText}
        onChange={(e) => setSearchText(e.target.value)}
        placeholder="Search patients..."
        className="mt-3 w-full rounded-md border border-gray-300 px-3 py-1.5 text-sm text-black placeholder-gray-400 focus:border-gray-500 focus:outline-none"
      />

      {/* Patient list */}
      <div className="mt-2 max-h-[260px] overflow-y-auto rounded-md border border-gray-200" role="listbox" aria-label="Patient list">
        {patientsLoading ? (
          <PatientListSkeleton />
        ) : patientsError ? (
          <div className="px-3 py-4 text-center text-sm text-red-500">Failed to load patients. Check your connection and try again.</div>
        ) : filteredPatients.length === 0 ? (
          <div className="px-3 py-4 text-center text-sm text-gray-400">No patients match filters</div>
        ) : (
          filteredPatients.map((patient) => {
            const isSelected = patient.patient_id === selectedPatientId;
            return (
              <div
                key={patient.patient_id}
                role="option"
                aria-selected={isSelected}
                tabIndex={0}
                onClick={() => handlePatientClick(patient)}
                onKeyDown={(e) => handleKeyDown(e, patient)}
                className={cn(
                  'cursor-pointer border-b border-gray-100 px-3 py-2 text-sm last:border-b-0 focus:outline-none focus:ring-2 focus:ring-inset focus:ring-blue-400',
                  isSelected ? 'bg-gray-900 text-white' : 'text-gray-800 hover:bg-gray-50'
                )}
              >
                <span className="font-medium">
                  {patient.first_name} {patient.last_name}
                </span>
                {metadata && metadata.number_of_scans_for_patients_without_templates[patient.patient_id] !== undefined && (
                  <span className={cn('ml-2 text-xs', isSelected ? 'text-gray-300' : 'text-gray-400')}>
                    ({metadata.number_of_scans_for_patients_without_templates[patient.patient_id]} scans, no template)
                  </span>
                )}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
};
