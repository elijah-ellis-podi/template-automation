import { type FC, useEffect, useRef } from 'react';

// ── Copper palette: black → copper → bright orange ──
function temperatureToRgba(value: number, min: number, max: number): [number, number, number, number] {
  if (value <= 0) return [0, 0, 0, 0];
  const t = max > min ? (value - min) / (max - min) : 0;
  const r = Math.min(255, Math.round(t * 1.3 * 255));
  const g = Math.min(255, Math.round(t * 0.78 * 255));
  const b = Math.min(255, Math.round(t * 0.5 * 255));
  return [r, g, b, 255];
}

interface ThermogramHeatmapProps {
  data: Array<Array<number>>;
  className?: string;
}

export const ThermogramHeatmap: FC<ThermogramHeatmapProps> = ({ data, className }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || data.length === 0) return;

    const rows = data.length;
    const cols = data[0].length;
    canvas.width = cols;
    canvas.height = rows;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let min = Infinity;
    let max = -Infinity;
    for (const row of data) {
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
        const [red, green, blue, alpha] = temperatureToRgba(data[r][c], min, max);
        imageData.data[idx] = red;
        imageData.data[idx + 1] = green;
        imageData.data[idx + 2] = blue;
        imageData.data[idx + 3] = alpha;
      }
    }
    ctx.putImageData(imageData, 0, 0);
  }, [data]);

  return <canvas ref={canvasRef} className={className} style={{ imageRendering: 'pixelated' }} />;
};
