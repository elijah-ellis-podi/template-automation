import type { FC } from 'react';

interface BuildControlsProps {
  onAutoBuild: () => void;
  onManualBuild: () => void;
  isBuilding: boolean;
  canAutoBuild: boolean;
  canManualBuild: boolean;
  checkedScanCount: number;
}

export const BuildControls: FC<BuildControlsProps> = ({ onAutoBuild, onManualBuild, isBuilding, canAutoBuild, canManualBuild, checkedScanCount }) => {
  return (
    <div className="rounded-lg bg-white p-4 shadow-sm">
      <h3 className="mb-2 text-lg font-semibold text-black">Build Template</h3>

      {isBuilding ? (
        <div className="flex items-center gap-3 rounded-md bg-gray-50 px-4 py-3">
          <svg className="h-5 w-5 animate-spin text-gray-600" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
          </svg>
          <span className="text-sm text-gray-600">Building template... this may take a few seconds</span>
        </div>
      ) : (
        <div className="flex gap-2">
          <button
            onClick={onAutoBuild}
            disabled={!canAutoBuild}
            className="cursor-pointer rounded-md bg-gray-900 px-4 py-2 text-sm font-medium text-white disabled:cursor-not-allowed disabled:opacity-50"
          >
            Auto Build Template
          </button>
          <button
            onClick={onManualBuild}
            disabled={!canManualBuild}
            className="cursor-pointer rounded-md border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 disabled:cursor-not-allowed disabled:opacity-50"
          >
            Manual Build Template{checkedScanCount > 0 && checkedScanCount < 4 ? ` (${checkedScanCount}/4)` : ''}
          </button>
        </div>
      )}
    </div>
  );
};
