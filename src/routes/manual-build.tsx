import { BuildControls } from '@/components/brannock/BuildControls';
import { FootSideControls } from '@/components/brannock/FootSideControls';
import { KeypointSelector } from '@/components/brannock/KeypointSelector';
import { PatientSelector } from '@/components/brannock/PatientSelector';
import { SaveTemplateButton } from '@/components/brannock/SaveTemplateButton';
import { ScanSelector } from '@/components/brannock/ScanSelector';
import { TemplateCanvas } from '@/components/brannock/TemplateCanvas';
import { ThresholdSliders } from '@/components/brannock/ThresholdSliders';
import type { BrannockPatient, BrannockScan, KeypointLocation, KeypointName, TemplateBuildResponse, TemplateMode } from '@/schemas/brannock';
import { KEYPOINT_NAMES } from '@/schemas/brannock';
import { getLogoutRedirectOptions } from '@/services/auth';
import { buildTemplate } from '@/services/brannock';
import { ENV, STORAGE_KEYS } from '@/utils/constants';
import { useMutation } from '@tanstack/react-query';
import { createFileRoute, redirect, useNavigate } from '@tanstack/react-router';
import { useCallback, useState } from 'react';
import toast from 'react-hot-toast';
import { z } from 'zod';

const BrannockSearchSchema = z.object({
  patientId: z.string().optional()
});

export const Route = createFileRoute('/manual-build')({
  validateSearch: BrannockSearchSchema.parse,
  beforeLoad: async ({ location }) => {
    const authToken = localStorage.getItem(STORAGE_KEYS.PODI_TOKEN);
    if (!authToken && ENV.ENV !== 'LOCAL') {
      throw redirect(getLogoutRedirectOptions(location));
    }
  },
  component: BrannockPage
});

// ── Empty keypoints initializer ──
function createEmptyKeypoints(): Record<KeypointName, KeypointLocation> {
  const kps = {} as Record<KeypointName, KeypointLocation>;
  for (const name of KEYPOINT_NAMES) {
    kps[name] = { left_normalized_coordinate: null, right_normalized_coordinate: null };
  }
  return kps;
}

