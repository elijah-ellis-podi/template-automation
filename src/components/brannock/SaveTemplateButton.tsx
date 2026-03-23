import type { KeypointLocation, KeypointName, TemplateSavePayload } from '@/schemas/brannock';
import { KEYPOINT_NAMES } from '@/schemas/brannock';
import { saveTemplate } from '@/services/brannock';
import { cn } from '@/utils/classes';
import { useMutation } from '@tanstack/react-query';
import { type FC, useCallback, useMemo } from 'react';
import toast from 'react-hot-toast';

type FootConfig = 'bilateral' | 'left_only' | 'right_only';

// ── Coordinate transforms for save ──────────────────────────
// Flip Y: canvas 0,0 is top-left, template expects 0,0 at bottom-left
function flipY(coord: { x: number; y: number }): { x: number; y: number } {
  return { x: coord.x, y: 1 - coord.y };
}

// Flip template horizontally (equivalent to numpy.fliplr)
function flipLR(arr: Array<Array<number>>): Array<Array<number>> {
  return arr.map((row) => row.slice().reverse());
}

// ── Validation ──────────────────────────────────────────────
function isKeypointPlaced(kp: KeypointLocation, footConfig: FootConfig): boolean {
  switch (footConfig) {
    case 'bilateral':
      return kp.left_normalized_coordinate !== null && kp.right_normalized_coordinate !== null;
    case 'left_only':
      return kp.left_normalized_coordinate !== null;
    case 'right_only':
      return kp.right_normalized_coordinate !== null;
  }
}

function allKeypointsPlaced(keypoints: Record<KeypointName, KeypointLocation>, footConfig: FootConfig): boolean {
  return KEYPOINT_NAMES.every((name) => isKeypointPlaced(keypoints[name], footConfig));
}

// ── Build the { which, what } event payload ─────────────────
// Matches the legacy event shape uploaded to cloud storage:
//   { "which": "patient_template_defined", "what": { ... } }
function buildSavePayload(
  patientId: string,
  leftTemplate: Array<Array<number>> | null,
  rightTemplate: Array<Array<number>> | null,
  leftThreshold: number,
  rightThreshold: number,
  keypoints: Record<KeypointName, KeypointLocation>,
  footConfig: FootConfig,
  earliestScanId?: string,
  dateCreated?: string
): TemplateSavePayload {
  // Apply horizontal flip to templates (numpy.fliplr equivalent)
  const flippedLeft = leftTemplate ? flipLR(leftTemplate) : null;
  const flippedRight = rightTemplate ? flipLR(rightTemplate) : null;

  // Apply Y-coordinate flip to keypoints
  const transformedKeypoints: Record<string, KeypointLocation> = {};
  for (const name of KEYPOINT_NAMES) {
    const kp = keypoints[name];
    const transformed: KeypointLocation = {
      left_normalized_coordinate: null,
      right_normalized_coordinate: null
    };

    if (kp.left_normalized_coordinate && (footConfig === 'bilateral' || footConfig === 'left_only')) {
      transformed.left_normalized_coordinate = flipY(kp.left_normalized_coordinate);
    }
    if (kp.right_normalized_coordinate && (footConfig === 'bilateral' || footConfig === 'right_only')) {
      transformed.right_normalized_coordinate = flipY(kp.right_normalized_coordinate);
    }

    transformedKeypoints[name] = transformed;
  }

  // Build the "what" object — only include earliest_scan_id/date_created if present
  const what: TemplateSavePayload['what'] = {
    patient_id: patientId,
    left_foot: flippedLeft,
    right_foot: flippedRight,
    left_threshold: leftThreshold,
    right_threshold: rightThreshold,
    keypoints: transformedKeypoints
  };

  if (earliestScanId) {
    what.earliest_scan_id = earliestScanId;
  }
  if (dateCreated) {
    what.date_created = dateCreated;
  }

  return {
    which: 'patient_template_defined',
    what
  };
}

interface SaveTemplateButtonProps {
  patientId: string | undefined;
  leftTemplate: Array<Array<number>> | null;
  rightTemplate: Array<Array<number>> | null;
  leftThreshold: number;
  rightThreshold: number;
  keypoints: Record<KeypointName, KeypointLocation>;
  footConfig: FootConfig;
  earliestScanId?: string;
  dateCreated?: string;
  hasTemplate: boolean;
  onSaveSuccess: () => void;
}

export const SaveTemplateButton: FC<SaveTemplateButtonProps> = ({
  patientId,
  leftTemplate,
  rightTemplate,
  leftThreshold,
  rightThreshold,
  keypoints,
  footConfig,
  earliestScanId,
  dateCreated,
  hasTemplate,
  onSaveSuccess
}) => {
  const allPlaced = useMemo(() => allKeypointsPlaced(keypoints, footConfig), [keypoints, footConfig]);
  const canSave = hasTemplate && allPlaced && !!patientId;

  const saveMutation = useMutation({
    mutationFn: saveTemplate,
    onSuccess: () => {
      toast.success('Template saved successfully');
      onSaveSuccess();
    },
    onError: () => {
      toast.error('Failed to save template');
    }
  });

  const handleSave = useCallback(() => {
    if (!patientId) {
      toast.error('No patient selected');
      return;
    }
    if (!hasTemplate) {
      toast.error('No template built — build a template first');
      return;
    }
    if (!allPlaced) {
      toast.error('You must define keypoints for all locations before saving the template.');
      return;
    }

    const payload = buildSavePayload(patientId, leftTemplate, rightTemplate, leftThreshold, rightThreshold, keypoints, footConfig, earliestScanId, dateCreated);

    saveMutation.mutate(payload);
  }, [patientId, hasTemplate, allPlaced, leftTemplate, rightTemplate, leftThreshold, rightThreshold, keypoints, footConfig, earliestScanId, dateCreated, saveMutation]);

  return (
    <button
      onClick={handleSave}
      disabled={!canSave || saveMutation.isPending}
      className={cn(
        'w-full rounded-md px-4 py-2.5 text-sm font-medium transition-colors',
        canSave && !saveMutation.isPending ? 'cursor-pointer bg-gray-900 text-white hover:bg-gray-800' : 'cursor-not-allowed bg-gray-900 text-white opacity-50'
      )}
    >
      {saveMutation.isPending ? 'Saving...' : 'Save Template'}
    </button>
  );
};
