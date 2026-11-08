export const MIN_WINDOW_WIDTH = 400;
export const MIN_WINDOW_HEIGHT = 540;

const MAX_WINDOW_WIDTH = 480;
const MAX_WINDOW_HEIGHT = 680;
const WORK_AREA_MARGIN = 80;

export interface WorkAreaSize {
  width: number;
  height: number;
}

export function fitWindowToWorkArea(workArea: WorkAreaSize): WorkAreaSize {
  return {
    width: Math.min(
      MAX_WINDOW_WIDTH,
      Math.max(MIN_WINDOW_WIDTH, workArea.width - WORK_AREA_MARGIN),
    ),
    height: Math.min(
      MAX_WINDOW_HEIGHT,
      Math.max(MIN_WINDOW_HEIGHT, workArea.height - WORK_AREA_MARGIN),
    ),
  };
}
