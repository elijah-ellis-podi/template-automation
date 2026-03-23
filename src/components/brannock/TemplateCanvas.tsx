import type { KeypointLocation, KeypointName } from '@/schemas/brannock';
import { cn } from '@/utils/classes';
import { type FC, useCallback, useEffect, useRef } from 'react';

// ── Copper-like color palette (warm tones matching legacy colormaps.copper) ──
function temperatureToRgba(value: number, min: number, max: number, threshold: number): [number, number, number, number] {
  if (value < threshold) return [0, 0, 0, 0];

  const t = max > min ? (value - min) / (max - min) : 0;
  // Copper palette approximation: black → copper → bright orange/white
  const r = Math.min(255, Math.round(t * 1.3 * 255));
  const g = Math.min(255, Math.round(t * 0.78 * 255));
  const b = Math.min(255, Math.round(t * 0.5 * 255));
  return [r, g, b, 255];
}

// ── Draw all keypoint markers on the overlay canvas ──
function drawKeypoints(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  side: 'left' | 'right',
  keypoints: Record<string, KeypointLocation>,
  activeKeypoint: KeypointName | null,
  keypointNames: ReadonlyArray<string>
) {
  ctx.clearRect(0, 0, width, height);

  for (const name of keypointNames) {
    const kp = keypoints[name];
    if (!kp) continue;

    const coord = side === 'left' ? kp.left_normalized_coordinate : kp.right_normalized_coordinate;
    if (!coord) continue;

    const x = coord.x * width;
    const y = coord.y * height;
    const isActive = name === activeKeypoint;

    // Outer ring
    ctx.beginPath();
    ctx.arc(x, y, isActive ? 7 : 5, 0, Math.PI * 2);
    ctx.fillStyle = isActive ? '#0B77FB' : '#000000';
    ctx.fill();

    // Inner dot
    ctx.beginPath();
    ctx.arc(x, y, 2, 0, Math.PI * 2);
    ctx.fillStyle = '#ffffff';
    ctx.fill();
  }
}

interface TemplateCanvasProps {
  templateData: Array<Array<number>> | null;
  side: 'left' | 'right';
  enabled: boolean;
  activeKeypoint: KeypointName | null;
  keypoints: Record<string, KeypointLocation>;
  keypointNames: ReadonlyArray<string>;
  threshold: number;
  onKeypointPlace: (side: 'left' | 'right', coordinate: { x: number; y: number }) => void;
}

export const TemplateCanvas: FC<TemplateCanvasProps> = ({ templateData, side, enabled, activeKeypoint, keypoints, keypointNames, threshold, onKeypointPlace }) => {
  const heatmapRef = useRef<HTMLCanvasElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);

  // ── Render heatmap when template data or threshold changes ──
  useEffect(() => {
    const canvas = heatmapRef.current;
    if (!canvas || !templateData || templateData.length === 0) return;

    const rows = templateData.length;
    const cols = templateData[0].length;
    canvas.width = cols;
    canvas.height = rows;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // Find min/max excluding zeros
    let min = Infinity;
    let max = -Infinity;
    for (const row of templateData) {
      for (const val of row) {
        if (val > 0) {
          if (val < min) min = val;
          if (val > max) max = val;
        }
      }
    }
    if (min === Infinity) {
      min = 0;
      max = 1;
    }

    const imageData = ctx.createImageData(cols, rows);
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const idx = (r * cols + c) * 4;
        const [red, green, blue, alpha] = temperatureToRgba(templateData[r][c], min, max, threshold);
        imageData.data[idx] = red;
        imageData.data[idx + 1] = green;
        imageData.data[idx + 2] = blue;
        imageData.data[idx + 3] = alpha;
      }
    }
    ctx.putImageData(imageData, 0, 0);
  }, [templateData, threshold]);

  // ── Redraw keypoint overlay when keypoints or active keypoint changes ──
  useEffect(() => {
    const canvas = overlayRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    drawKeypoints(ctx, canvas.width, canvas.height, side, keypoints, activeKeypoint, keypointNames);
  }, [keypoints, activeKeypoint, side, keypointNames]);

  // ── Sync overlay canvas size with container ──
  useEffect(() => {
    const canvas = overlayRef.current;
    const heatmap = heatmapRef.current;
    if (!canvas || !heatmap) return;

    const resizeObserver = new ResizeObserver(() => {
      const rect = heatmap.getBoundingClientRect();
      canvas.width = rect.width;
      canvas.height = rect.height;
      const ctx = canvas.getContext('2d');
      if (ctx) {
        drawKeypoints(ctx, rect.width, rect.height, side, keypoints, activeKeypoint, keypointNames);
      }
    });
    resizeObserver.observe(heatmap);
    return () => resizeObserver.disconnect();
  }, [side, keypoints, activeKeypoint, keypointNames]);

  // ── Click handler: compute normalized coords and fire callback ──
  const handleClick = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      if (!enabled || !activeKeypoint) return;
      const rect = e.currentTarget.getBoundingClientRect();
      const x = (e.clientX - rect.left) / rect.width;
      const y = (e.clientY - rect.top) / rect.height;
      onKeypointPlace(side, { x, y });
    },
    [enabled, activeKeypoint, side, onKeypointPlace]
  );

  if (!templateData) return null;

  return (
    <div className="relative flex-1">
      <div className="mb-1 text-center text-xs font-medium text-gray-500">{side === 'left' ? 'Left Foot' : 'Right Foot'}</div>
      <div className="relative">
        {/* Heatmap layer */}
        <canvas
          ref={heatmapRef}
          className="h-auto w-full rounded"
          style={{ imageRendering: 'pixelated' }}
        />
        {/* Click overlay layer */}
        <canvas
          ref={overlayRef}
          onClick={handleClick}
          className={cn('absolute top-0 left-0 h-full w-full rounded', enabled && activeKeypoint ? 'cursor-crosshair' : 'cursor-default')}
        />
      </div>
    </div>
  );
};