function BrannockPage() {
  const { patientId } = Route.useSearch();
  const navigate = useNavigate();

  // ── Patient state ──────────────────────────────────────────
  const [selectedPatient, setSelectedPatient] = useState<BrannockPatient | null>(null);

  // ── Scan state ─────────────────────────────────────────────
  const [selectedScanIds, setSelectedScanIds] = useState<Set<string>>(new Set());
  const [previewScan, setPreviewScan] = useState<BrannockScan | null>(null);

  // ── Build state ────────────────────────────────────────────
  const [templateMode, setTemplateMode] = useState<TemplateMode | null>(null);
  const [buildResult, setBuildResult] = useState<TemplateBuildResponse | null>(null);
  const [leftTemplate, setLeftTemplate] = useState<Array<Array<number>> | null>(null);
  const [rightTemplate, setRightTemplate] = useState<Array<Array<number>> | null>(null);
  const [footSide, setFootSide] = useState<number | null>(null);
  const [leftThreshold, setLeftThreshold] = useState(0.4);
  const [rightThreshold, setRightThreshold] = useState(0.4);

  // ── Keypoint state ─────────────────────────────────────────
  const [keypoints, setKeypoints] = useState<Record<KeypointName, KeypointLocation>>(createEmptyKeypoints);
  const [activeKeypoint, setActiveKeypoint] = useState<KeypointName>('Hallux');

  // ── Build mutation ─────────────────────────────────────────
  const buildMutation = useMutation({
    mutationFn: buildTemplate,
    onSuccess: (result: TemplateBuildResponse) => {
      setBuildResult(result);
      setLeftTemplate(result.left_foot);
      setRightTemplate(result.right_foot);
      setFootSide(result.foot_side);
      setLeftThreshold(result.left_threshold);
      setRightThreshold(result.right_threshold);
      setKeypoints(createEmptyKeypoints());
      setActiveKeypoint('Hallux');
      toast.success('Template built successfully');
    },
    onError: () => {
      toast.error('Failed to build template');
    }
  });

  // ── Derived state ──────────────────────────────────────────
  const footConfig: 'bilateral' | 'left_only' | 'right_only' =
    leftTemplate && rightTemplate ? 'bilateral' : leftTemplate ? 'left_only' : rightTemplate ? 'right_only' : 'bilateral';

  const hasTemplate = leftTemplate !== null || rightTemplate !== null;
  const showFootSideControls = hasTemplate && footSide !== null && templateMode === 'auto';
  const showThresholdSliders = hasTemplate && templateMode === 'manual';

  // ── Handlers ───────────────────────────────────────────────
  const clearBuildState = useCallback(() => {
    setTemplateMode(null);
    setBuildResult(null);
    setLeftTemplate(null);
    setRightTemplate(null);
    setFootSide(null);
    setLeftThreshold(0.4);
    setRightThreshold(0.4);
    setKeypoints(createEmptyKeypoints());
    setActiveKeypoint('Hallux');
  }, []);

  const handlePatientChange = useCallback(
    (patient: BrannockPatient | null) => {
      setSelectedPatient(patient);
      setSelectedScanIds(new Set());
      setPreviewScan(null);
      clearBuildState();
      navigate({ search: (prev) => ({ ...prev, patientId: patient?.patient_id }) });
    },
    [navigate, clearBuildState]
  );

  const handlePreviewScanChange = useCallback((scan: BrannockScan | null) => {
    setPreviewScan(scan);
  }, []);

  const handleAutoBuild = useCallback(() => {
    if (!selectedPatient) return;
    setTemplateMode('auto');
    clearBuildState();
    const scanIds = selectedScanIds.size > 0 ? Array.from(selectedScanIds) : [];
    buildMutation.mutate({ patient_id: selectedPatient.patient_id, scan_ids: scanIds, mode: 'auto' });
  }, [selectedPatient, selectedScanIds, buildMutation, clearBuildState]);

  const handleManualBuild = useCallback(() => {
    if (!selectedPatient || selectedScanIds.size < 4) return;
    setTemplateMode('manual');
    clearBuildState();
    buildMutation.mutate({ patient_id: selectedPatient.patient_id, scan_ids: Array.from(selectedScanIds), mode: 'manual' });
  }, [selectedPatient, selectedScanIds, buildMutation, clearBuildState]);

  const handleKeypointPlace = useCallback(
    (side: 'left' | 'right', coordinate: { x: number; y: number }) => {
      setKeypoints((prev) => {
        const updated = { ...prev };
        const current = { ...updated[activeKeypoint] };
        if (side === 'left') {
          current.left_normalized_coordinate = coordinate;
        } else {
          current.right_normalized_coordinate = coordinate;
        }
        updated[activeKeypoint] = current;
        return updated;
      });

      // Auto-advance to the next unplaced keypoint
      const currentIdx = KEYPOINT_NAMES.indexOf(activeKeypoint);
      for (let offset = 1; offset <= KEYPOINT_NAMES.length; offset++) {
        const nextIdx = (currentIdx + offset) % KEYPOINT_NAMES.length;
        const nextName = KEYPOINT_NAMES[nextIdx];
        const nextKp = keypoints[nextName];
        const needsLeft = (footConfig === 'bilateral' || footConfig === 'left_only') && !nextKp.left_normalized_coordinate;
        const needsRight = (footConfig === 'bilateral' || footConfig === 'right_only') && !nextKp.right_normalized_coordinate;
        if (needsLeft || needsRight) {
          setActiveKeypoint(nextName);
          break;
        }
      }
    },
    [activeKeypoint, keypoints, footConfig]
  );

  const handleChangeFootSide = useCallback(() => {
    if (footSide === null) return;
    const newSide = footSide === 1 ? 0 : 1;
    setFootSide(newSide);
    const activeTemplate = leftTemplate ?? rightTemplate;
    if (newSide === 1) {
      setLeftTemplate(activeTemplate);
      setRightTemplate(null);
    } else {
      setRightTemplate(activeTemplate);
      setLeftTemplate(null);
    }
    setKeypoints(createEmptyKeypoints());
  }, [footSide, leftTemplate, rightTemplate]);

  const handleRotate = useCallback(() => {
    const rotate180 = (arr: Array<Array<number>>): Array<Array<number>> => arr.slice().reverse().map((row) => row.slice().reverse());
    if (footSide === 1 && leftTemplate) {
      setLeftTemplate(rotate180(leftTemplate));
    } else if (footSide === 0 && rightTemplate) {
      setRightTemplate(rotate180(rightTemplate));
    }
    setKeypoints(createEmptyKeypoints());
  }, [footSide, leftTemplate, rightTemplate]);

  const handleSaveSuccess = useCallback(() => {
    clearBuildState();
  }, [clearBuildState]);

  return (
    <div className="flex flex-col gap-6 p-4 lg:flex-row lg:p-6">
      {/* Left column */}
      <div className="flex w-full shrink-0 flex-col gap-4 lg:w-[400px]">
        <PatientSelector selectedPatientId={patientId ?? selectedPatient?.patient_id} onPatientChange={handlePatientChange} />

        <ScanSelector
          patient={selectedPatient}
          selectedScanIds={selectedScanIds}
          onSelectedScanIdsChange={setSelectedScanIds}
          previewScanId={previewScan?.scan_id ?? null}
          onPreviewScanChange={handlePreviewScanChange}
        />

        {/* MatThermogramPreview placeholder */}
        <div className="rounded-lg bg-white p-4 shadow-sm">
          <h3 className="text-lg font-semibold text-black">Mat Thermogram</h3>
          <div className="mt-2 flex h-[200px] items-center justify-center rounded bg-gray-50">
            {previewScan ? (
              <p className="text-sm text-gray-500">Preview for scan {previewScan.when_scan_completed.slice(0, 16).replace('T', ' ')}</p>
            ) : (
              <p className="text-sm text-gray-400">Click a scan to preview its thermogram</p>
            )}
          </div>
        </div>
      </div>

      {/* Right column */}
      <div className="flex flex-1 flex-col gap-4">
        <BuildControls
          onAutoBuild={handleAutoBuild}
          onManualBuild={handleManualBuild}
          isBuilding={buildMutation.isPending}
          canAutoBuild={!!selectedPatient && !buildMutation.isPending}
          canManualBuild={selectedScanIds.size >= 4 && !buildMutation.isPending}
          checkedScanCount={selectedScanIds.size}
        />

        {/* Foot Templates */}
        <div className="rounded-lg bg-white p-4 shadow-sm">
          <h3 className="text-lg font-semibold text-black">Foot Templates</h3>
          {hasTemplate ? (
            <div className="mt-2 flex gap-4">
              {/* Right foot on left side, left foot on right side (anatomical convention) */}
              <TemplateCanvas
                templateData={rightTemplate}
                side="right"
                enabled={rightTemplate !== null}
                activeKeypoint={activeKeypoint}
                keypoints={keypoints}
                keypointNames={KEYPOINT_NAMES}
                threshold={rightThreshold}
                onKeypointPlace={handleKeypointPlace}
              />
              <TemplateCanvas
                templateData={leftTemplate}
                side="left"
                enabled={leftTemplate !== null}
                activeKeypoint={activeKeypoint}
                keypoints={keypoints}
                keypointNames={KEYPOINT_NAMES}
                threshold={leftThreshold}
                onKeypointPlace={handleKeypointPlace}
              />
            </div>
          ) : (
            <div className="mt-2 flex h-[300px] items-center justify-center rounded bg-gray-50">
              <p className="text-sm text-gray-400">Build a template to see foot visualizations</p>
            </div>
          )}
        </div>

        {/* Foot side controls — single-foot auto templates only */}
        {showFootSideControls && <FootSideControls footSide={footSide!} onChangeFootSide={handleChangeFootSide} onRotate={handleRotate} />}

        {/* Threshold sliders — manual mode only */}
        {showThresholdSliders && (
          <ThresholdSliders
            leftThreshold={leftThreshold}
            rightThreshold={rightThreshold}
            onLeftChange={setLeftThreshold}
            onRightChange={setRightThreshold}
            showLeft={leftTemplate !== null}
            showRight={rightTemplate !== null}
          />
        )}

        {/* Keypoints — only shown after a template is built */}
        {hasTemplate && (
          <KeypointSelector activeKeypoint={activeKeypoint} keypoints={keypoints} onActiveKeypointChange={setActiveKeypoint} footConfig={footConfig} />
        )}

        {/* Save Template */}
        <SaveTemplateButton
          patientId={selectedPatient?.patient_id}
          leftTemplate={leftTemplate}
          rightTemplate={rightTemplate}
          leftThreshold={leftThreshold}
          rightThreshold={rightThreshold}
          keypoints={keypoints}
          footConfig={footConfig}
          earliestScanId={buildResult?.earliest_scan_id}
          dateCreated={buildResult?.date_created}
          hasTemplate={hasTemplate}
          onSaveSuccess={handleSaveSuccess}
        />
      </div>
    </div>
  );
}
