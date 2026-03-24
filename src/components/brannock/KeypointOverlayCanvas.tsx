import { KEYPOINT_NAMES } from '@/schemas/brannock';
import { cn } from '@/utils/classes';
import { type FC, useEffect, useRef } from 'react';

export interface KeypointResult {
  name: string;
  left?: { x: number; y: number } | null;
  right?: { x: number; y: number } | null;
  leftConfidence?: number | null;
  rightConfidence?: number | null;
}

// ── Color palette for keypoint markers ──
const KEYPOINT_COLORS: Record<string, string> = {
  Hallux: '#ef4444',
  '1st Metatarsal Head': '#f97316',
  '3rd Metatarsal Head': '#eab308',
  '5th Metatarsal Head': '#22c55e',
  Arch: '#3b82f6',
  Heel: '#a855f7'
};

interface KeypointOverlayCanvasProps {
  thermogramData: Array<Array<number>>;
  keypoints: Array<KeypointResult>;
  /** Ground truth keypoints — rendered as O markers for comparison */
  groundTruth?: Array<KeypointResult>;
  className?: string;
  /** 'thermogram' = copper heatmap (default), 'template' = binary foot mask */
  renderMode?: 'thermogram' | 'template';
  /**
   * How to map normalized keypoint coords to canvas pixels.
   * 'bilateral' (default): image shows both feet side-by-side. Left foot coords
   *   map to the right half, right foot coords map to the left half.
   * 'single': image shows one foot. Coords map directly (x*w, y*h).
   */
  coordMode?: 'bilateral' | 'single';
}

// ── Copper palette (for raw thermograms) ──
function temperatureToRgba(value: number, min: number, max: number): [number, number, number, number] {
  if (value <= 0) return [0, 0, 0, 0];
  const t = max > min ? (value - min) / (max - min) : 0;
  const r = Math.min(255, Math.round(t * 1.3 * 255));
  const g = Math.min(255, Math.round(t * 0.78 * 255));
  const b = Math.min(255, Math.round(t * 0.5 * 255));
  return [r, g, b, 255];
}

// ── Template palette (for boolean/smooth foot masks) ──
function templateToRgba(value: number, max: number): [number, number, number, number] {
  if (value <= 0 || max <= 0) return [0, 0, 0, 255];
  const t = Math.min(1, value / max);
  if (t < 0.15) return [15, 15, 20, 255];
  const intensity = 0.6 + t * 0.4;
  return [
    Math.round(200 * intensity),
    Math.round(210 * intensity),
    Math.round(230 * intensity),
    255
  ];
}

export const KeypointOverlayCanvas: FC<KeypointOverlayCanvasProps> = ({ thermogramData, keypoints, groundTruth, className, renderMode = 'thermogram', coordMode = 'bilateral' }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || thermogramData.length === 0) return;

    const rows = thermogramData.length;
    const cols = thermogramData[0].length;

    const scale = 2;
    canvas.width = cols * scale;
    canvas.height = rows * scale;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // ── Draw thermogram ──
    const tmpCanvas = document.createElement('canvas');
    tmpCanvas.width = cols;
    tmpCanvas.height = rows;
    const tmpCtx = tmpCanvas.getContext('2d')!;

    let min = Infinity;
    let max = -Infinity;
    for (const row of thermogramData) {
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

    const imageData = tmpCtx.createImageData(cols, rows);
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const idx = (r * cols + c) * 4;
        const [red, green, blue, alpha] = renderMode === 'template'
          ? templateToRgba(thermogramData[r][c], max)
          : temperatureToRgba(thermogramData[r][c], min, max);
        imageData.data[idx] = red;
        imageData.data[idx + 1] = green;
        imageData.data[idx + 2] = blue;
        imageData.data[idx + 3] = alpha;
      }
    }
    tmpCtx.putImageData(imageData, 0, 0);

    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(tmpCanvas, 0, 0, cols * scale, rows * scale);

    // ── Draw keypoint markers ──
    const w = cols * scale;
    const h = rows * scale;

    // Coordinate mapping: bilateral (full mat, two feet) vs single (one foot per canvas)
    const mapCoord = (coord: { x: number; y: number }, side: 'left' | 'right'): { px: number; py: number } => {
      if (coordMode === 'single') {
        // Single foot: normalized coords map directly to canvas
        return { px: coord.x * w, py: coord.y * h };
      }
      // Bilateral: left foot in right half, right foot in left half
      if (side === 'left') {
        return { px: (0.5 + coord.x * 0.5) * w, py: coord.y * h };
      }
      return { px: coord.x * 0.5 * w, py: coord.y * h };
    };

    // Ground truth first (O markers, behind model markers)
    if (groundTruth) {
      for (const kp of groundTruth) {
        const color = KEYPOINT_COLORS[kp.name] || '#ffffff';
        if (kp.left) {
          const { px, py } = mapCoord(kp.left, 'left');
          drawCircleMarker(ctx, px, py, color, scale);
        }
        if (kp.right) {
          const { px, py } = mapCoord(kp.right, 'right');
          drawCircleMarker(ctx, px, py, color, scale);
        }
      }
    }

    // Model predictions (X markers, on top)
    for (const kp of keypoints) {
      const color = KEYPOINT_COLORS[kp.name] || '#ffffff';
      if (kp.left) {
        const { px, py } = mapCoord(kp.left, 'left');
        drawXMarker(ctx, px, py, color, scale);
      }
      if (kp.right) {
        const { px, py } = mapCoord(kp.right, 'right');
        drawXMarker(ctx, px, py, color, scale);
      }
    }
  }, [thermogramData, keypoints, groundTruth, renderMode]);

  return <canvas ref={canvasRef} className={cn('h-auto w-full rounded', className)} />;
};

// ── X marker (model predictions) ──
function drawXMarker(ctx: CanvasRenderingContext2D, x: number, y: number, color: string, scale: number) {
  const size = 2 * scale;
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.2 * scale;

  // Draw X
  ctx.beginPath();
  ctx.moveTo(x - size, y - size);
  ctx.lineTo(x + size, y + size);
  ctx.moveTo(x + size, y - size);
  ctx.lineTo(x - size, y + size);
  ctx.stroke();
}

// ── O marker (ground truth) ──
function drawCircleMarker(ctx: CanvasRenderingContext2D, x: number, y: number, color: string, scale: number) {
  const radius = 2 * scale;
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.2 * scale;

  // Draw O
  ctx.beginPath();
  ctx.arc(x, y, radius, 0, Math.PI * 2);
  ctx.stroke();
}

// ── Legend component ──
export const KeypointLegend: FC<{ showGroundTruth?: boolean }> = ({ showGroundTruth }) => (
  <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
    {KEYPOINT_NAMES.map((name) => (
      <div key={name} className="flex items-center gap-1.5 text-xs text-gray-600">
        <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ backgroundColor: KEYPOINT_COLORS[name] }} />
        {name}
      </div>
    ))}
    {showGroundTruth && (
      <>
        <span className="text-xs text-gray-300">|</span>
        <span className="text-xs text-gray-500">X = model</span>
        <span className="text-xs text-gray-500">O = ground truth</span>
      </>
    )}
  </div>
);
